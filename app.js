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
// The hash is rewritten with replaceState so Back still returns to the
// previous song rather than stepping through every mute.

const GAIN_MAX = 1.5;
let hashPos = null; // position (s) last written to the hash; null means none

function findSong(id) {
  return songs.find(s => s.id === id) || songs[0];
}

function parseHash() {
  const [idPart, ...pairs] = location.hash.slice(1).split('&');
  const state = { id: decodeURIComponent(idPart), solo: [], mute: [], gains: {}, t: null };
  const slotIds = SLOTS.map(slot => slot.id);
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const key = pair.slice(0, eq);
    const val = decodeURIComponent(pair.slice(eq + 1));
    if (key === 'solo' || key === 'mute') {
      state[key] = val.split(',').filter(id => slotIds.includes(id));
    } else if (key === 'g') {
      for (const item of val.split(',')) {
        const [id, v] = item.split(':');
        const n = Number(v);
        if (slotIds.includes(id) && Number.isFinite(n)) {
          state.gains[id] = Math.max(0, Math.min(GAIN_MAX, n));
        }
      }
    } else if (key === 't') {
      const n = Number(val);
      if (Number.isFinite(n) && n >= 0) state.t = n;
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

function position() {
  return playing ? Math.min(duration, offset + ctx.currentTime - startedAt) : offset;
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
  // Safari also reports 'interrupted' (phone call, backgrounding); resume covers both.
  if (ctx.state !== 'running') await ctx.resume();
  if (offset >= duration) offset = 0;
  startSources(offset);
  setPlayButton(true);
}

function pause() {
  offset = position();
  stopSources();
  playing = false;
  keepaliveStop();
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
  });
}

// ---------- media session ----------
// Lock-screen, media-hub, headphone and keyboard media-key controls. All of
// these go through navigator.mediaSession, which browsers only surface while a
// media element is playing; on iOS that is the keep-alive element above.

const MEDIA_ACTIONS = {
  play: () => play(),
  pause: () => pause(),
  seekbackward: d => seek(position() - ((d && d.seekOffset) || 10)),
  seekforward: d => seek(position() + ((d && d.seekOffset) || 10)),
  seekto: d => { if (d && typeof d.seekTime === 'number') seek(d.seekTime); },
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
  for (const btn of document.querySelectorAll('.song')) {
    btn.classList.toggle('on', btn.dataset.id === song.id);
  }
  mediaSessionMetadata();
}

function renderSongList() {
  const nav = document.getElementById('songs');
  nav.innerHTML = '';
  for (const s of songs) {
    const btn = document.createElement('button');
    btn.className = 'song';
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
    if (song && channels.length && findSong(state.id).id === song.id) return applyMixState(state);
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
