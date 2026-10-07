// Split Open — multi-stem player built on the Web Audio API.
// All stems are decoded up front and started on the same AudioContext clock,
// so they stay sample-locked; mute/solo/fader are just gain changes.
//
// Switching songs is kept cheap three ways: the context runs at the stems'
// native 48 kHz so decoding skips a resample, decoded songs stay in a
// memory-bounded cache, and the other songs are fetched (and, budget
// permitting, decoded) in the background once the current one is ready.

// Fixed stem slots; who plays each one comes from bands.json per song.
const SLOTS = [
  { id: 'guitar', file: 'guitar.opus', color: 'var(--trey)' },
  { id: 'bass',   file: 'bass.opus',   color: 'var(--mike)' },
  { id: 'keys',   file: 'keys.opus',   color: 'var(--page)' },
  { id: 'drums',  file: 'drums.opus',  color: 'var(--fish)' },
  { id: 'vocals', file: 'vocals.opus', color: 'var(--vox)' },
];
let STEMS = SLOTS;
const STEM_FILES = SLOTS.map(s => s.file);

// The stems are Opus, which always decodes at 48 kHz. Matching the context
// rate avoids resampling every stem on decode, which is roughly 3x slower
// than decoding alone.
const STEM_RATE = 48000;
const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: STEM_RATE });
const master = ctx.createGain();
master.connect(ctx.destination);

// iOS Safari gives a tab on the order of 1 GB before killing it, and a single
// 8-minute song decodes to ~920 MB of PCM. It also doesn't report
// deviceMemory. Treat touch devices that don't report memory as constrained:
// no decoded-song cache, no background decoding, one stem decoded at a time,
// and a real page reload on song switch so the old song's buffers are freed
// before the new one is decoded (GC timing is otherwise not ours to control).
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
let channels = []; // { def, buffer, fader, muteGain, analyser, source?, ui }
let playing = false;
let startedAt = 0;   // ctx.currentTime when playback started
let offset = 0;      // position (s) at which playback started
let duration = 0;
let loadToken = 0;   // guards against a stale load finishing after a song switch

// ---------- loading ----------

async function fetchStem(url, onProgress, priority) {
  const res = await fetch(url, { priority });
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

// Compressed stems, keyed by song id. ~8 MB per stem, so every song fits.
const byteCache = new Map();   // id -> Promise<ArrayBuffer[]>
const bytesReady = new Set();  // ids whose fetch has finished

function fetchSongBytes(s, onProgress, priority = 'high') {
  if (!byteCache.has(s.id)) {
    const p = Promise.all(STEM_FILES.map((file, i) =>
      fetchStem(s.dir + file, onProgress && (f => onProgress(i, f)), priority)
    ));
    p.then(() => bytesReady.add(s.id), () => byteCache.delete(s.id));
    byteCache.set(s.id, p);
  }
  return byteCache.get(s.id);
}

// Decoded stems: ~185 MB per stem for an 8-minute song, so the cache has a
// byte budget of a quarter of device memory, capped at 2 GB. Browsers that
// don't report memory (Safari) are assumed to be small. The song playing now
// is always kept; beyond that, least recently used songs are dropped.
const decodedCache = new Map(); // id -> Promise<AudioBuffer[]>; insertion order = LRU
const decodedBytes = new Map(); // id -> bytes once decoded
const DECODE_BUDGET = LOW_MEMORY ? 0 : Math.min(2048, (navigator.deviceMemory || 2) * 256) * 1024 * 1024;

function bufferBytes(buffers) {
  return buffers.reduce((n, b) => n + b.length * b.numberOfChannels * 4, 0);
}

function cachedBytesTotal() {
  let n = 0;
  for (const v of decodedBytes.values()) n += v;
  return n;
}

function touchDecoded(id) {
  const p = decodedCache.get(id);
  decodedCache.delete(id);
  decodedCache.set(id, p);
}

function evictDecoded(keepId) {
  for (const id of decodedCache.keys()) {
    if (cachedBytesTotal() <= DECODE_BUDGET) return;
    if (id === keepId || (song && id === song.id) || !decodedBytes.has(id)) continue;
    decodedCache.delete(id);
    decodedBytes.delete(id);
  }
}

function decodeSong(s, onProgress, priority) {
  if (decodedCache.has(s.id)) {
    touchDecoded(s.id);
    return decodedCache.get(s.id);
  }
  const p = (async () => {
    const bytes = await fetchSongBytes(s, onProgress, priority);
    // decodeAudioData detaches its input, so decode a copy and keep the bytes.
    // Parallel decoding is faster where there's a thread pool (Chrome), but
    // on a phone five decoders' scratch space at once is what tips it over.
    let buffers;
    if (LOW_MEMORY) {
      buffers = [];
      for (const b of bytes) buffers.push(toMono(await ctx.decodeAudioData(b.slice(0))));
    } else {
      buffers = await Promise.all(bytes.map(b => ctx.decodeAudioData(b.slice(0))));
    }
    decodedBytes.set(s.id, bufferBytes(buffers));
    evictDecoded(s.id);
    return buffers;
  })();
  p.catch(() => { decodedCache.delete(s.id); decodedBytes.delete(s.id); });
  decodedCache.set(s.id, p);
  return p;
}

async function loadAllStems(s) {
  const fill = document.getElementById('loading-fill');
  const label = document.getElementById('loading-label');
  const haveBytes = bytesReady.has(s.id);
  label.textContent = haveBytes ? 'Decoding…' : 'Loading stems…';
  fill.style.width = haveBytes ? '100%' : '0%';
  const progress = new Array(STEM_FILES.length).fill(0);
  const buffers = await decodeSong(s, (i, f) => {
    progress[i] = f;
    const pct = progress.reduce((a, b) => a + b, 0) / progress.length * 100;
    fill.style.width = pct.toFixed(1) + '%';
    if (pct >= 100) label.textContent = 'Decoding…';
  });
  return buffers;
}

// Warm the other songs in the background: fetch bytes for all of them, and
// pre-decode as many as the memory budget allows, nearest in the list first.
let warmToken = 0;
async function warmOtherSongs(current) {
  const token = ++warmToken;
  if (LOW_MEMORY) return;
  if (navigator.connection && navigator.connection.saveData) return;
  const i = songs.findIndex(s => s.id === current.id);
  const order = [];
  for (let d = 1; d < songs.length; d++) {
    order.push(songs[(i + d) % songs.length]);
  }
  for (const s of order) {
    if (token !== warmToken) return;
    try {
      const bytes = await fetchSongBytes(s, null, 'low');
      if (token !== warmToken) return;
      const est = bytes.reduce((n, b) => n + estimateDecodedBytes(b), 0);
      if (cachedBytesTotal() + est <= DECODE_BUDGET) await decodeSong(s, null, 'low');
    } catch (err) {
      console.warn('warm failed', s.id, err);
    }
  }
}

// On constrained devices each stem is folded to mono right after decoding,
// which halves what a song costs to keep around (~920 MB -> ~460 MB for an
// 8-minute song). The phone speaker is mono anyway; headphones lose the
// stereo image of the separated stems, which is a fair trade for not crashing.
function toMono(buf) {
  const n = buf.numberOfChannels;
  if (n === 1) return buf;
  const mono = ctx.createBuffer(1, buf.length, buf.sampleRate);
  const out = mono.getChannelData(0);
  for (let ch = 0; ch < n; ch++) {
    const src = buf.getChannelData(ch);
    for (let i = 0; i < out.length; i++) out[i] += src[i] / n;
  }
  return mono;
}

// Rough decoded size from the compressed size: 128 kbps stereo Opus decoded
// to Float32 at 48 kHz expands by 24x (48000 * 2 ch * 4 bytes * 8 / 128000).
// Opus is variable bit rate, so a mostly silent stem comes in well under
// 128 kbps and this undershoots for it; the cache itself counts real sizes.
function estimateDecodedBytes(arrayBuffer) {
  return arrayBuffer.byteLength * 24;
}

// ---------- graph ----------

function buildChannel(def, buffer) {
  const fader = ctx.createGain();
  const muteGain = ctx.createGain();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.6;

  fader.connect(muteGain);
  muteGain.connect(analyser);
  analyser.connect(master);

  return { def, buffer, fader, muteGain, analyser, source: null, mute: false, solo: false };
}

function teardownChannels() {
  clearSoloHint();
  stopSources();
  keepaliveStop();
  for (const c of channels) c.analyser.disconnect();
  channels = [];
  playing = false;
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

function findSong(id) {
  return songs.find(s => s.id === id) || songs[0];
}

function parseStemList(val) {
  const slotIds = SLOTS.map(slot => slot.id);
  return val.split(',').filter(id => slotIds.includes(id));
}

function parseGains(val) {
  const slotIds = SLOTS.map(slot => slot.id);
  const gains = {};
  for (const item of val.split(',')) {
    const [id, v] = item.split(':');
    const n = Number(v);
    if (slotIds.includes(id) && Number.isFinite(n)) gains[id] = Math.max(0, Math.min(GAIN_MAX, n));
  }
  return gains;
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

function buildHash() {
  const parts = [song.id];
  const solo = channels.filter(c => c.solo).map(c => c.def.id);
  const mute = channels.filter(c => c.mute).map(c => c.def.id);
  const gains = channels
    .map(c => [c.def.id, Number(c.ui.fader.value)])
    .filter(([, g]) => g !== 1)
    .map(([id, g]) => id + ':' + g);
  if (solo.length) parts.push('solo=' + solo.join(','));
  if (mute.length) parts.push('mute=' + mute.join(','));
  if (gains.length) parts.push('g=' + gains.join(','));
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

// ---------- transport ----------

// Sources start 50 ms after play(), so for that moment the clock reads a
// little behind the start offset; clamp so the position never steps back.
function position() {
  return playing ? Math.max(offset, Math.min(duration, offset + ctx.currentTime - startedAt)) : offset;
}

function startSources(from) {
  const t0 = ctx.currentTime + 0.05;
  for (const c of channels) {
    const src = ctx.createBufferSource();
    src.buffer = c.buffer;
    src.connect(c.fader);
    src.start(t0, from);
    c.source = src;
  }
  // Any one source ending naturally means the track is over.
  channels[0].source.onended = () => {
    if (playing && position() >= duration - 0.05) stop(0);
  };
  startedAt = t0;
  offset = from;
  playing = true;
}

function stopSources() {
  for (const c of channels) {
    if (!c.source) continue;
    c.source.onended = null;
    try { c.source.stop(); } catch (_) { /* already stopped */ }
    c.source.disconnect();
    c.source = null;
  }
}

function setPlayButton(on) {
  ui.play.classList.toggle('playing', on);
  ui.play.setAttribute('aria-label', on ? 'Pause' : 'Play');
  updateHints();
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
  keepaliveStop();
  guideWaiting = false;
  setPlayButton(false);
  writePosition();
}

function stop(at) {
  stopSources();
  playing = false;
  offset = at;
  keepaliveStop();
  setPlayButton(false);
}

function seek(to) {
  const wasPlaying = playing;
  stopSources();
  playing = false;
  offset = Math.max(0, Math.min(duration, to));
  if (wasPlaying) startSources(offset);
  ui.seek.value = Math.round(offset / duration * 1000);
  ui.cur.textContent = fmt(offset);
  keepaliveSeek(offset);
  mediaSessionPosition();
}

// Left and Right arrows step the playhead 5 s either way, through seek() so
// the play state is kept. preventDefault stops a focused fader or the seek
// bar from stepping as well.
function wireNudgeKeys() {
  document.addEventListener('keydown', e => {
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
  if (!song || !songs.length) return;
  const i = songs.findIndex(s => s.id === song.id);
  location.hash = songs[(i + dir + songs.length) % songs.length].id;
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
// A guide is a listening tour of a song: an ordered list of stops, each a
// moment, a mix, and a note. The mix holds from the stop until the next one.
// When the playhead crosses into a stop its note is shown; a stop marked
// `pause` also stops the music until the listener presses Continue. The text
// form is the format:
//
//   lang: en
//   title: Spotlight
//   by: Moshe Weitzman
//   url: https://weitzman.github.io
//   0:00 solo=drums | Fish alone on drums.
//   0:30 solo=drums,bass pause | Mike joins. Listen for the push and pull.
//   1:00 | Everyone back in.
//
// Header lines are `key: value` (title, lang, by, url; lang is the notes'
// language code, which the page passes on to the browser; by and url name
// and link the author). Stop lines start with
// m:ss, then any of solo=, mute=, g= (as in the hash), to=m:ss (where the
// stop ends, when not at the next stop; a later stop may start earlier, which
// is how a passage is replayed) and pause, then `|` and the note. A stop with
// no mix keys brings everyone back. The hash carries a guide as
// guide=<name> for a built-in template, or guide=z<base64url of the deflated
// text> for one written by hand; SplitOpen.guideLink(text) in the console
// makes such a link.

const GUIDE_TEMPLATES = {
  spotlight: {
    title: 'Spotlight',
    lang: 'en',
    by: 'Moshe Weitzman',
    url: 'https://weitzman.github.io',
    build() {
      const order = ['drums', 'bass', 'keys', 'guitar', 'vocals'];
      const stems = order.map(id => STEMS.find(s => s.id === id)).filter(Boolean);
      const seg = Math.max(10, Math.min(30, Math.floor(duration / (stems.length + 1))));
      const alone = s => s.id === 'vocals' ? 'Just the vocals.' : `${s.who} alone on ${s.inst.toLowerCase()}.`;
      const stops = stems.map((s, i) => ({ ...emptyStop(i * seg), solo: [s.id], note: alone(s) }));
      stops[0].note = `Each player alone in turn, then everyone together. First, ${alone(stems[0]).replace(/\.$/, '')}. `
        + 'Listen for how the kick and snare lock to the hi-hat, where the fills land against the bar line, '
        + 'and how the tempo breathes between sections. With nothing else in the way, the drums tell you '
        + 'where the band is headed before anyone else does.';
      stops.push({ ...emptyStop(stems.length * seg), note: 'Everyone back in.' });
      return stops;
    },
  },
};

function emptyStop(at) {
  return { at, to: null, solo: [], mute: [], gains: {}, pause: false, note: '' };
}

function parseClock(s) {
  const m = /^(\d+):(\d{2}(?:\.\d+)?)$/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function parseGuideText(text) {
  const g = { title: '', lang: '', by: '', url: '', stops: [] };
  for (let line of text.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(\d+:\d{2}(?:\.\d+)?)\s*([^|]*)(?:\|\s*(.*))?$/.exec(line);
    if (!m) {
      const h = /^(title|lang|by|url):\s*(.*)$/i.exec(line);
      if (h) g[h[1].toLowerCase()] = h[2].trim();
      continue;
    }
    const stop = emptyStop(parseClock(m[1]));
    stop.note = (m[3] || '').trim();
    for (const tok of m[2].trim().split(/\s+/).filter(Boolean)) {
      const eq = tok.indexOf('=');
      const key = eq < 0 ? tok : tok.slice(0, eq);
      const val = eq < 0 ? '' : tok.slice(eq + 1);
      if (key === 'solo' || key === 'mute') stop[key] = parseStemList(val);
      else if (key === 'g') stop.gains = parseGains(val);
      else if (key === 'to') stop.to = parseClock(val);
      else if (key === 'pause') stop.pause = true;
    }
    g.stops.push(stop);
  }
  return g;
}

// deflate + base64url, so a hand-written guide fits in a link: a dozen stops
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

let guideParam = null;  // the hash's guide=, kept while the guide itself loads
let guide = null;       // { param, title, lang, stops }
let guideIndex = -1;    // the stop the playhead is in; -1 before the first
let guideWaiting = false; // paused by a `pause` stop, waiting for Continue

async function resolveGuide(param) {
  const tpl = GUIDE_TEMPLATES[param];
  if (tpl) return { param, title: tpl.title, lang: tpl.lang, by: tpl.by || '', url: tpl.url || '', stops: tpl.build() };
  const g = parseGuideText(await decodeGuide(param));
  if (!/^https?:\/\//i.test(g.url)) g.url = ''; // only web links, never javascript:
  return { param, title: g.title || 'Guide', lang: g.lang || 'en', by: g.by, url: g.url, stops: g.stops };
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
    g = { param: want, title: 'Guide', lang: 'en', by: '', url: '', stops: [], error: 'This link holds a guide this browser cannot read.' };
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
  guideWaiting = false;
  guide = null;
  guideParam = null;
  guideIndex = -1;
  ui.guide.hidden = true;
  ui.marks.innerHTML = '';
  renderGuideChips();
  if (write) writeHash();
}

function setGuide(param) {
  syncGuide({ guide: param });
}

function guideEnd(i) {
  const stops = guide.stops;
  if (stops[i].to !== null) return stops[i].to;
  const next = stops[i + 1];
  return next && next.at > stops[i].at ? next.at : duration;
}

function inStop(i, pos) {
  return pos >= guide.stops[i].at && pos < guideEnd(i);
}

// After the listener moves the playhead: find the stop that holds it, keeping
// the current one when it still does, and enter it. Landing at a stop's start
// counts as arriving there (so a `pause` stop pauses); landing inside it does
// not.
function guideSync(arrive) {
  if (!guide || !guide.stops.length) return;
  guideWaiting = false;
  const pos = position();
  const stops = guide.stops;
  let i = guideIndex >= 0 && inStop(guideIndex, pos) ? guideIndex : stops.findIndex((s, k) => inStop(k, pos));
  if (i < 0) for (let k = 0; k < stops.length; k++) if (stops[k].at <= pos) i = k;
  if (i < 0) { guideIndex = -1; renderGuideNow(); return; }
  if (i !== guideIndex) enterStop(i, arrive && pos - stops[i].at < 1.5);
  else renderGuideNow();
}

// Each frame while playing: once the current stop has run out, move to the
// next one, jumping to it when it starts elsewhere.
function guideTick(pos) {
  if (!guide || !playing || !guide.stops.length) return;
  const stops = guide.stops;
  if (guideIndex >= 0 && pos < stops[guideIndex].at - 0.1) return guideSync(true);
  if (guideIndex >= 0 && pos < guideEnd(guideIndex)) return;
  const next = guideIndex + 1;
  if (next >= stops.length || pos < stops[next].at - 0.25) return;
  if (Math.abs(pos - stops[next].at) > 0.5) seek(stops[next].at);
  enterStop(next, true);
}

// On Play: find the stop under the playhead, since the song may have been
// started over from the top.
function guideResume() {
  guideSync(false);
}

// Applies the stop's mix and shows its note. `arrive` means the playhead has
// just reached the stop (as opposed to the guide being opened or the playhead
// dropped somewhere inside it), which is when a `pause` stop pauses.
function enterStop(i, arrive) {
  const stop = guide.stops[i];
  guideIndex = i;
  for (const c of channels) {
    c.solo = stop.solo.includes(c.def.id);
    c.mute = stop.mute.includes(c.def.id);
    const g = stop.gains[c.def.id] ?? 1;
    c.ui.fader.value = g;
    c.fader.gain.setTargetAtTime(g, ctx.currentTime, 0.01);
  }
  applyMuteSolo();
  if (arrive && stop.pause && playing) {
    pause();
    guideWaiting = true;
  }
  renderGuideNow();
}

function guideMixLabel(stop) {
  const names = ids => ids.map(id => (STEMS.find(s => s.id === id) || {}).who || id).join(', ');
  if (stop.solo.length) return 'Solo ' + names(stop.solo);
  if (stop.mute.length) return 'Mute ' + names(stop.mute);
  return 'Full mix';
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
  ui.guide.hidden = false;
  ui.guide.lang = guide.lang; // the notes' language, for screen readers and hyphenation
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
  ui.guideStops.innerHTML = '';
  ui.marks.innerHTML = '';
  guide.stops.forEach((stop, i) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'stop';
    const time = document.createElement('time');
    time.textContent = fmt(stop.at);
    const text = document.createElement('span');
    text.className = 'note';
    const more = document.createElement('button');
    more.className = 'more';
    renderNote(text, more, stop.note || guideMixLabel(stop), 2);
    wireMore(text, more);
    btn.append(time, text);
    btn.addEventListener('click', () => {
      guideWaiting = false;
      seek(stop.at);
      writePosition();
      enterStop(i, true);
    });
    li.append(btn, more);
    ui.guideStops.appendChild(li);

    const mark = document.createElement('i');
    mark.style.left = (stop.at / duration * 100).toFixed(2) + '%';
    mark.title = fmt(stop.at) + '  ' + (stop.note || guideMixLabel(stop));
    mark.addEventListener('click', () => btn.click());
    ui.marks.appendChild(mark);
  });
  renderGuideChips();
  renderGuideNow();
}

// The current stop is highlighted in the list and shown in full; the others
// are clamped (the listener can still open any of them with "more").
function renderGuideNow() {
  if (!guide) return;
  ui.guideStatus.textContent = guide.error || '';
  ui.guideStatus.hidden = !guide.error;
  ui.guideContinue.hidden = !guideWaiting;
  Array.from(ui.guideStops.children).forEach((li, i) => {
    const on = i === guideIndex;
    if (on === li.classList.contains('on')) return;
    li.classList.toggle('on', on);
    const note = li.querySelector('.note');
    const more = li.querySelector('.more');
    if (on) {
      note.classList.remove('clamp');
      more.hidden = true;
    } else {
      renderNote(note, more, note.textContent, 2);
    }
  });
  Array.from(ui.marks.children).forEach((mark, i) => mark.classList.toggle('on', i === guideIndex));
  // Keep the current stop in view within the list only; scrollIntoView
  // would drag the whole page along on a phone.
  const list = ui.guideStops;
  const on = list.children[guideIndex];
  if (on) {
    if (on.offsetTop < list.scrollTop) list.scrollTop = on.offsetTop;
    else if (on.offsetTop + on.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = on.offsetTop + on.offsetHeight - list.clientHeight;
    }
  }
}

// The chips under the song list, in the song chips' style with the author
// where the band would be: one per built-in template, plus the open guide
// when it arrived in the link.
function renderGuideChips() {
  const row = document.getElementById('guides');
  row.innerHTML = '';
  if (!song) return;
  const label = document.createElement('span');
  label.className = 'guides-label';
  label.textContent = 'Guides';
  row.appendChild(label);
  const entries = Object.entries(GUIDE_TEMPLATES).map(([param, tpl]) => ({ param, title: tpl.title, by: tpl.by }));
  if (guide && !GUIDE_TEMPLATES[guide.param]) entries.push(guide);
  for (const { param, title, by } of entries) {
    const btn = document.createElement('button');
    btn.className = 'song chip';
    btn.textContent = title;
    if (by) {
      const small = document.createElement('small');
      small.textContent = by;
      btn.appendChild(small);
    }
    btn.classList.toggle('on', !!guide && guide.param === param);
    btn.addEventListener('click', () => {
      if (!channels.length) return;
      if (guide && guide.param === param) closeGuide();
      else setGuide(param);
    });
    row.appendChild(btn);
  }
}

function wireGuide() {
  ui.guide = document.getElementById('guide');
  ui.guideTitle = document.getElementById('guide-title');
  ui.guideStatus = document.getElementById('guide-status');
  ui.guideStops = document.getElementById('guide-stops');
  ui.guideContinue = document.getElementById('guide-continue');
  ui.marks = document.getElementById('marks');
  ui.guideContinue.addEventListener('click', () => { guideWaiting = false; play(); });
  document.getElementById('guide-close').addEventListener('click', () => closeGuide());
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
    if (e.target.tagName === 'INPUT') e.target.blur();
    if (!channels.length) return;
    if (e.code === 'Space') { e.preventDefault(); playing ? pause() : play(); return; }
    if (e.code === 'KeyL' && !e.metaKey && !e.ctrlKey && !e.altKey) { shareLink(); return; }
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
  document.getElementById('venue').textContent = `${song.date} · ${song.venue} · ${song.city}`;
  document.title = `Split Open — ${song.title}`;
  renderGuideChips();
  for (const btn of document.querySelectorAll('.song.in-list')) {
    btn.classList.toggle('on', btn.dataset.id === song.id);
  }
  mediaSessionMetadata();
}

function renderSongList() {
  const nav = document.getElementById('songs');
  nav.innerHTML = '';
  for (const s of songs) {
    const btn = document.createElement('button');
    btn.className = 'song in-list';
    btn.dataset.id = s.id;
    const who = (bands[s.band] || {}).name || s.band;
    btn.innerHTML = `${s.title}<small>${who}</small>`;
    btn.addEventListener('click', () => {
      if (song && s.id === song.id) return;
      location.hash = s.id;
    });
    nav.appendChild(btn);
  }
}

// ---------- song switching ----------

async function loadSong(state) {
  const next = findSong(state.id);
  if (song && next.id === song.id) return;
  const token = ++loadToken;

  closeGuide(false);
  teardownChannels();
  hashPos = null;
  song = next;
  band = bands[song.band] || bands.phish || { name: song.band, channels: {} };
  // Band layout, then per-song overrides (e.g. a guest sitting in on one stem).
  STEMS = SLOTS.map(slot => ({
    ...slot, who: slot.id, inst: '',
    ...(band.channels[slot.id] || {}),
    ...((song.channels || {})[slot.id] || {}),
  }));
  renderHeader();
  setPlayButton(false);

  const mixer = document.getElementById('mixer');
  const loading = document.getElementById('loading');
  mixer.innerHTML = '';
  mixer.hidden = true;
  document.getElementById('transport').hidden = true;
  loading.hidden = false;

  try {
    const buffers = await loadAllStems(song);
    if (token !== loadToken) return; // user switched songs mid-load
    duration = Math.max(...buffers.map(b => b.duration));
    buffers.forEach((buf, i) => {
      const c = buildChannel(STEMS[i], buf);
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
    syncGuide(state);
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
  wireGuide();
  mediaSessionInstall();
  tick();
  try {
    [songs, bands] = await Promise.all([
      fetch('songs.json', { cache: 'no-cache' }).then(r => r.json()),
      fetch('bands.json', { cache: 'no-cache' }).then(r => r.json()),
    ]);
  } catch (err) {
    document.getElementById('loading-label').textContent = 'Failed to load song list: ' + err.message;
    return;
  }
  renderSongList();
  const fromHash = () => loadSong(parseHash());
  window.addEventListener('hashchange', () => {
    // Our own replaceState writes never fire this, so it is a song click, a
    // Back/Forward step, or a hand-edited URL. A same-song change only has
    // to apply the mix; only a new song id loads stems (or reloads the page).
    const state = parseHash();
    if (song && channels.length && findSong(state.id).id === song.id) {
      applyMixState(state);
      return syncGuide(state);
    }
    if (!(LOW_MEMORY && song)) return fromHash();
    // Drop every reference to the old song's PCM before the reload. Safari
    // keeps the same process across a reload and collects the old page's
    // heap lazily, so the less we leave behind the better.
    teardownChannels();
    decodedCache.clear();
    decodedBytes.clear();
    byteCache.clear();
    bytesReady.clear();
    ctx.close().catch(() => {});
    location.reload();
  });
  fromHash();
})();
