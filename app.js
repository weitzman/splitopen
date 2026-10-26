// Split Open — multi-stem player built on the Web Audio API.
// Each stem is served as short Opus segments (see scripts/segment-stems.py)
// that are fetched and decoded a little ahead of the playhead and started on
// the same AudioContext clock at their exact positions, so the stems stay
// sample-locked across segment boundaries; mute/solo/fader are just gain
// changes. Playback begins as soon as the segment under the playhead is
// decoded for every stem; decoded audio is kept within a memory budget.

// Fixed stem slots, in strip order; a band lists the ones it has (see
// stemsFor) and who plays each comes from bands.yaml per song.
const SLOTS = [
  { id: 'guitar', color: 'var(--trey)' },
  { id: 'bass',   color: 'var(--mike)' },
  { id: 'keys',   color: 'var(--page)' },
  { id: 'drums',  color: 'var(--fish)' },
  { id: 'vocals', color: 'var(--vox)' },
  { id: 'horns',  color: 'var(--horns)' },
  { id: 'flute',  color: 'var(--flute)' },
];
let STEMS = SLOTS;

// The stems are Opus, which always decodes at 48 kHz. Matching the context
// rate avoids resampling every stem on decode, which is roughly 3x slower
// than decoding alone.
//
// The latency hint sets the device buffer, and so how late the renderer may
// run before the output drops out. The default (interactive) buffer is
// 5 ms in Chrome on macOS, which a busy machine misses often enough to
// crackle; 50 ms rides out those stalls, and nothing here needs a quicker
// response than that: the faders only shape playback, there is no live
// input. Each browser rounds the hint to a buffer size it supports.
const STEM_RATE = 48000;
const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: STEM_RATE, latencyHint: 0.05 });

// The renderer works a device buffer at a time, so a start less than a
// buffer ahead of the clock can already be behind the renderer by the time
// the call reaches it, and the source starts late and off its grid. Every
// start is scheduled at least this far ahead, on top of the few ms the
// main thread itself takes.
const CLOCK_MARGIN = ctx.baseLatency || 0;
const master = ctx.createGain();
master.connect(ctx.destination);

// iOS Safari gives a tab on the order of 1 GB before killing it, and doesn't
// report deviceMemory. Treat touch devices that don't report memory as
// constrained: fewer segments decoded ahead of the playhead, and a smaller
// budget for decoded audio.
const LOW_MEMORY = !navigator.deviceMemory && navigator.maxTouchPoints > 1;

// iOS routes Web Audio through the "ambient" audio session, which obeys the
// ring/silent switch, so the graph runs but nothing comes out of the speaker.
// Media elements use the "playback" session instead. On iOS 17+ we can ask for
// that session directly; on older iOS, keeping a silent <audio> element playing
// alongside the graph has the same effect. The silent element also runs on
// iOS 17+, because the lock-screen and headphone controls (see the media
// session block below) only appear while a media element is playing; Web Audio
// alone never counts as "Now Playing".
if (navigator.audioSession) {
  try { navigator.audioSession.type = 'playback'; } catch (_) { /* unsupported value */ }
}

// 8 kHz 8-bit mono silence; 8 KB per second, so a 10-minute song is ~5 MB.
function silentWavUrl(seconds) {
  const rate = 8000, frames = rate * seconds;
  const buf = new ArrayBuffer(44 + frames);
  const v = new DataView(buf);
  const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + frames, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  str(36, 'data'); v.setUint32(40, frames, true);
  new Uint8Array(buf, 44).fill(0x80); // unsigned 8-bit silence
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

// Safari copies this element's currentTime into the Media Session position
// state whenever the element seeks, loops, or pauses, which is what the lock
// screen scrubber shows. So the silent file outlasts the song and the element's
// clock is kept on the song position: it starts at the current offset and
// follows every seek.
let keepalive = null;
let keepaliveSeconds = 0;
function keepaliveStart() {
  if (!keepalive) {
    keepalive = new Audio();
    keepalive.loop = true;
    keepalive.setAttribute('playsinline', '');
    mediaSessionWatchKeepalive(keepalive);
  }
  const seconds = Math.ceil(duration) + 5;
  if (keepaliveSeconds < seconds) {
    if (keepalive.src) URL.revokeObjectURL(keepalive.src);
    keepalive.src = silentWavUrl(seconds);
    keepaliveSeconds = seconds;
  }
  keepalive.currentTime = offset;
  keepalive.play().catch(() => { /* not allowed outside a gesture; harmless */ });
}
function keepaliveStop() {
  if (keepalive) keepalive.pause();
}
function keepaliveSeek(to) {
  if (keepalive && !keepalive.paused) keepalive.currentTime = to;
}

let songs = [];
let bands = {};
let song = null;
let band = null;
let channels = []; // { def, fader, muteGain, analyser, ui }
let playing = false;
let buffering = false; // Play is on but the segment under the playhead is not decoded yet
let startedAt = 0;   // ctx.currentTime when playback started
let offset = 0;      // position (s) at which playback started
let duration = 0;
let loadToken = 0;   // guards against a stale load finishing after a song switch

// ---------- loading ----------
//
// A song directory holds meta.json and, per stem, NNN.opus segments: segment
// N covers seconds [N*segment, (N+1)*segment), and every segment after the
// first starts `lead` seconds early so the decoder has settled by the time
// the audible part begins (the player skips the lead).
//
// Two caches per song. The compressed bytes of every segment fetched are
// kept while the song is loaded (~35 MB for an 8-minute song), and once the
// segments ahead of the playhead are in, the rest of the song is fetched in
// the background one segment at a time, so a seek costs at most a decode.
// Decoded PCM is ~19 MB per segment across the five stems, so it is kept
// under a budget: the segments ahead of the playhead always, and beyond them
// the most recently used, until the budget is met.

const AHEAD = LOW_MEMORY ? 3 : 6; // segments decoded ahead of the playhead
const DECODE_BUDGET = (LOW_MEMORY ? 192 : Math.min(2048, (navigator.deviceMemory || 2) * 256)) * 1024 * 1024;

let meta = null;         // the current song's meta.json
let bytes = new Map();   // segment index -> { promise: Promise<ArrayBuffer[]>, ctrl }
let decoded = new Map(); // segment index -> { promise: Promise<AudioBuffer[]>, result, size }; insertion order = LRU

function segName(k) { return String(k).padStart(3, '0') + '.opus'; }
function segIndex(t) { return Math.max(0, Math.min(meta.segments - 1, Math.floor(t / meta.segment))); }

// Bytes fetched ahead of need (other songs' first segments), keyed by URL.
// decodeAudioData detaches the buffer it is given, so an entry is handed
// over once; after that the URL is fetched again, from the HTTP cache.
const prefetched = new Map();

async function fetchBytes(url, { signal, priority = 'auto', onProgress } = {}) {
  if (prefetched.has(url)) {
    const p = prefetched.get(url);
    prefetched.delete(url);
    return p;
  }
  const res = await fetch(url, { signal, priority });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress) onProgress(total ? received / total : 0);
  }
  const bytes = new Uint8Array(received);
  let pos = 0;
  for (const c of chunks) { bytes.set(c, pos); pos += c.length; }
  return bytes.buffer;
}

const metaCache = new Map(); // song id -> Promise<meta>
function fetchMeta(s) {
  if (!metaCache.has(s.id)) {
    const p = fetch(s.dir + 'meta.json').then(r => {
      if (!r.ok) throw new Error(`${r.status} ${s.dir}meta.json`);
      return r.json();
    });
    p.catch(() => metaCache.delete(s.id));
    metaCache.set(s.id, p);
  }
  return metaCache.get(s.id);
}

// The compressed bytes of segment k for every stem of the current song.
function segBytes(k, { priority, onProgress } = {}) {
  let b = bytes.get(k);
  if (b) return b.promise;
  const ctrl = new AbortController();
  const dir = song.dir;
  b = { ctrl };
  b.promise = Promise.all(STEMS.map((st, i) => fetchBytes(dir + st.id + '/' + segName(k), {
    signal: ctrl.signal, priority, onProgress: onProgress && (f => onProgress(i, f)),
  })));
  b.promise.catch(() => { if (bytes.get(k) === b) bytes.delete(k); });
  bytes.set(k, b);
  return b.promise;
}

// Segment k decoded for every stem; using it marks it most recently used.
function decodeSegment(k, opts) {
  let d = decoded.get(k);
  if (d) { touchDecoded(k); return d.promise; }
  d = { result: null, size: 0 };
  d.promise = (async () => {
    const bufs = await segBytes(k, opts);
    // decodeAudioData detaches its input, so decode a copy and keep the bytes.
    const result = await Promise.all(bufs.map(b => ctx.decodeAudioData(b.slice(0))));
    d.result = result;
    d.size = result.reduce((n, b) => n + b.length * b.numberOfChannels * 4, 0);
    return result;
  })();
  d.promise.then(pump, () => { if (decoded.get(k) === d) decoded.delete(k); });
  decoded.set(k, d);
  return d.promise;
}

function touchDecoded(k) {
  const d = decoded.get(k);
  decoded.delete(k);
  decoded.set(k, d);
}

function decodedTotal() {
  let n = 0;
  for (const d of decoded.values()) n += d.size;
  return n;
}

// Decode segment k and the AHEAD after it, then drop the least recently
// used decoded segments outside that span until the budget is met.
function keepWindow(k) {
  if (!meta) return;
  const hi = Math.min(meta.segments - 1, k + AHEAD);
  for (let i = k; i <= hi; i++) decodeSegment(i, { priority: i <= k + 1 ? 'high' : 'low' });
  for (const [i, d] of decoded) {
    if (decodedTotal() <= DECODE_BUDGET) break;
    if ((i >= k && i <= hi) || !d.result) continue;
    decoded.delete(i);
  }
}

// Fetch the rest of the song's bytes, one segment at a time so the window's
// own fetches are not crowded, from the playhead onward and then from the top.
async function fillBytes(token) {
  if (navigator.connection && navigator.connection.saveData) return;
  const n = meta.segments, start = segIndex(offset);
  for (let d = 0; d < n; d++) {
    if (token !== loadToken) return;
    try { await segBytes((start + d) % n, { priority: 'low' }); } catch (_) { return; }
  }
}

function dropSegments() {
  for (const b of bytes.values()) b.ctrl.abort();
  bytes = new Map();
  decoded = new Map();
}

// The first segment of a song goes through the loading bar.
function loadFirstSegment(k) {
  const fill = document.getElementById('loading-fill');
  const label = document.getElementById('loading-label');
  label.textContent = 'Loading stems…';
  fill.style.width = '0%';
  const progress = new Array(STEMS.length).fill(0);
  return decodeSegment(k, {
    priority: 'high',
    onProgress: (i, f) => {
      progress[i] = f;
      const pct = progress.reduce((a, b) => a + b, 0) / progress.length * 100;
      fill.style.width = pct.toFixed(1) + '%';
      if (pct >= 100) label.textContent = 'Decoding…';
    },
  });
}

// Warm the other songs in the background: their manifests and first
// segments, nearest in the list first, so switching songs starts at once.
let warmToken = 0;
async function warmOtherSongs(current) {
  const token = ++warmToken;
  if (navigator.connection && navigator.connection.saveData) return;
  const listed = listedSongs();
  const i = listed.findIndex(s => s.id === current.id);
  for (let d = 1; d < listed.length; d++) {
    const s = listed[(i + d) % listed.length];
    if (token !== warmToken) return;
    try {
      await fetchMeta(s);
      await Promise.all(stemsFor(s).map(st => {
        const url = s.dir + st.id + '/' + segName(0);
        if (prefetched.has(url)) return null;
        const p = fetchBytes(url, { priority: 'low' });
        p.catch(() => prefetched.delete(url));
        prefetched.set(url, p);
        return p;
      }));
    } catch (err) {
      console.warn('warm failed', s.id, err);
    }
  }
}

// ---------- graph ----------

function buildChannel(def) {
  const fader = ctx.createGain();
  const muteGain = ctx.createGain();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.6;

  fader.connect(muteGain);
  muteGain.connect(analyser);
  analyser.connect(master);

  return { def, fader, muteGain, analyser, mute: false, solo: false };
}

function teardownChannels() {
  clearSoloHint();
  stopSources();
  keepaliveStop();
  dropSegments();
  for (const c of channels) c.analyser.disconnect();
  channels = [];
  meta = null;
  playing = false;
  buffering = false;
  offset = 0;
  duration = 0;
}

function applyMuteSolo() {
  const anySolo = channels.some(c => c.solo);
  for (const c of channels) {
    const audible = anySolo ? c.solo : !c.mute;
    c.muteGain.gain.setTargetAtTime(audible ? 1 : 0, ctx.currentTime, 0.01);
    c.ui.strip.classList.toggle('inactive', !audible);
    c.ui.mute.classList.toggle('on', c.mute);
    c.ui.solo.classList.toggle('on', c.solo);
  }
  updateHints();
  writeHash();
}

// ---------- URL state ----------
//
// The hash names the song first, so older links still work, then carries the
// mix and the moment as &-separated key=value pairs:
//   #1998-07-26-funky-bitch&solo=keys&mute=vocals&g=guitar:0.8,bass:1.2&t=312
// Keys at their defaults are left out, so an untouched mix is just #songid.
// guide= names a listening guide (see the guides section below).
// The hash is rewritten with replaceState so Back still returns to the
// previous song rather than stepping through every mute.

const GAIN_MAX = 1.5;
let hashPos = null; // position (s) last written to the hash; null means none

// A song marked "hidden" in songs.yaml stays out of the picker, the count,
// the next/previous controls and background warming, but still plays from
// a direct link.
function listedSongs() {
  return songs.filter(s => !s.hidden);
}

function findSong(id) {
  return songs.find(s => s.id === id) || listedSongs()[0] || songs[0];
}

function parseStemList(val) {
  const slotIds = SLOTS.map(slot => slot.id);
  return val.split(',').filter(id => slotIds.includes(id));
}

// Gains from [stem, value] pairs: known stems only, clamped to the fader's range.
function gainsFrom(pairs) {
  const slotIds = SLOTS.map(slot => slot.id);
  const gains = {};
  for (const [id, v] of pairs) {
    const n = Number(v);
    if (slotIds.includes(id) && Number.isFinite(n)) gains[id] = Math.max(0, Math.min(GAIN_MAX, n));
  }
  return gains;
}

function parseGains(val) {
  return gainsFrom(val.split(',').map(item => item.split(':')));
}

function parseHash() {
  const [idPart, ...pairs] = location.hash.slice(1).split('&');
  const state = { id: decodeURIComponent(idPart), solo: [], mute: [], gains: {}, t: null, guide: null };
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const key = pair.slice(0, eq);
    const val = decodeURIComponent(pair.slice(eq + 1));
    if (key === 'solo' || key === 'mute') {
      state[key] = parseStemList(val);
    } else if (key === 'g') {
      state.gains = parseGains(val);
    } else if (key === 't') {
      const n = Number(val);
      if (Number.isFinite(n) && n >= 0) state.t = n;
    } else if (key === 'guide' && /^[\w-]+$/.test(val)) {
      state.guide = val;
    }
  }
  return state;
}

// The mixer's current mute, solo and fader state, in the shape a hash or a
// guide tip carries it: only non-default gains are listed.
function mixState() {
  return {
    solo: channels.filter(c => c.solo).map(c => c.def.id),
    mute: channels.filter(c => c.mute).map(c => c.def.id),
    gains: Object.fromEntries(channels
      .map(c => [c.def.id, Number(c.ui.fader.value)])
      .filter(([, g]) => g !== 1)),
  };
}

function buildHash() {
  const parts = [song.id];
  const { solo, mute, gains } = mixState();
  const gainList = Object.entries(gains).map(([id, g]) => id + ':' + g);
  if (solo.length) parts.push('solo=' + solo.join(','));
  if (mute.length) parts.push('mute=' + mute.join(','));
  if (gainList.length) parts.push('g=' + gainList.join(','));
  const t = Math.round(hashPos || 0);
  if (t > 0) parts.push('t=' + t);
  if (guideParam) parts.push('guide=' + guideParam);
  return '#' + parts.join('&');
}

function writeHash() {
  if (!song || !channels.length) return;
  const h = buildHash();
  if (h !== location.hash) history.replaceState(null, '', h);
}

// Position goes into the hash only on seek, pause, or Share, never from
// the animation frame.
function writePosition() {
  hashPos = position();
  writeHash();
}

// Apply a parsed hash to the loaded channels. Solos and mutes set here count
// as mixing for the hints, but the listener has not pressed a button, so this
// does not retire the solo hint the way noteMixUsed() would.
function applyMixState(state) {
  for (const c of channels) {
    c.solo = state.solo.includes(c.def.id);
    c.mute = state.mute.includes(c.def.id);
    const g = state.gains[c.def.id] ?? 1;
    c.ui.fader.value = g;
    c.fader.gain.setTargetAtTime(g, ctx.currentTime, 0.01);
  }
  if (state.t !== null) {
    seek(state.t);
    hashPos = offset;
  }
  applyMuteSolo();
  guideSync(false);
}

// ---------- first-run hints ----------
//
// Nudge a new listener toward the two things worth discovering: while a song
// is loaded but paused, Play pulses; while it plays with every channel
// audible, one strip's S button glows for eight seconds, rests for eight, then
// another strip takes a turn. Once they have pressed S or M even once, the
// solo hint is retired for good (remembered in localStorage), since they've
// found the buttons.

const HINT_ON = 8000;
const HINT_OFF = 8000;
const MIX_USED_KEY = 'splitopen.mixUsed';
let hintTimer = null;
let hintIndex = -1;

function mixUsed() {
  try { return localStorage.getItem(MIX_USED_KEY) === '1'; } catch (_) { return false; }
}

function noteMixUsed() {
  try { localStorage.setItem(MIX_USED_KEY, '1'); } catch (_) { /* private mode */ }
  updateHints();
  tipsMixUsed();
}

function clearSoloHint() {
  clearTimeout(hintTimer);
  hintTimer = null;
  if (hintIndex >= 0 && channels[hintIndex]) channels[hintIndex].ui.solo.classList.remove('hint');
  hintIndex = -1;
}

function advanceSoloHint() {
  if (hintIndex >= 0 && channels[hintIndex]) channels[hintIndex].ui.solo.classList.remove('hint');
  // Pick a strip other than the current one so the hint visibly moves.
  let next = Math.floor(Math.random() * channels.length);
  if (channels.length > 1 && next === hintIndex) next = (next + 1) % channels.length;
  hintIndex = next;
  channels[hintIndex].ui.solo.classList.add('hint');
  hintTimer = setTimeout(() => {
    channels[hintIndex].ui.solo.classList.remove('hint');
    hintTimer = setTimeout(advanceSoloHint, HINT_OFF);
  }, HINT_ON);
}

function updateHints() {
  const loaded = channels.length > 0;
  ui.play.classList.toggle('hint', loaded && !playing);

  const mixing = channels.some(c => c.solo || c.mute);
  const wantSolo = loaded && playing && !mixing && !mixUsed();
  if (!wantSolo) clearSoloHint();
  else if (hintTimer === null) advanceSoloHint();
}

// ---------- tips ----------
//
// A three-line tour for a new listener, one tip at a time in the line under
// the transport: Play, a few seconds after the first song is ready; Solo, a
// few seconds into playback (skipped if they have ever used solo or mute,
// remembered in localStorage like the S-button glow, or a link or guide set
// the mix); and the song picker half a minute after that, which opens it
// when clicked and fades out on its own after ten seconds. Pressing Play
// retires the first tip, pressing S or M the second, and changing songs
// ends the tour early, since they've found everything.

const TIP_LOAD_DELAY = 3000;   // song ready -> Play tip
const TIP_PLAY_DELAY = 4000;   // playing -> Solo tip
const TIP_SONGS_DELAY = 30000; // Solo tip -> songs tip
const TIP_SONGS_LINGER = 10000; // songs tip -> gone
const TIP_FADE = 600;          // matches the CSS transition
const TIPS = {
  play: 'Press <em>Play</em>, and soak in sound',
  solo: 'Click <em>Solo</em>, and smile',
  songs: '<button type="button" class="tip-link">Change songs</button>, as you wish',
};
let tipStage = 'load'; // load -> play -> solo -> songs -> done
let tipTimer = null;
let tipShown = null;   // key of the tip on screen, or null
let tipSwap = null;

function showTip(key) {
  clearTimeout(tipSwap);
  if (!key) {
    tipShown = null;
    ui.tip.classList.remove('on');
    return;
  }
  const reveal = () => {
    tipShown = key;
    ui.tipText.innerHTML = TIPS[key];
    ui.tip.classList.add('on');
  };
  if (!tipShown) return reveal();
  // Let the old line fade out before the new one fades in.
  ui.tip.classList.remove('on');
  tipSwap = setTimeout(reveal, TIP_FADE);
}

// The first song has loaded and Play is on screen.
function tipsSongReady() {
  if (tipStage !== 'load') return;
  tipStage = 'play';
  tipTimer = setTimeout(() => showTip('play'), TIP_LOAD_DELAY);
}

// Playback started or stopped. The Solo tip waits for a few seconds of
// uninterrupted playing, so a pause before then restarts its clock.
function tipsPlaying(on) {
  if (tipStage === 'play' && on) {
    clearTimeout(tipTimer);
    showTip(null);
    tipStage = 'solo';
  }
  if (tipStage === 'solo') {
    clearTimeout(tipTimer);
    if (on) tipTimer = setTimeout(tipsSolo, TIP_PLAY_DELAY);
  }
}

function tipsSolo() {
  const mixing = channels.some(c => c.solo || c.mute);
  if (!mixing && !mixUsed()) showTip('solo');
  tipStage = 'songs';
  tipTimer = setTimeout(() => {
    tipStage = 'done';
    showTip('songs');
    tipTimer = setTimeout(() => showTip(null), TIP_SONGS_LINGER);
  }, TIP_SONGS_DELAY);
}

// The songs tip is a link to the picker.
function wireTips() {
  ui.tip = document.getElementById('tip');
  ui.tipText = document.getElementById('tip-text');
  ui.tipText.addEventListener('click', e => {
    if (!e.target.closest('.tip-link')) return;
    clearTimeout(tipTimer);
    showTip(null);
    openSongPicker();
  });
}

// S or M was pressed: the Solo tip has done its job.
function tipsMixUsed() {
  if (tipShown === 'solo') showTip(null);
}

// The listener picked another song: nothing left to point out.
function tipsSongChanged() {
  if (tipStage === 'done' && !tipShown) return;
  clearTimeout(tipTimer);
  tipStage = 'done';
  showTip(null);
}

// ---------- transport ----------

// Sources start a little after play(), so for that moment the clock reads
// behind the start offset; clamp so the position never steps back.
function position() {
  return playing ? Math.max(offset, Math.min(duration, offset + ctx.currentTime - startedAt)) : offset;
}

// Song time to AudioContext time for the current run of playback.
function clockAt(t) { return startedAt + (t - offset); }

const scheduled = new Map(); // segment index -> its source nodes, one per stem

// Start segment k of every stem at its place on the clock. A segment's end
// and the next one's start are the same expression, so they land on the same
// sample frame: no gap and no overlap at the join.
function scheduleSegment(k, buffers) {
  const segStart = k * meta.segment;
  const segEnd = Math.min(duration, segStart + meta.segment);
  let from = Math.max(segStart, offset);
  let when = clockAt(from);
  const now = ctx.currentTime + 0.02 + CLOCK_MARGIN;
  if (when < now) { from += now - when; when = now; } // scheduled late (a throttled timer): join in where the clock is
  if (from >= segEnd) return;
  const until = clockAt(segEnd);
  const lead = k ? meta.lead : 0;
  const sources = channels.map((c, i) => {
    const src = ctx.createBufferSource();
    src.buffer = buffers[i];
    src.connect(c.fader);
    src.start(when, lead + (from - segStart));
    src.stop(until);
    return src;
  });
  sources[0].onended = () => {
    scheduled.delete(k);
    // The last segment ending naturally means the track is over.
    if (k === meta.segments - 1 && playing && position() >= duration - 0.05) stop(0);
  };
  scheduled.set(k, sources);
}

// Keep the window around the playhead decoded, and every decoded segment in
// it scheduled. Runs on play and seek, whenever a decode lands, and on a
// timer, so a background tab (where animation frames stop) keeps playing.
// If the segment under the playhead is not decoded yet, playback waits for it.
function pump() {
  if (!playing || !meta) return;
  const k0 = segIndex(position());
  keepWindow(k0);
  if (!decoded.get(k0).result) return rebuffer(k0);
  for (let k = k0; k < meta.segments && k <= k0 + AHEAD; k++) {
    const d = decoded.get(k);
    if (d && d.result && !scheduled.has(k)) scheduleSegment(k, d.result);
  }
}
setInterval(pump, 1000);

let bufferToken = 0;
function rebuffer(k) {
  offset = position();
  stopSources();
  playing = false;
  buffering = true;
  ui.play.classList.add('buffering');
  const token = ++bufferToken;
  decodeSegment(k).then(() => {
    if (token !== bufferToken || !buffering) return;
    buffering = false;
    ui.play.classList.remove('buffering');
    keepaliveSeek(offset);
    startSources(offset);
  }, () => { /* aborted by a seek or a song switch, which takes over */ });
}

// Both the start time and the start offset are snapped to the context's
// sample grid, so every segment's start and stop land on whole frames.
// Off the grid, browsers interpolate a source's samples to its sub-sample
// start, and the two sources meeting at a join do not agree about the frame
// they share; on the grid the join is sample-exact.
function startSources(from) {
  const rate = ctx.sampleRate;
  startedAt = Math.ceil((ctx.currentTime + 0.05 + CLOCK_MARGIN) * rate) / rate;
  offset = Math.round(from * rate) / rate;
  playing = true;
  pump();
}

function stopSources() {
  for (const sources of scheduled.values()) {
    for (const src of sources) {
      src.onended = null;
      try { src.stop(); } catch (_) { /* already stopped */ }
      src.disconnect();
    }
  }
  scheduled.clear();
}

function setPlayButton(on) {
  ui.play.classList.toggle('playing', on);
  if (!on) { buffering = false; ui.play.classList.remove('buffering'); }
  ui.play.setAttribute('aria-label', on ? 'Pause' : 'Play');
  updateHints();
  tipsPlaying(on);
  mediaSessionState(on);
}

async function play() {
  if (!channels.length) return;
  keepaliveStart(); // must be called synchronously inside the user gesture
  guideWaiting = false;
  // Safari also reports 'interrupted' (phone call, backgrounding); resume covers both.
  if (ctx.state !== 'running') await ctx.resume();
  if (offset >= duration) offset = 0;
  startSources(offset);
  setPlayButton(true);
  guideResume();
}

function pause() {
  offset = position();
  stopSources();
  playing = false;
  buffering = false;
  keepaliveStop();
  guideWaiting = false;
  stopLoop();
  setPlayButton(false);
  writePosition();
}

function stop(at) {
  stopSources();
  playing = false;
  buffering = false;
  offset = at;
  keepaliveStop();
  setPlayButton(false);
}

function seek(to) {
  if (!meta) return;
  const wasPlaying = playing || buffering;
  stopSources();
  playing = false;
  buffering = false;
  offset = Math.max(0, Math.min(duration, to));
  if (wasPlaying) startSources(offset); else keepWindow(segIndex(offset));
  ui.seek.value = Math.round(offset / duration * 1000);
  ui.cur.textContent = fmt(offset);
  keepaliveSeek(offset);
  mediaSessionPosition();
}

function sheetOpen() {
  return !!((ui.mixSheet && ui.mixSheet.open) || (ui.songSheet && ui.songSheet.open) || (ui.offerSheet && ui.offerSheet.open));
}

// Keys typed into a text field belong to the field, not the player.
function isTyping(el) {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
  return el.tagName === 'INPUT' && !['range', 'checkbox', 'button'].includes(el.type);
}

// Left and Right arrows step the playhead 5 s either way, through seek() so
// the play state is kept. preventDefault stops a focused fader or the seek
// bar from stepping as well.
function wireNudgeKeys() {
  document.addEventListener('keydown', e => {
    if (isTyping(e.target) || sheetOpen()) return;
    if (!channels.length || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    seek(position() + (e.key === 'ArrowLeft' ? -5 : 5));
    guideSync(true);
  });
}

// ---------- media session ----------
// Lock-screen, media-hub, headphone and keyboard media-key controls. All of
// these go through navigator.mediaSession, which browsers only surface while a
// media element is playing; on iOS that is the keep-alive element above.

const MEDIA_ACTIONS = {
  play: () => play(),
  pause: () => pause(),
  seekbackward: d => { seek(position() - ((d && d.seekOffset) || 10)); guideSync(true); },
  seekforward: d => { seek(position() + ((d && d.seekOffset) || 10)); guideSync(true); },
  seekto: d => { if (d && typeof d.seekTime === 'number') { seek(d.seekTime); guideSync(true); } },
  previoustrack: () => mediaSessionStep(-1),
  nexttrack: () => mediaSessionStep(1),
};

function mediaSessionSetHandlers(actions) {
  if (!('mediaSession' in navigator)) return;
  for (const action of actions) {
    try { navigator.mediaSession.setActionHandler(action, MEDIA_ACTIONS[action]); } catch (_) { /* action unsupported */ }
  }
}

// play and pause are registered up front; without them a lock-screen play
// would start the keep-alive element but not the Web Audio graph.
function mediaSessionInstall() {
  mediaSessionSetHandlers(['play', 'pause']);
}

// iOS Safari only tells the system which commands a page supports once a
// media element has registered as Now Playing; handlers set earlier are
// dropped, so the seek and track handlers wait for the keep-alive element's
// first 'playing' event, which fires after that registration.
//
// The iOS lock screen shows either track buttons or seek buttons, and picks
// track buttons when both are registered, so the track handlers are left out
// there. iOS passes its own 15-second interval through details.seekOffset.
const IOS = /iP(hone|ad|od)/.test(navigator.platform)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function mediaSessionWatchKeepalive(el) {
  el.addEventListener('playing', () => {
    mediaSessionSetHandlers(['seekbackward', 'seekforward', 'seekto']);
    if (!IOS) mediaSessionSetHandlers(['previoustrack', 'nexttrack']);
  }, { once: true });
}

// Wraps around the song list, the same way the sidebar switches songs.
function mediaSessionStep(dir) {
  const listed = listedSongs();
  if (!song || !listed.length) return;
  const i = listed.findIndex(s => s.id === song.id);
  location.hash = listed[(i + dir + listed.length) % listed.length].id;
}

function mediaSessionMetadata() {
  if (!('mediaSession' in navigator) || !song) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title,
      artist: band.name,
      album: `${song.date} · ${song.venue}`,
      artwork: [{ src: new URL('apple-touch-icon.png', location.href).href, sizes: '180x180', type: 'image/png' }],
    });
  } catch (_) { /* MediaMetadata unavailable */ }
}

function mediaSessionState(on) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.playbackState = on ? 'playing' : 'paused';
  mediaSessionPosition();
}

// Keeps the lock-screen scrubber accurate. Called on play, pause, seek and
// song load; the browser extrapolates between calls, so not every frame.
function mediaSessionPosition() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  if (!channels.length || !(duration > 0)) return;
  try {
    navigator.mediaSession.setPositionState({
      duration,
      position: Math.max(0, Math.min(duration, position())),
      playbackRate: 1,
    });
  } catch (_) { /* position outside duration */ }
}

// ---------- guides ----------
//
// A guide is a listening tour of a song: an ordered list of tips, each a
// passage, a mix, and a note. The mix holds for the passage; between tips
// the band plays in full. When the playhead crosses into a tip its note is
// shown; a tip marked `pause` also stops the music until the listener
// presses Continue. The text form is YAML:
//
//   title: Solos
//   lang: en
//   by: Moshe Weitzman
//   url: https://weitzman.github.io
//   tips:
//     - at: 0:00
//       to: 0:30
//       solo: [drums]
//       note: Fish alone on drums.
//     - at: 0:30
//       to: 1:00
//       solo: [drums, bass]
//       pause: true
//       note: Mike joins. Listen for the push and pull.
//
// The top-level keys are title, lang (the notes' language code, which the
// page passes on to the browser), by and url (the author's name and a link
// for it) and tips. A tip has at (m:ss), then any of to (where the tip
// ends; without it, at the next tip), solo and mute (a player or a list of
// players), gain (a map of player to level, 0 to 1.5), pause (true) and
// note. A later tip may start earlier than the one before it ends, which is
// how a passage is replayed. The hash carries a guide as guide=<slug> for
// one kept in the repo (see guides.json), or guide=z<base64url of the
// deflated text> for one written in the player or by hand;
// SplitOpen.guideLink(text) in the console makes such a link.

function emptyTip(at) {
  return { at, to: null, solo: [], mute: [], gains: {}, pause: false, note: '' };
}

function parseClock(s) {
  const m = /^(\d+):(\d{2}(?:\.\d+)?)$/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// YAML as js-yaml (vendor/js-yaml.min.js) reads it with the core schema,
// which is YAML 1.2: 0:30 and 1998-07-26 stay strings, so times and dates
// arrive as written. scripts/yaml12.py gives the checks the same reading.
function yamlLoad(text) {
  return jsyaml.load(text, { schema: jsyaml.CORE_SCHEMA });
}

async function fetchYaml(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return yamlLoad(await r.text());
}

// Reads a guide from its YAML text. Lenient, as the player is with the
// hash: a tip without a readable start is dropped, unknown players and keys
// are ignored. scripts/guides-index.py checks the library's guides strictly.
// Throws on text that is not YAML.
function parseGuideText(text) {
  const doc = yamlLoad(text);
  const d = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
  const str = v => (v === null || v === undefined ? '' : String(v).trim());
  const names = v => (Array.isArray(v) ? v : [v]).map(str).join(',');
  const g = { title: str(d.title), lang: str(d.lang), by: str(d.by), url: str(d.url), tips: [] };
  for (const t of Array.isArray(d.tips) ? d.tips : []) {
    if (!t || typeof t !== 'object') continue;
    const at = parseClock(str(t.at));
    if (at === null) continue;
    const tip = emptyTip(at);
    tip.to = parseClock(str(t.to));
    if ('solo' in t) tip.solo = parseStemList(names(t.solo));
    if ('mute' in t) tip.mute = parseStemList(names(t.mute));
    if (t.gain && typeof t.gain === 'object') tip.gains = gainsFrom(Object.entries(t.gain));
    tip.pause = t.pause === true;
    tip.note = str(t.note);
    g.tips.push(tip);
  }
  return g;
}

// deflate + base64url, so a hand-written guide fits in a link: a dozen tips
// with a sentence each come to roughly a kilobyte.
function b64urlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  return Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0));
}

async function pipeBytes(bytes, stream) {
  const writer = stream.writable.getWriter();
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

async function encodeGuide(text) {
  return 'z' + b64urlEncode(await pipeBytes(new TextEncoder().encode(text), new CompressionStream('deflate')));
}

async function decodeGuide(param) {
  if (param[0] !== 'z') throw new Error('unknown guide ' + param);
  if (!window.DecompressionStream) throw new Error('this browser cannot open shared guides');
  return new TextDecoder().decode(await pipeBytes(b64urlDecode(param.slice(1)), new DecompressionStream('deflate')));
}

window.SplitOpen = {
  async guideLink(text) {
    if (!song) throw new Error('load a song first');
    return location.href.split('#')[0] + '#' + song.id + '&guide=' + await encodeGuide(text);
  },
};

// The library: guides.json maps a song id to the slugs of the guides kept
// under guides/<song id>/<slug>.yaml. Their headers are read when the song
// loads so the chips can show title and author.
let repoGuides = {};        // song id -> [slug]
let repoGuideMeta = {};     // slug -> { title, by } for the current song

let guideParam = null;  // the hash's guide=, kept while the guide itself loads
let guide = null;       // { param, title, lang, tips }
let guideIndex = -1;    // the tip the playhead is in; -1 before the first
let guideWaiting = false; // paused by a `pause` tip, waiting for Continue

function repoGuideUrl(slug) {
  return `guides/${song.id}/${slug}.yaml`;
}

async function fetchRepoGuide(slug) {
  const r = await fetch(repoGuideUrl(slug), { cache: 'no-cache' });
  if (!r.ok) throw new Error(`guide ${slug} not found`);
  return r.text();
}

async function resolveGuide(param) {
  const inRepo = (repoGuides[song.id] || []).includes(param);
  const g = parseGuideText(inRepo ? await fetchRepoGuide(param) : await decodeGuide(param));
  if (!/^https?:\/\//i.test(g.url)) g.url = ''; // only web links, never javascript:
  return { param, title: g.title, lang: g.lang || 'en', by: g.by, url: g.url, tips: g.tips };
}

// Reads the headers of this song's library guides for the chips.
async function loadRepoGuideMeta() {
  const id = song.id;
  repoGuideMeta = {};
  await Promise.all((repoGuides[id] || []).map(async slug => {
    try {
      const g = parseGuideText(await fetchRepoGuide(slug));
      if (song && song.id === id) repoGuideMeta[slug] = { title: g.title, by: g.by };
    } catch (err) {
      console.error(err);
    }
  }));
  if (song && song.id === id) renderGuideChips();
}

// Brings the open guide in line with the hash's guide= value.
async function syncGuide(state) {
  const want = state.guide || null;
  if ((guide ? guide.param : null) === want) return;
  closeGuide(false);
  guideParam = want;
  if (!want) return;
  let g;
  try {
    g = await resolveGuide(want);
  } catch (err) {
    console.error(err);
    const error = want[0] === 'z'
      ? 'This link holds a guide this browser cannot read.'
      : `There is no guide called \u201c${want}\u201d for this song.`;
    g = { param: want, title: 'Guide', lang: 'en', by: '', url: '', tips: [], error };
  }
  if (!channels.length || guideParam !== want) return; // moved on meanwhile
  openGuide(g);
}

function openGuide(g) {
  guide = g;
  guideIndex = -1;
  renderGuide();
  guideSync(false);
  writeHash();
}

function closeGuide(write = true) {
  if (!guide) return;
  clearTimeout(draftTimer);
  guideWaiting = false;
  guide = null;
  guideParam = null;
  guideIndex = -1;
  ui.guide.hidden = true;
  ui.mixer.hidden = !channels.length;
  ui.marks.innerHTML = '';
  loopRange = null;
  tipEdit = null;
  renderGuideChips();
  if (write) writeHash();
}

function setGuide(param) {
  syncGuide({ guide: param });
}

function guideEnd(i) {
  const tips = guide.tips;
  if (tips[i].to !== null) return tips[i].to;
  const next = tips[i + 1];
  return next && next.at > tips[i].at ? next.at : duration;
}

function inTip(i, pos) {
  return pos >= guide.tips[i].at && pos < guideEnd(i);
}

// While writing, the mixer is the author's: the guide highlights tips but
// leaves the mix alone (the jump button still previews a tip's mix).
function guideOwnsMix() {
  return !guide.editing;
}

// After the listener moves the playhead: find the tip that holds it, keeping
// the current one when it still does, and enter it; outside every tip the
// band plays in full. Landing at a tip's start counts as arriving there (so
// a `pause` tip pauses); landing inside it does not.
function guideSync(arrive) {
  if (!guide) return;
  guideWaiting = false;
  if (arrive) stopLoop(); // the listener moved the playhead themselves
  const pos = position();
  const tips = guide.tips;
  const i = guideIndex >= 0 && inTip(guideIndex, pos) ? guideIndex : tips.findIndex((t, k) => inTip(k, pos));
  if (i < 0) leaveTips();
  else if (i !== guideIndex) enterTip(i, arrive && pos - tips[i].at < 1.5);
  else renderGuideNow();
}

// Each frame while playing: once the current tip has run out, move to the
// next one if it starts here (or earlier, which replays the passage); else
// let the band play in full until the next tip begins.
function guideTick(pos) {
  if (!guide || !playing || !guide.tips.length) return;
  const tips = guide.tips;
  if (loopRange !== null) {
    const end = loopRange.to !== null ? loopRange.to : tips[loopRange.i] ? guideEnd(loopRange.i) : duration;
    if (pos >= end - 0.05 || pos < loopRange.at - 0.1) seek(loopRange.at);
    return;
  }
  if (guideIndex >= 0 && pos < tips[guideIndex].at - 0.1) return guideSync(true);
  if (guideIndex >= 0 && pos < guideEnd(guideIndex)) return;
  const next = guideIndex >= 0 ? guideIndex + 1 : tips.findIndex((t, k) => pos >= t.at - 0.25 && pos < guideEnd(k));
  if (guideIndex >= 0 && next < tips.length && tips[next].at < pos - 0.5) {
    seek(tips[next].at);
    return enterTip(next, true);
  }
  if (next >= 0 && next < tips.length && pos >= tips[next].at - 0.25) return enterTip(next, true);
  if (guideIndex >= 0) leaveTips();
}

// On Play: find the tip under the playhead, since the song may have been
// started over from the top.
function guideResume() {
  guideSync(false);
}

function setMix(mix) {
  for (const c of channels) {
    c.solo = mix.solo.includes(c.def.id);
    c.mute = mix.mute.includes(c.def.id);
    const g = mix.gains[c.def.id] ?? 1;
    c.ui.fader.value = g;
    c.fader.gain.setTargetAtTime(g, ctx.currentTime, 0.01);
  }
  applyMuteSolo();
}

// The playhead has left the last tip without entering another.
function leaveTips() {
  const was = guideIndex;
  guideIndex = -1;
  if (was >= 0 && guideOwnsMix()) setMix({ solo: [], mute: [], gains: {} });
  renderGuideNow();
}

// Applies the tip's mix and shows its note. `arrive` means the playhead has
// just reached the tip (as opposed to the guide being opened or the playhead
// dropped somewhere inside it), which is when a `pause` tip pauses.
function enterTip(i, arrive, applyMix = guideOwnsMix()) {
  const tip = guide.tips[i];
  guideIndex = i;
  if (applyMix) setMix(tip);
  if (arrive && tip.pause && playing && !guide.editing) {
    pause();
    guideWaiting = true;
  }
  renderGuideNow();
}

// "Fish · Solo", "Mike, Fish · Solo", "Vocals · Mute" or "Full mix".
function mixParts(tip) {
  const stems = ids => ids.map(id => STEMS.find(s => s.id === id) || { id, who: id, color: '' });
  if (tip.solo.length) return { stems: stems(tip.solo), what: 'Solo' };
  if (tip.mute.length) return { stems: stems(tip.mute), what: 'Mute' };
  return { stems: [], what: 'Full mix' };
}

function guideMixLabel(tip) {
  const { stems, what } = mixParts(tip);
  return stems.length ? stems.map(s => s.who).join(', ') + ' \u00b7 ' + what : what;
}

// The same label as elements, each player's name in their color.
function renderMixLabel(el, tip) {
  const { stems, what } = mixParts(tip);
  el.innerHTML = '';
  stems.forEach((s, i) => {
    const name = document.createElement('span');
    name.className = 'who';
    name.style.color = s.color;
    name.textContent = s.who;
    if (i) el.append(', ');
    el.appendChild(name);
  });
  el.append(stems.length ? ' \u00b7 ' + what : what);
}

// Fills a note element with text clamped to `lines` lines and shows its
// "more" link only when the text actually overflows; the link toggles the
// full text. Overflow is measured after layout, hence the frame wait.
function renderNote(noteEl, moreBtn, text, lines) {
  noteEl.textContent = text;
  noteEl.style.setProperty('--lines', lines);
  noteEl.classList.add('clamp');
  moreBtn.hidden = true;
  moreBtn.textContent = 'more';
  requestAnimationFrame(() => { moreBtn.hidden = noteEl.scrollHeight <= noteEl.clientHeight + 1; });
}

function wireMore(noteEl, moreBtn) {
  moreBtn.addEventListener('click', () => {
    const clamped = noteEl.classList.toggle('clamp');
    moreBtn.textContent = clamped ? 'more' : 'less';
  });
}

function renderGuide() {
  const editing = !!guide.editing;
  const tipEditing = editing && tipEdit !== null;
  ui.guide.hidden = false;
  ui.guide.classList.toggle('editing', editing);
  ui.guide.classList.toggle('tip-editing', tipEditing);
  ui.mixer.hidden = tipEditing; // editing a tip is all about the tip; the mixer makes way
  ui.guide.lang = guide.lang; // the notes' language, for screen readers and hyphenation
  ui.guideKicker.textContent = tipEditing ? 'Editing a tip' : editing ? 'Tips' : 'Guide';
  ui.guideTitle.hidden = editing;
  ui.guideAdd.hidden = !editing || tipEditing;
  ui.guideEdit.hidden = !canEdit();
  ui.guideOffer.hidden = tipEditing || !canOffer();
  ui.guideClose.hidden = tipEditing;
  ui.guideClose.title = editing ? 'Finish writing; the guide stays in the link' : 'Close this guide';
  ui.guideTitle.textContent = guide.title;
  if (guide.by) {
    ui.guideTitle.append(', by ');
    const who = document.createElement(guide.url ? 'a' : 'span');
    who.className = 'guide-by';
    who.textContent = guide.by;
    if (guide.url) {
      who.href = guide.url;
      who.target = '_blank';
      who.rel = 'noopener';
    }
    ui.guideTitle.appendChild(who);
  }
  ui.guideTips.innerHTML = '';
  ui.marks.innerHTML = '';
  guide.tips.forEach((tip, i) => {
    const mark = document.createElement('i');
    mark.style.left = (tip.at / duration * 100).toFixed(2) + '%';
    if (tip.to !== null) mark.style.width = 'max(2px, ' + ((tip.to - tip.at) / duration * 100).toFixed(2) + '%)';
    ui.marks.appendChild(mark);
    if (tipEditing) {
      if (i === tipEdit.i) ui.guideTips.appendChild(buildTipEditor(tip, i));
      return;
    }
    ui.guideTips.appendChild(buildTipRow(tip, i, editing));
  });
  renderGuideChips();
  renderGuideNow();
  renderEditMark();
}

// "0:32–0:48", or just the start for a tip that runs to the next one.
function tipSpan(tip) {
  return tip.to === null ? fmt(tip.at) : fmt(tip.at) + '–' + fmt(tip.to);
}

function goToTip(i) {
  guideWaiting = false;
  seek(guide.tips[i].at);
  writePosition();
  enterTip(i, true, true);
}

// The current tip is highlighted in the list; long notes stay clamped
// behind "more" until the listener opens them.
function renderGuideNow() {
  if (!guide) return;
  const hint = !guide.editing || guide.tips.length ? ''
    : 'Play the song, set mute/solo, and click <em>Tip: Start</em> where a passage worth a tip begins. '
      + 'When done adding tips and descriptions, click <em>Share</em> '
      + '<svg class="inline-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 10H6.5A1.5 1.5 0 0 0 5 11.5v8A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-8a1.5 1.5 0 0 0-1.5-1.5H16"/><path d="M12 15V3M8 7l4-4 4 4"/></svg>'
      + ' to send a link to your creation, or <em>Contribute</em> to offer it to the library.';
  if (guide.error) ui.guideStatus.textContent = guide.error;
  else if (guide.notice) ui.guideStatus.textContent = guide.notice;
  else ui.guideStatus.innerHTML = hint; // our own copy, no user text
  ui.guideStatus.hidden = !(guide.error || guide.notice || hint);
  ui.guideStatus.classList.toggle('error', !!guide.error);
  ui.guideContinue.hidden = !guideWaiting;
  Array.from(ui.guideTips.children).forEach((li, i) => li.classList.toggle('on', i === guideIndex));
  Array.from(ui.marks.children).forEach((mark, i) => mark.classList.toggle('on', i === guideIndex));
  const loopingRow = loopRange === null ? null : ui.guideTips.querySelector(`[data-tip="${loopRange.i}"]`);
  ui.guideTips.querySelectorAll('.looping').forEach(li => li.classList.remove('looping'));
  if (loopingRow) loopingRow.classList.add('looping');
  // Keep the current tip in view within the list only; scrollIntoView
  // would drag the whole page along on a phone.
  const list = ui.guideTips;
  const on = list.children[guideIndex];
  if (on) {
    if (on.offsetTop < list.scrollTop) list.scrollTop = on.offsetTop;
    else if (on.offsetTop + on.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = on.offsetTop + on.offsetHeight - list.clientHeight;
    }
  }
}

// The pills under the song title: the song's library guides, plus the open
// guide when it arrived in the link. Titles only; the author is shown in
// the panel. The row is shown only with ?guide=1 in the query string while
// the feature settles; a guide in the hash still opens without it.
function guidesEnabled() {
  return new URLSearchParams(location.search).get('guide') === '1';
}

function renderGuideChips() {
  const row = document.getElementById('guides');
  row.innerHTML = '';
  if (!song || !guidesEnabled()) return;
  const label = document.createElement('span');
  label.className = 'guides-label';
  label.textContent = 'Guides';
  row.appendChild(label);
  const entries = [];
  for (const slug of repoGuides[song.id] || []) {
    const meta = repoGuideMeta[slug] || { title: slug, by: '' };
    entries.push({ param: slug, title: meta.title, by: meta.by });
  }
  if (guide && !(repoGuides[song.id] || []).includes(guide.param)) entries.push(guide);
  for (const { param, title, by } of entries) {
    const btn = document.createElement('button');
    btn.className = 'song chip';
    btn.textContent = title || 'Untitled guide';
    if (by) btn.title = 'by ' + by; // the author shows in the panel, not the pill
    btn.classList.toggle('on', !!guide && guide.param === param);
    btn.addEventListener('click', () => {
      if (!channels.length || !leaveDraftOk()) return;
      if (guide && guide.param === param) closeGuide();
      else setGuide(param);
    });
    row.appendChild(btn);
  }
  if (window.CompressionStream && !(guide && guide.editing)) {
    const btn = document.createElement('button');
    btn.className = 'song chip new';
    btn.textContent = '+ New guide';
    btn.addEventListener('click', newGuide);
    row.appendChild(btn);
  }
}

function wireGuide() {
  ui.guide = document.getElementById('guide');
  ui.guideTitle = document.getElementById('guide-title');
  ui.guideStatus = document.getElementById('guide-status');
  ui.guideTips = document.getElementById('guide-tips');
  ui.guideContinue = document.getElementById('guide-continue');
  ui.marks = document.getElementById('marks');
  ui.guideKicker = document.getElementById('guide-kicker');
  ui.guideAdd = document.getElementById('guide-add');
  ui.guideEdit = document.getElementById('guide-edit');
  ui.guideOffer = document.getElementById('guide-offer');
  ui.guideClose = document.getElementById('guide-close');
  ui.mixer = document.getElementById('mixer');
  ui.guideContinue.addEventListener('click', () => { guideWaiting = false; play(); });
  ui.guideAdd.addEventListener('click', startTip);
  ui.guideEdit.addEventListener('click', editGuide);
  ui.guideOffer.addEventListener('click', openOfferSheet);
  // While writing, the close button finishes writing and shows the guide as
  // readers will see it; the guide stays in the link. Closing that view
  // drops the guide.
  document.getElementById('guide-close').addEventListener('click', () => {
    if (guide && guide.editing) finishEditing();
    else closeGuide();
  });
}

// ---------- guide authoring ----------
//
// A guide is written in the player itself. Start a new one (or edit the open
// one), play the song, set the mix, and press N (Tip: Start) where a passage
// worth a tip begins and again (Tip: End) where it ends: the tip takes that
// passage and the mix in force when it started, and its note is typed in
// place. The draft is re-encoded into the hash as it changes, so Share hands
// it out and a reload brings it back. A draft never pauses at its own
// `pause` tips.
// The title, author and language are not asked for here; they come later,
// when a guide is offered to the library.

let draftTimer = null;
let draftSeq = 0;

function clock(s) {
  const tenths = Math.round(s * 10);
  const frac = tenths % 10;
  return fmt(Math.floor(tenths / 10)) + (frac ? '.' + frac : '');
}

// The YAML text of a guide, the inverse of parseGuideText: the headers that
// are set, then one map per tip with only what the tip sets.
function guideText(g) {
  const doc = {};
  for (const key of ['title', 'lang', 'by', 'url']) if (g[key]) doc[key] = g[key];
  doc.tips = g.tips.map(s => {
    const t = { at: clock(s.at) };
    if (s.to !== null) t.to = clock(s.to);
    if (s.solo.length) t.solo = [...s.solo];
    if (s.mute.length) t.mute = [...s.mute];
    const gains = Object.entries(s.gains).filter(([, v]) => v !== 1);
    if (gains.length) t.gain = Object.fromEntries(gains);
    if (s.pause) t.pause = true;
    const note = s.note.replace(/\s*\n\s*/g, ' ').trim();
    if (note) t.note = note;
    return t;
  });
  // Player lists and gain maps inline ([drums, bass]); a note on one line
  // however long; no quoting of yes/no, which are only words in YAML 1.2.
  return jsyaml.dump(doc, { schema: jsyaml.CORE_SCHEMA, flowLevel: 3, lineWidth: -1, noCompatMode: true });
}

// The draft is always in the link, so leaving it only needs a word when
// that link has not been shared; the guide pill brings it back meanwhile.
function leaveDraftOk() {
  if (!guide || !guide.editing || !guide.tips.length) return true;
  return confirm('Leave the guide you are writing? Share it first to keep a link.');
}

function newGuide() {
  if (!channels.length || !leaveDraftOk()) return;
  closeGuide(false);
  const lang = (navigator.language || 'en').split('-')[0].toLowerCase();
  openGuide({ param: null, title: '', lang, by: '', url: '', tips: [], editing: true });
  draftChanged();
}

// A guide that lives in its link, rather than the library, can go back to
// writing: reading it and writing it are the same guide, so the headers
// stay and the link keeps carrying it.
function canEdit() {
  return !!guide && !guide.editing && !guide.error && !guideInLibrary() && !!window.CompressionStream;
}

function editGuide() {
  if (!canEdit()) return;
  guideWaiting = false;
  guide.editing = true;
  guide.notice = '';
  guideIndex = -1;
  renderGuide();
  guideSync(false);
  draftChanged();
}

async function finishEditing() {
  if (!guide || !guide.editing) return;
  tipEdit = null;
  clearTimeout(draftTimer);
  draftSeq++;
  guide.editing = false;
  stopLoop();
  guide.param = guideParam = await encodeGuide(guideText(guide));
  guideIndex = -1;
  renderGuide();
  guideSync(false);
  writeHash();
}

// Re-encodes the draft into the hash shortly after it last changed.
function draftChanged() {
  if (!guide || !guide.editing) return;
  const seq = ++draftSeq;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(async () => {
    const param = await encodeGuide(guideText(guide));
    if (seq !== draftSeq || !guide || !guide.editing) return;
    guide.param = guideParam = param;
    writeHash();
    renderGuideChips();
  }, 300);
}

// Tip: Start (or N) adds a tip at the playhead with the mixer's current
// state, placed among the others by time (a replayed passage can be dragged
// into place). A tip runs to the next tip unless an end is set in its
// editor.
function startTip() {
  if (!guide || !guide.editing || tipEdit !== null || !channels.length) return;
  const at = Math.round(position() * 10) / 10;
  const tip = { ...emptyTip(at), ...mixState() };
  let i = 0;
  while (i < guide.tips.length && guide.tips[i].at <= at) i++;
  guide.tips.splice(i, 0, tip);
  tipsChanged();
}

// After a tip is added, removed, moved or re-timed: rebuild the list and
// marks and find the current tip afresh, since the indexes have shifted.
function tipsChanged() {
  guideIndex = -1;
  renderGuide();
  guideSync(false);
  draftChanged();
}

const ICON_PENCIL = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M7 4l14 8-14 8z"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>';

// One row per tip, the same whether the guide is being read or written:
// the mix, the start (and a quiet optional end), and the note clamped
// behind "more". Writing adds a drag handle and edit / play / delete.
// Clicking the mix or times jumps to the tip.
function buildTipRow(tip, i, editable) {
  const li = document.createElement('li');
  li.className = 'tip-row' + (editable ? ' edit' : '');
  li.dataset.tip = i;
  li.tip = tip;
  li.innerHTML = `
    ${editable ? '<span class="handle" title="Drag to reorder" aria-label="Drag to reorder">&#8942;&#8942;</span>' : ''}
    <button class="jump" title="Jump to this tip">
      <span class="mix"></span>
      <span class="when"><span class="at"></span><span class="to"></span></span>
    </button>
    ${editable ? `<span class="actions">
      <button class="icon edit" title="Edit this tip" aria-label="Edit this tip">${ICON_PENCIL}</button>
      <button class="icon loop" title="Play this Tip in a loop" aria-label="Play this Tip in a loop">${ICON_PLAY}</button>
      <button class="icon del" title="Delete this tip" aria-label="Delete this tip">${ICON_TRASH}</button>
    </span>` : ''}
    <span class="note"></span>
    <button class="more">more</button>`;
  renderMixLabel(li.querySelector('.mix'), tip);
  li.querySelector('.at').textContent = fmt(tip.at);
  li.querySelector('.to').textContent = tip.to === null ? '' : ' \u2013 ' + fmt(tip.to);
  const note = li.querySelector('.note');
  const more = li.querySelector('.more');
  if (tip.note) {
    renderNote(note, more, tip.note, 2);
    wireMore(note, more);
  } else {
    note.hidden = true;
    more.hidden = true;
  }
  li.querySelector('.jump').addEventListener('click', () => goToTip(i));
  if (editable) {
    li.querySelector('.edit').addEventListener('click', () => editTip(i));
    li.querySelector('.loop').addEventListener('click', () => (loopRange && loopRange.i === i ? pause() : startLoop(i)));
    li.querySelector('.del').addEventListener('click', () => {
      guide.tips.splice(i, 1);
      tipsChanged();
    });
    wireDrag(li.querySelector('.handle'), li);
  }
  return li;
}

// Editing one tip: the list and the mixer step aside for its times and
// description. Play loops the passage as currently typed; Save keeps the
// changes, Discard drops them.
let tipEdit = null; // { i, at, to, note } while a tip is being edited

function editTip(i) {
  const tip = guide.tips[i];
  stopLoop();
  tipEdit = { i, at: tip.at, to: tip.to, note: tip.note, solo: [...tip.solo], mute: [...tip.mute] };
  renderGuide();
}

function buildTipEditor(tip, i) {
  const li = document.createElement('li');
  li.className = 'tip-editor';
  li.dataset.tip = i;
  li.innerHTML = `
    <div class="card-head">
      <button class="mix-btn" title="Change which players this tip solos or mutes"><span class="mix"></span><span class="mix-hint">change</span></button>
    </div>
    <div class="times">
      <span class="time-row">
        <span class="time-label">Start</span>
        <span class="time-value at"></span>
        <button class="mini set-at" title="Set the start to where the playhead is">Set</button>
      </span>
      <span class="time-row opt">
        <span class="time-label">End</span>
        <span class="time-value to"></span>
        <button class="mini set-to" title="Set the end to where the playhead is">Set</button>
        <button class="mini clear-to" title="Clear the end" aria-label="Clear the end">&times;</button>
      </span>
      <span class="scrub-hint">Scrub or play to a moment, then Set.</span>
    </div>
    <textarea class="edit-note" rows="5" placeholder="What to listen for here"></textarea>
    <div class="actions">
      <button class="btn save">Save</button>
      <button class="btn loop" title="Play this Tip in a loop">${ICON_PLAY}<span>Play</span></button>
      <button class="btn discard">Discard</button>
    </div>`;
  const mixLabel = li.querySelector('.mix');
  renderMixLabel(mixLabel, tipEdit);
  li.querySelector('.mix-btn').addEventListener('click', () => openMixSheet(tip, () => renderMixLabel(mixLabel, tipEdit)));
  const at = li.querySelector('.at');
  const to = li.querySelector('.to');
  const clearTo = li.querySelector('.clear-to');
  const setTo = li.querySelector('.set-to');
  const note = li.querySelector('textarea');
  note.value = tipEdit.note;
  const showTimes = () => {
    at.textContent = clock(tipEdit.at);
    to.textContent = tipEdit.to === null ? '\u2014' : clock(tipEdit.to);
    to.classList.toggle('unset', tipEdit.to === null);
    setTo.classList.toggle('quiet', tipEdit.to === null);
    clearTo.disabled = tipEdit.to === null;
    renderEditMark();
  };
  showTimes();
  li.querySelector('.set-at').addEventListener('click', () => {
    tipEdit.at = Math.round(position() * 10) / 10;
    if (tipEdit.to !== null && tipEdit.to <= tipEdit.at) tipEdit.to = null; // an end before the start is no end
    showTimes();
  });
  li.querySelector('.set-to').addEventListener('click', () => {
    const pos = Math.round(position() * 10) / 10;
    tipEdit.to = Math.min(duration, Math.max(tipEdit.at + 1, pos));
    showTimes();
  });
  clearTo.addEventListener('click', () => { tipEdit.to = null; showTimes(); });
  note.addEventListener('input', () => { tipEdit.note = note.value; });
  li.querySelector('.save').addEventListener('click', () => {
    Object.assign(tip, { at: tipEdit.at, to: tipEdit.to, note: tipEdit.note, solo: tipEdit.solo, mute: tipEdit.mute });
    tipEdit = null;
    stopLoop();
    tipsChanged();
  });
  li.querySelector('.discard').addEventListener('click', () => {
    tipEdit = null;
    stopLoop();
    guideIndex = -1;
    renderGuide();
    guideSync(false);
  });
  li.querySelector('.loop').addEventListener('click', () => (loopRange ? pause() : startLoop(i, tipEdit.at, tipEdit.to, { ...tip, solo: tipEdit.solo, mute: tipEdit.mute })));
  return li;
}

// ---------- offering a guide to the library ----------
//
// A guide written in the player lives in its link. Contribute offers it to
// the library, where it appears under the song for everyone: the sheet asks
// for the title, author and language that writing left out, then opens the
// mail app with the guide addressed to the library. The maintainer adds it
// as guides/<song>/<slug>.yaml, and the deploy regenerates guides.json from
// the files. Copy text covers sending the guide any other way.

const OFFER_EMAIL = 'splitopen@cyrve.com';
const OFFER_MAIL_MAX = 2000; // what mail apps are known to take from a mailto link
const AUTHOR_KEY = 'splitopen.author'; // the name and link, so they are typed once

function guideSlug(title) {
  const s = title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return s || 'guide';
}

function guideInLibrary() {
  return !!guide && !!song && (repoGuides[song.id] || []).includes(guide.param);
}

// Only a guide with something in it, that is not already in the library.
function canOffer() {
  return !!guide && !guide.error && guide.tips.length > 0 && !guideInLibrary() && !!window.CompressionStream;
}

function loadAuthor() {
  try { return JSON.parse(localStorage.getItem(AUTHOR_KEY)) || {}; } catch (_) { return {}; }
}

function saveAuthor(by, url) {
  try { localStorage.setItem(AUTHOR_KEY, JSON.stringify({ by, url })); } catch (_) { /* private mode */ }
}

// The link field shows https:// as a fixed prefix and takes the rest; a
// pasted scheme is dropped so the prefix is not doubled.
function offerUrlRest(v) {
  return v.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^\/+/, '');
}

function offerUrl() {
  const rest = offerUrlRest(ui.offerUrl.value);
  return rest ? 'https://' + rest : '';
}

function offerUrlOk() {
  const url = offerUrl();
  if (!url) return true;
  try { return new URL(url).hostname.includes('.'); } catch (_) { return false; }
}

// The form's values as guide headers, over the open guide's tips.
function offerDraft() {
  return {
    ...guide,
    title: ui.offerTitle.value.trim(),
    by: ui.offerBy.value.trim(),
    url: offerUrl(),
    lang: ui.offerLang.value.trim().toLowerCase() || 'en',
  };
}

function setOfferStatus(text, kind = '') {
  ui.offerStatus.textContent = text;
  ui.offerStatus.className = 'offer-status' + (kind ? ' ' + kind : '');
  ui.offerStatus.hidden = !text;
}

async function openOfferSheet() {
  if (!canOffer()) return;
  if (guide.editing) await finishEditing();
  const saved = loadAuthor();
  ui.offerTitle.value = guide.title;
  ui.offerBy.value = guide.by || saved.by || '';
  ui.offerUrl.value = offerUrlRest(guide.url || saved.url || '');
  ui.offerLang.value = guide.lang || 'en';
  setOfferStatus('');
  renderOfferPreview();
  ui.offerSheet.showModal();
  ui.offerTitle.focus();
}

function renderOfferPreview() {
  if (!guide) return;
  ui.offerText.textContent = guideText(offerDraft());
}

// The form checked: the draft with its slug, or null with the problem shown.
function checkedOffer() {
  const draft = offerDraft();
  if (!draft.title) {
    setOfferStatus('Give the guide a title.', 'error');
    ui.offerTitle.focus();
    return null;
  }
  if (!ui.offerLang.checkValidity()) {
    setOfferStatus('The language is a code like en or fr.', 'error');
    ui.offerLang.focus();
    return null;
  }
  if (!offerUrlOk()) {
    setOfferStatus('The link needs a site, like example.com/you.', 'error');
    ui.offerUrl.focus();
    return null;
  }
  const slug = guideSlug(draft.title);
  if ((repoGuides[song.id] || []).includes(slug)) {
    setOfferStatus(`The library already has a guide at “${slug}” for this song; give yours another title.`, 'error');
    ui.offerTitle.focus();
    return null;
  }
  return { draft, slug, text: guideText(draft) };
}

// After an offer goes out: the headers are kept for next time and written
// into the open guide and its link, and the notice says what is left to do.
function offerSent(draft, text, notice) {
  saveAuthor(draft.by, draft.url);
  Object.assign(guide, { title: draft.title, by: draft.by, url: draft.url, lang: draft.lang, notice });
  renderGuide();
  guideSync(false);
  return encodeGuide(text).then(param => {
    if (!guide || guide.editing) return;
    guide.param = guideParam = param;
    writeHash();
    renderGuideChips();
  });
}

// Email it: the mail app opens with the guide addressed to the library, the
// text in the body along with the song, the file it would become and the
// guide's link. A mailto link is a navigation, not a popup, so it may
// follow the await that brings the link up to date. Mail apps cap the
// length they take from a link, so a long guide travels by clipboard and
// the body says to paste it.
async function submitOffer(e) {
  e.preventDefault();
  if (!canOffer()) return ui.offerSheet.close();
  const checked = checkedOffer();
  if (!checked) return;
  const { draft, slug, text } = checked;
  ui.offerSheet.close();
  let notice = `Send the email your mail app opened, to ${OFFER_EMAIL}. The guide stays in this link meanwhile.`;
  await offerSent(draft, text, notice);
  const link = location.href.split('#')[0] + '#' + song.id + '&guide=' + guide.param;
  const head = `A guide for ${song.title}, for the library.\n\nSong: ${song.id}\nFile: guides/${song.id}/${slug}.yaml\nLink: ${link}\n\n`;
  let url = offerMailUrl(draft, head + text);
  if (url.length > OFFER_MAIL_MAX) {
    copyText(text);
    url = offerMailUrl(draft, head + '(The guide text is pasted below.)\n\n');
    notice = `The guide is too long for your mail app to take from a link, so its text is copied: paste it into the email, then send it to ${OFFER_EMAIL}.`;
    guide.notice = notice;
    renderGuide();
  }
  location.href = url;
}

function offerMailUrl(draft, body) {
  const q = new URLSearchParams({
    subject: `Guide: ${draft.title} (${song.title})`,
    body: body.replace(/\r?\n/g, '\r\n'),
  });
  // Mail apps read percent-encoding, not form encoding: spaces as %20.
  return `mailto:${OFFER_EMAIL}?${String(q).replace(/\+/g, '%20')}`;
}

function copyText(text) {
  let ok = false;
  try { navigator.clipboard.writeText(text).catch(() => {}); ok = true; } catch (_) { ok = copyViaSelection(text); }
  return ok;
}

function wireOfferSheet() {
  ui.offerSheet = document.getElementById('offer-sheet');
  ui.offerTitle = document.getElementById('offer-title');
  ui.offerBy = document.getElementById('offer-by');
  ui.offerUrl = document.getElementById('offer-url');
  ui.offerLang = document.getElementById('offer-lang');
  ui.offerText = document.getElementById('offer-text');
  ui.offerStatus = document.getElementById('offer-status');
  document.getElementById('offer-form').addEventListener('submit', submitOffer);
  document.getElementById('offer-cancel').addEventListener('click', () => ui.offerSheet.close());
  for (const el of [ui.offerTitle, ui.offerBy, ui.offerUrl, ui.offerLang]) {
    el.addEventListener('input', () => { setOfferStatus(''); renderOfferPreview(); });
  }
  ui.offerUrl.addEventListener('change', () => { ui.offerUrl.value = offerUrlRest(ui.offerUrl.value); renderOfferPreview(); });
  document.getElementById('offer-copy').addEventListener('click', () => {
    if (!guide) return;
    setOfferStatus(copyText(guideText(offerDraft())) ? 'Copied the guide text.' : 'Copying failed; select the text below instead.', '');
    ui.offerText.closest('details').open = true;
  });
}

// The mix sheet: a modal with one row per player, Mute and Solo as on the
// strips. What is chosen is heard at once, so with the passage looping the
// mix is auditioned as it is built. "Use this mix" keeps it for the tip
// being edited; Cancel (or Escape) restores what was playing before.
let sheetMix = null;   // { solo, mute } being chosen
let sheetBefore = null; // the mixer's state when the sheet opened
let sheetGains = {};
let sheetAccepted = false;
let sheetOnUse = null;

function openMixSheet(tip, onUse) {
  if (!tipEdit) return;
  sheetMix = { solo: [...tipEdit.solo], mute: [...tipEdit.mute] };
  sheetGains = tip.gains;
  sheetBefore = mixState();
  sheetAccepted = false;
  sheetOnUse = onUse;
  renderMixSheet();
  setMix({ ...sheetMix, gains: sheetGains });
  ui.mixSheet.showModal();
}

// Each row offers only what makes sense: while anything is soloed, Mute
// disappears (the unsoloed players are silent already); a soloed player
// shows just its lit Solo; otherwise Mute and Solo both show, and a muted
// player's lit Mute unmutes it. A tap on the row itself means Solo.
function renderMixSheet() {
  const rows = ui.mixSheetRows;
  rows.innerHTML = '';
  const anySolo = sheetMix.solo.length > 0;
  for (const s of STEMS) {
    const soloed = sheetMix.solo.includes(s.id);
    const muted = sheetMix.mute.includes(s.id);
    const row = document.createElement('div');
    row.className = 'sheet-row';
    row.classList.toggle('inactive', anySolo ? !soloed : muted);
    row.style.setProperty('--c', s.color);
    row.innerHTML = `<span class="who">${s.who}</span><span class="inst">${s.inst}</span>
      <button class="btn mute">Mute</button><button class="btn solo">Solo</button>`;
    const mute = row.querySelector('.mute');
    const solo = row.querySelector('.solo');
    mute.hidden = anySolo;
    mute.classList.toggle('on', muted);
    solo.classList.toggle('on', soloed);
    mute.addEventListener('click', e => { e.stopPropagation(); sheetToggle('mute', s.id); });
    solo.addEventListener('click', e => { e.stopPropagation(); sheetToggle('solo', s.id); });
    row.addEventListener('click', () => sheetToggle('solo', s.id));
    rows.appendChild(row);
  }
  ui.mixSheetFull.hidden = !sheetMix.solo.length && !sheetMix.mute.length;
}

// Mute and Solo exclude each other for a player.
function sheetToggle(key, id) {
  const list = sheetMix[key];
  const other = sheetMix[key === 'solo' ? 'mute' : 'solo'];
  const k = list.indexOf(id);
  if (k < 0) {
    list.push(id);
    const o = other.indexOf(id);
    if (o >= 0) other.splice(o, 1);
  } else {
    list.splice(k, 1);
  }
  renderMixSheet();
  setMix({ ...sheetMix, gains: sheetGains });
}

function wireMixSheet() {
  ui.mixSheet = document.getElementById('mix-sheet');
  ui.mixSheetRows = document.getElementById('mix-sheet-rows');
  ui.mixSheetFull = document.getElementById('mix-sheet-full');
  ui.mixSheetFull.addEventListener('click', () => {
    sheetMix = { solo: [], mute: [] };
    renderMixSheet();
    setMix({ ...sheetMix, gains: sheetGains });
  });
  document.getElementById('mix-sheet-use').addEventListener('click', () => {
    sheetAccepted = true;
    ui.mixSheet.close();
  });
  document.getElementById('mix-sheet-cancel').addEventListener('click', () => ui.mixSheet.close());
  // Closing by any route: keep or restore.
  ui.mixSheet.addEventListener('close', () => {
    if (sheetAccepted && tipEdit) {
      tipEdit.solo = sheetMix.solo;
      tipEdit.mute = sheetMix.mute;
      if (sheetOnUse) sheetOnUse();
    } else if (sheetBefore) {
      setMix(sheetBefore);
    }
    sheetMix = sheetBefore = sheetOnUse = null;
  });
  // A tap on the dim backdrop cancels.
  ui.mixSheet.addEventListener('click', e => { if (e.target === ui.mixSheet) ui.mixSheet.close(); });
}

// While a tip is edited, its mark on the seek bar follows the times being
// set, so start and end can be seen against the playhead.
function renderEditMark() {
  if (!guide || tipEdit === null) return;
  const mark = ui.marks.children[tipEdit.i];
  if (!mark) return;
  const end = tipEdit.to !== null ? tipEdit.to : (guide.tips[tipEdit.i + 1] && guide.tips[tipEdit.i + 1].at > tipEdit.at ? guide.tips[tipEdit.i + 1].at : duration);
  mark.classList.add('editing');
  mark.style.left = (tipEdit.at / duration * 100).toFixed(2) + '%';
  mark.style.width = 'max(2px, ' + ((end - tipEdit.at) / duration * 100).toFixed(2) + '%)';
}

// A passage looping while it is edited or auditioned from the list.
let loopRange = null; // { i, at, to }

// Loops a tip's passage with its mix; a start and end other than the tip's
// own let the tip editor preview times as typed.
function startLoop(i, at = guide.tips[i].at, to = guide.tips[i].to, mix = guide.tips[i]) {
  loopRange = { i, at, to };
  setMix(mix);
  seek(at);
  enterTip(i, false, false);
  if (!playing) play();
  renderGuideNow();
}

function stopLoop() {
  if (loopRange === null) return;
  loopRange = null;
  if (guide) renderGuideNow();
}

// Reordering by drag: the handle captures the pointer, the row follows it
// past its neighbours' midpoints, and the list's new order becomes the
// guide's when the pointer lifts.
function wireDrag(handle, li) {
  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    try { handle.setPointerCapture(e.pointerId); } catch (_) { /* no live pointer (synthetic event) */ }
    li.classList.add('dragging');
    const list = ui.guideTips;
    const move = ev => {
      const rows = Array.from(list.children);
      const cur = rows.indexOf(li);
      for (const row of rows) {
        if (row === li) continue;
        const r = row.getBoundingClientRect();
        const idx = rows.indexOf(row);
        if (idx < cur && ev.clientY < r.top + r.height / 2) { list.insertBefore(li, row); break; }
        if (idx > cur && ev.clientY > r.top + r.height / 2) { list.insertBefore(li, row.nextSibling); break; }
      }
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      li.classList.remove('dragging');
      guide.tips = Array.from(list.children).map(row => row.tip);
      tipsChanged();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
    handle.addEventListener('pointercancel', up, { once: true });
  });
}

// ---------- UI ----------

const ui = {};

function fmt(s) {
  s = Math.max(0, Math.floor(s));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function buildStrip(c, index) {
  const strip = document.createElement('div');
  strip.className = 'strip';
  strip.style.setProperty('--c', c.def.color);
  strip.innerHTML = `
    <div class="who">${c.def.who}</div>
    <div class="inst">${c.def.inst}</div>
    <div class="meter-fader">
      <div class="meter"><div class="meter-fill"></div></div>
      <div class="fader-wrap">
        <input class="fader" type="range" min="0" max="1.5" step="0.01" value="1" aria-label="${c.def.who} level">
      </div>
    </div>
    <div class="buttons">
      <button class="btn mute" title="Mute (shift+${index + 1})"><span class="short">M</span><span class="long">Mute</span></button>
      <button class="btn solo" title="Solo (${index + 1})"><span class="short">S</span><span class="long">Solo</span></button>
    </div>
  `;
  const fader = strip.querySelector('.fader');
  const mute = strip.querySelector('.mute');
  const solo = strip.querySelector('.solo');
  const meter = strip.querySelector('.meter-fill');

  fader.addEventListener('input', () => {
    c.fader.gain.setTargetAtTime(Number(fader.value), ctx.currentTime, 0.01);
  });
  fader.addEventListener('change', writeHash);
  mute.addEventListener('click', () => { c.mute = !c.mute; noteMixUsed(); applyMuteSolo(); });
  solo.addEventListener('click', () => { c.solo = !c.solo; noteMixUsed(); applyMuteSolo(); });

  c.ui = { strip, mute, solo, meter, fader };
  return strip;
}

const meterBuf = new Uint8Array(1024);
function tick() {
  if (channels.length) {
    const pos = position();
    if (!ui.seeking) ui.seek.value = Math.round(pos / duration * 1000);
    ui.cur.textContent = fmt(pos);
    guideTick(pos);

    for (const c of channels) {
      c.analyser.getByteTimeDomainData(meterBuf);
      let sum = 0;
      for (let i = 0; i < meterBuf.length; i++) {
        const v = (meterBuf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / meterBuf.length);
      // ~ -40 dB floor to 0 dB ceiling, mapped to 0..100%
      const db = 20 * Math.log10(rms || 1e-5);
      const pct = Math.max(0, Math.min(100, (db + 40) / 40 * 100));
      c.ui.meter.style.setProperty('--lvl', pct.toFixed(1) + '%');
    }
  }
  requestAnimationFrame(tick);
}

function wireTransport() {
  ui.play = document.getElementById('play');
  ui.seek = document.getElementById('seek');
  ui.cur = document.getElementById('time-cur');
  ui.dur = document.getElementById('time-dur');
  ui.share = document.getElementById('share');

  ui.play.addEventListener('click', () => playing ? pause() : play());
  ui.share.addEventListener('click', shareLink);
  ui.seek.addEventListener('pointerdown', () => { ui.seeking = true; });
  ui.seek.addEventListener('input', () => {
    ui.cur.textContent = fmt(ui.seek.value / 1000 * duration);
  });
  ui.seek.addEventListener('change', () => {
    ui.seeking = false;
    seek(ui.seek.value / 1000 * duration);
    writePosition();
    guideSync(true);
  });
  wireNudgeKeys();

  document.addEventListener('keydown', e => {
    if (isTyping(e.target) || sheetOpen()) return;
    if (e.target.tagName === 'INPUT') e.target.blur(); // a focused fader or the seek bar
    if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); openSongPicker(); return; }
    if (!channels.length) return;
    if (e.code === 'Space') { e.preventDefault(); playing ? pause() : play(); return; }
    if (e.code === 'KeyL' && !e.metaKey && !e.ctrlKey && !e.altKey) { shareLink(); return; }
    if (e.code === 'KeyN' && !e.metaKey && !e.ctrlKey && !e.altKey) { startTip(); return; }
    const n = Number(e.code.replace('Digit', ''));
    if (e.code.startsWith('Digit') && n >= 1 && n <= channels.length) {
      const c = channels[n - 1];
      if (e.shiftKey) c.mute = !c.mute; else c.solo = !c.solo;
      noteMixUsed();
      applyMuteSolo();
    }
  });
}

// Fallback for webviews that deny the Clipboard API: the legacy copy command
// still honors a recent click.
function copyViaSelection(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (_) { /* unsupported */ }
  ta.remove();
  return ok;
}

// Shares a link to the current mix at the current moment, so the position is
// committed to the hash first. Where the browser has a share sheet (iOS and
// Android, Safari and Chrome on the desktop) it opens with the link; the call
// has to happen inside the click or key gesture, before any await. Elsewhere
// the link is copied to the clipboard. Dismissing the sheet is not a failure.
let shareTimer = null;
async function shareLink() {
  if (!channels.length) return;
  writePosition();
  const url = location.href;
  if (navigator.share) {
    try {
      await navigator.share({ title: document.title, url });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  let ok = false;
  try {
    await navigator.clipboard.writeText(url);
    ok = true;
  } catch (_) {
    ok = copyViaSelection(url);
  }
  ui.share.classList.toggle('copied', ok);
  ui.share.classList.toggle('failed', !ok);
  clearTimeout(shareTimer);
  shareTimer = setTimeout(() => { ui.share.classList.remove('copied', 'failed'); }, 1500);
}

function renderHeader() {
  document.getElementById('title').textContent = song.title;
  // The date links to the recording the stems came from, when the song has one.
  const venue = document.getElementById('venue');
  venue.replaceChildren();
  if (song.source) {
    const a = document.createElement('a');
    a.className = 'source';
    a.href = song.source;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = song.date;
    venue.append(a);
  } else {
    venue.append(song.date);
  }
  venue.append(` · ${band.short_name || band.name} · ${song.venue} · ${song.city}`);
  document.title = `Split Open — ${song.title}`;
  renderGuideChips();
  renderUpNext();
  for (const row of document.querySelectorAll('.song-row')) {
    row.classList.toggle('on', row.dataset.id === song.id);
  }
  mediaSessionMetadata();
}

// ---------- song picker ----------
//
// The title is the picker: it opens a sheet listing every song grouped by
// band, with a search box that filters by title, band, venue, city or
// date. Picking one sets the hash, as the old chips did.

function renderSongList(filter = '') {
  const list = document.getElementById('song-list');
  list.innerHTML = '';
  const q = filter.trim().toLowerCase();
  const byBand = new Map();
  for (const s of listedSongs()) {
    const who = (bands[s.band] || {}).name || s.band;
    const hay = `${s.title} ${who} ${s.venue} ${s.city} ${s.date}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    if (!byBand.has(who)) byBand.set(who, []);
    byBand.get(who).push(s);
  }
  if (!byBand.size) {
    const none = document.createElement('p');
    none.className = 'song-none';
    none.textContent = 'No songs match.';
    list.appendChild(none);
    return;
  }
  for (const [who, group] of byBand) {
    const h = document.createElement('h3');
    h.className = 'song-band';
    h.textContent = who;
    list.appendChild(h);
    for (const s of group) {
      const row = document.createElement('button');
      row.className = 'song-row';
      row.dataset.id = s.id;
      row.classList.toggle('on', !!song && s.id === song.id);
      row.innerHTML = `<span class="song-title"></span><span class="song-where"></span>`;
      row.querySelector('.song-title').textContent = s.title;
      row.querySelector('.song-where').textContent = `${s.date} · ${s.venue}, ${s.city}`;
      row.addEventListener('click', () => {
        ui.songSheet.close();
        if (song && s.id === song.id) return;
        if (!leaveDraftOk()) return;
        location.hash = s.id;
      });
      list.appendChild(row);
    }
  }
}

function openSongPicker() {
  if (!songs.length || ui.songSheet.open) return;
  ui.songSearch.value = '';
  renderSongList();
  ui.songSheet.showModal();
  // showModal() focuses the first field, the search box. That is right
  // where a keyboard is at hand; on a phone it would raise the keyboard
  // over the list, so focus goes to the sheet itself instead.
  if (matchMedia('(hover: none) and (pointer: coarse)').matches) ui.songSheet.focus();
  else ui.songSearch.focus();
  const on = ui.songSheet.querySelector('.song-row.on');
  if (on) on.scrollIntoView({ block: 'center' });
}

function wireSongPicker() {
  ui.songSheet = document.getElementById('song-sheet');
  ui.songSearch = document.getElementById('song-search');
  document.getElementById('song-pick').addEventListener('click', openSongPicker);
  ui.songSearch.addEventListener('input', () => renderSongList(ui.songSearch.value));
  ui.songSheet.addEventListener('click', e => { if (e.target === ui.songSheet) ui.songSheet.close(); });
  // Up and Down walk the list (from the search box, Down goes to the first
  // song and Up to the last); Enter in the search box picks the first match.
  ui.songSheet.addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
    const rows = Array.from(ui.songSheet.querySelectorAll('.song-row'));
    if (!rows.length) return;
    const i = rows.indexOf(document.activeElement);
    if (e.key === 'Enter') {
      if (document.activeElement === ui.songSearch) { e.preventDefault(); rows[0].click(); }
      return;
    }
    e.preventDefault();
    let next;
    if (i < 0) next = e.key === 'ArrowDown' ? 0 : rows.length - 1;
    else next = (i + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
    rows[next].focus();
    rows[next].scrollIntoView({ block: 'nearest' });
  });
  // The row under the venue: the next song, and the whole list by count.
  const n = listedSongs().length;
  document.getElementById('upnext-count').textContent = `All ${n} songs`;
  document.getElementById('upnext-song').addEventListener('click', () => {
    if (leaveDraftOk()) mediaSessionStep(1);
  });
  document.getElementById('upnext-all').addEventListener('click', openSongPicker);
}

// Names the song after this one in the list; a song off the list (hidden)
// is followed by the first.
function renderUpNext() {
  const listed = listedSongs();
  const i = listed.findIndex(s => s.id === song.id);
  const next = listed[(i + 1) % listed.length];
  const row = document.getElementById('upnext');
  row.hidden = !next || next.id === song.id;
  if (!next) return;
  document.getElementById('upnext-title').textContent = next.title;
  const nextBand = bands[next.band] || {};
  document.getElementById('upnext-band').textContent = nextBand.short_name || nextBand.name || next.band;
}

// ---------- song switching ----------

// The stems a song has, in slot order: the ones its band lists, plus any the
// song adds for the night. A band without keys or drums lists neither, and
// the player neither shows nor fetches them. A song's entries override the
// band's (a guest sitting in on one stem).
function stemsFor(song, band = bands[song.band] || bands.phish || { channels: {} }) {
  const own = song.channels || {};
  return SLOTS.filter(slot => band.channels[slot.id] || own[slot.id]).map(slot => ({
    ...slot, who: slot.id, inst: '',
    ...(band.channels[slot.id] || {}),
    ...(own[slot.id] || {}),
  }));
}

async function loadSong(state) {
  const next = findSong(state.id);
  if (song && next.id === song.id) return;
  const token = ++loadToken;

  if (song) tipsSongChanged();
  closeGuide(false);
  teardownChannels();
  hashPos = null;
  song = next;
  band = bands[song.band] || bands.phish || { name: song.band, channels: {} };
  STEMS = stemsFor(song, band);
  renderHeader();
  loadRepoGuideMeta();
  setPlayButton(false);

  const mixer = document.getElementById('mixer');
  const loading = document.getElementById('loading');
  mixer.innerHTML = '';
  mixer.style.setProperty('--stems', STEMS.length);
  document.getElementById('help-solo-max').textContent = STEMS.length;
  mixer.hidden = true;
  document.getElementById('transport').hidden = true;
  loading.hidden = false;

  try {
    const m = await fetchMeta(song);
    if (token !== loadToken) return; // user switched songs mid-load
    meta = m;
    duration = meta.duration;
    // Only the segment under the playhead has to arrive before the mixer shows.
    const k0 = segIndex(state.t || 0);
    await loadFirstSegment(k0);
    if (token !== loadToken) return;
    STEMS.forEach((def, i) => {
      const c = buildChannel(def);
      channels.push(c);
      mixer.appendChild(buildStrip(c, i));
    });
    ui.dur.textContent = fmt(duration);
    ui.seek.value = 0;
    ui.cur.textContent = fmt(0);
    mediaSessionPosition();
    loading.hidden = true;
    mixer.hidden = false;
    document.getElementById('transport').hidden = false;
    applyMixState(state);
    keepWindow(segIndex(offset));
    fillBytes(token);
    syncGuide(state);
    tipsSongReady();
    warmOtherSongs(song);
  } catch (err) {
    if (token !== loadToken) return;
    document.getElementById('loading-label').textContent = 'Failed to load stems: ' + err.message;
    console.error(err);
  }
}

// ---------- boot ----------

(async () => {
  wireTransport();
  wireTips();
  wireGuide();
  wireMixSheet();
  wireOfferSheet();
  mediaSessionInstall();
  tick();
  try {
    [songs, bands, repoGuides] = await Promise.all([
      fetchYaml('songs.yaml'),
      fetchYaml('bands.yaml'),
      fetch('guides.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : {})).catch(() => ({})),
    ]);
  } catch (err) {
    document.getElementById('loading-label').textContent = 'Failed to load song list: ' + err.message;
    return;
  }
  wireSongPicker();
  const fromHash = () => loadSong(parseHash());
  window.addEventListener('hashchange', () => {
    // Our own replaceState writes never fire this, so it is a song click, a
    // Back/Forward step, or a hand-edited URL. A same-song change only has
    // to apply the mix; only a new song id loads stems.
    const state = parseHash();
    if (song && channels.length && findSong(state.id).id === song.id) {
      applyMixState(state);
      return syncGuide(state);
    }
    fromHash();
  });
  fromHash();
})();
