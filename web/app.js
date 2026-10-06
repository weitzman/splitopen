// Split Open — multi-stem player built on the Web Audio API.
// All stems are decoded up front and started on the same AudioContext clock,
// so they stay sample-locked; mute/solo/fader are just gain changes.

// Fixed stem slots; who plays each one comes from bands.json per song.
const SLOTS = [
  { id: 'guitar', file: 'guitar.mp3', color: 'var(--trey)' },
  { id: 'bass',   file: 'bass.mp3',   color: 'var(--mike)' },
  { id: 'keys',   file: 'keys.mp3',   color: 'var(--page)' },
  { id: 'drums',  file: 'drums.mp3',  color: 'var(--fish)' },
  { id: 'vocals', file: 'vocals.mp3', color: 'var(--vox)' },
];
let STEMS = SLOTS;

const ctx = new (window.AudioContext || window.webkitAudioContext)();
const master = ctx.createGain();
master.connect(ctx.destination);

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

async function loadStem(url, onProgress) {
  const res = await fetch(url);
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
    onProgress(total ? received / total : 0);
  }
  const bytes = new Uint8Array(received);
  let pos = 0;
  for (const c of chunks) { bytes.set(c, pos); pos += c.length; }
  return ctx.decodeAudioData(bytes.buffer);
}

async function loadAllStems(dir) {
  const fill = document.getElementById('loading-fill');
  const label = document.getElementById('loading-label');
  label.textContent = 'Loading stems…';
  fill.style.width = '0%';
  const progress = new Array(STEMS.length).fill(0);
  const update = () => {
    const pct = progress.reduce((a, b) => a + b, 0) / STEMS.length * 100;
    fill.style.width = pct.toFixed(1) + '%';
  };
  const buffers = await Promise.all(STEMS.map((def, i) =>
    loadStem(dir + def.file, p => { progress[i] = p; update(); })
  ));
  label.textContent = 'Decoding…';
  return buffers;
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
  if (ctx.state === 'suspended') await ctx.resume();
  if (offset >= duration) offset = 0;
  startSources(offset);
  setPlayButton(true);
}

function pause() {
  offset = position();
  stopSources();
  playing = false;
  setPlayButton(false);
}

function stop(at) {
  stopSources();
  playing = false;
  offset = at;
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
  document.getElementById('eyebrow').textContent = band.name;
  document.getElementById('title').textContent = song.title;
  document.getElementById('venue').textContent = `${song.venue} · ${song.city}`;
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
    const buffers = await loadAllStems(song.dir);
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
  window.addEventListener('hashchange', fromHash);
  fromHash();
})();
