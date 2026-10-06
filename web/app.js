// Split Open — multi-stem player built on the Web Audio API.
// All stems are decoded up front and started on the same AudioContext clock,
// so they stay sample-locked; mute/solo/fader are just gain changes.
//
// Switching songs is kept cheap three ways: the context runs at the stems'
// native 44.1 kHz so decoding skips a resample, decoded songs stay in a
// memory-bounded cache, and the other songs are fetched (and, budget
// permitting, decoded) in the background once the current one is ready.

// Fixed stem slots; who plays each one comes from bands.json per song.
const SLOTS = [
  { id: 'guitar', file: 'guitar.mp3', color: 'var(--trey)' },
  { id: 'bass',   file: 'bass.mp3',   color: 'var(--mike)' },
  { id: 'keys',   file: 'keys.mp3',   color: 'var(--page)' },
  { id: 'drums',  file: 'drums.mp3',  color: 'var(--fish)' },
  { id: 'vocals', file: 'vocals.mp3', color: 'var(--vox)' },
];
let STEMS = SLOTS;
const STEM_FILES = SLOTS.map(s => s.file);

// The stems are 44.1 kHz MP3s. Matching the context rate avoids resampling
// every stem on decode, which is roughly 3x slower than decoding alone.
const STEM_RATE = 44100;
const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: STEM_RATE });
const master = ctx.createGain();
master.connect(ctx.destination);

// iOS Safari gives a tab on the order of 1 GB before killing it, and a single
// 8-minute song decodes to ~850 MB of PCM. It also doesn't report
// deviceMemory. Treat touch devices that don't report memory as constrained:
// no decoded-song cache, no background decoding, one stem decoded at a time,
// and a real page reload on song switch so the old song's buffers are freed
// before the new one is decoded (GC timing is otherwise not ours to control).
const LOW_MEMORY = !navigator.deviceMemory && navigator.maxTouchPoints > 1;

// iOS routes Web Audio through the "ambient" audio session, which obeys the
// ring/silent switch, so the graph runs but nothing comes out of the speaker.
// Media elements use the "playback" session instead. On iOS 17+ we can ask for
// that session directly; on older iOS, keeping a silent <audio> element playing
// alongside the graph has the same effect.
if (navigator.audioSession) {
  try { navigator.audioSession.type = 'playback'; } catch (_) { /* unsupported value */ }
}

function silentWavUrl() {
  const rate = 8000, frames = rate / 2; // half a second of silence
  const buf = new ArrayBuffer(44 + frames * 2);
  const v = new DataView(buf);
  const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + frames * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, frames * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

let keepalive = null;
function keepaliveStart() {
  if (navigator.audioSession) return;
  if (!keepalive) {
    keepalive = new Audio(silentWavUrl());
    keepalive.loop = true;
    keepalive.setAttribute('playsinline', '');
  }
  keepalive.play().catch(() => { /* not allowed outside a gesture; harmless */ });
}
function keepaliveStop() {
  if (keepalive) keepalive.pause();
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

// Compressed stems, keyed by song id. ~10 MB per stem, so every song fits.
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

// Decoded stems: ~170 MB per stem for an 8-minute song, so the cache has a
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
// which halves what a song costs to keep around (~850 MB -> ~425 MB for an
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

// Rough decoded size from the compressed size: 192 kbps stereo MP3 at 44.1 kHz
// expands by ~14.7x (16-bit PCM is 7.35x, Float32 doubles it).
function estimateDecodedBytes(arrayBuffer) {
  return arrayBuffer.byteLength * 15;
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
}

// ---------- UI ----------

const ui = {};

function fmt(s) {
  s = Math.max(0, Math.floor(s));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function fmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
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
      <button class="btn mute" title="Mute (shift+${index + 1})">M</button>
      <button class="btn solo" title="Solo (${index + 1})">S</button>
    </div>
  `;
  const fader = strip.querySelector('.fader');
  const mute = strip.querySelector('.mute');
  const solo = strip.querySelector('.solo');
  const meter = strip.querySelector('.meter-fill');

  fader.addEventListener('input', () => {
    c.fader.gain.setTargetAtTime(Number(fader.value), ctx.currentTime, 0.01);
  });
  mute.addEventListener('click', () => { c.mute = !c.mute; applyMuteSolo(); });
  solo.addEventListener('click', () => { c.solo = !c.solo; applyMuteSolo(); });

  c.ui = { strip, mute, solo, meter };
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
      c.ui.meter.style.height = pct.toFixed(1) + '%';
    }
  }
  requestAnimationFrame(tick);
}

function wireTransport() {
  ui.play = document.getElementById('play');
  ui.seek = document.getElementById('seek');
  ui.cur = document.getElementById('time-cur');
  ui.dur = document.getElementById('time-dur');

  ui.play.addEventListener('click', () => playing ? pause() : play());
  ui.seek.addEventListener('pointerdown', () => { ui.seeking = true; });
  ui.seek.addEventListener('input', () => {
    ui.cur.textContent = fmt(ui.seek.value / 1000 * duration);
  });
  ui.seek.addEventListener('change', () => {
    ui.seeking = false;
    seek(ui.seek.value / 1000 * duration);
  });

  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') e.target.blur();
    if (!channels.length) return;
    if (e.code === 'Space') { e.preventDefault(); playing ? pause() : play(); return; }
    if (e.key === '0') { channels.forEach(c => { c.solo = false; }); applyMuteSolo(); return; }
    const n = Number(e.code.replace('Digit', ''));
    if (e.code.startsWith('Digit') && n >= 1 && n <= channels.length) {
      const c = channels[n - 1];
      if (e.shiftKey) c.mute = !c.mute; else c.solo = !c.solo;
      applyMuteSolo();
    }
  });
}

function renderHeader() {
  document.getElementById('eyebrow').textContent = song.set ? `${band.name} · ${song.set}` : band.name;
  document.getElementById('title').textContent = song.title;
  document.getElementById('venue').textContent =
    `${song.venue} · ${song.city} · ${fmtDate(song.date)} · ${song.source}`;
  document.title = `Split Open — ${song.title}`;
  for (const btn of document.querySelectorAll('.song')) {
    btn.classList.toggle('on', btn.dataset.id === song.id);
  }
}

function renderSongList() {
  const nav = document.getElementById('songs');
  nav.innerHTML = '';
  for (const s of songs) {
    const btn = document.createElement('button');
    btn.className = 'song';
    btn.dataset.id = s.id;
    const who = (bands[s.band] || {}).name || s.band;
    btn.innerHTML = `${s.title}<small>${who} · ${s.date}</small>`;
    btn.addEventListener('click', () => { location.hash = s.id; });
    nav.appendChild(btn);
  }
}

// ---------- song switching ----------

async function loadSong(id) {
  const next = songs.find(s => s.id === id) || songs[0];
  if (song && next.id === song.id) return;
  const token = ++loadToken;

  teardownChannels();
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
    loading.hidden = true;
    mixer.hidden = false;
    document.getElementById('transport').hidden = false;
    applyMuteSolo();
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
  const fromHash = () => loadSong(decodeURIComponent(location.hash.slice(1)));
  window.addEventListener('hashchange', () => {
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
