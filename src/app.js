(() => {
'use strict';
/* ---------------- utilidades ---------------- */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const P = new URLSearchParams(location.search);
const store = {
  get(k, d) { try { const v = localStorage.getItem('cantaya_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('cantaya_' + k, JSON.stringify(v)); } catch (e) {} }
};
function toast(msg, ms = 3500) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  $('#toasts').appendChild(t); setTimeout(() => t.remove(), ms);
}
function show(id) { ['#home', '#tv', '#mic'].forEach(s => $(s).classList.toggle('hidden', s !== id)); }
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const cleanName = s => String(s || '').replace(/[<>]/g, '').trim().slice(0, 24);
function decodeHtml(s) { const t = document.createElement('textarea'); t.innerHTML = s; return t.value; }
function parseYouTube(text) {
  const m = String(text || '').match(/(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/|v\/)|youtu\.be\/|music\.youtube\.com\/watch\?(?:[^#]*&)?v=)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}
const thumbOf = id => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

/* ---------------- conexión (PeerJS / WebRTC) ---------------- */
const PREFIX = 'cantaya-v1-';
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({length: 5}, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
const PEER_OPTS = (() => {
  const o = { debug: 1, config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] } };
  if (P.get('ph')) { o.host = P.get('ph'); o.port = +(P.get('pp') || 9000); o.path = P.get('pth') || '/'; o.secure = P.get('ps') === '1'; }
  return o;
})();
const TEST_PARAMS = ['ph', 'pp', 'pth', 'ps'].filter(k => P.get(k)).map(k => `&${k}=${encodeURIComponent(P.get(k))}`).join('');

// Opus: menos retardo (paquetes de 10 ms) y más calidad de voz
function sdpLowLatency(sdp) {
  return sdp.replace(/a=fmtp:(\d+) (.*useinbandfec=1.*)/g, (m, pt, rest) => `a=fmtp:${pt} ${rest};maxaveragebitrate=96000;stereo=0`)
            .replace(/a=ptime:\d+/g, 'a=ptime:10');
}
function tuneReceivers(pc) {
  try { pc.getReceivers().forEach(r => { if ('jitterBufferTarget' in r) r.jitterBufferTarget = 0; if ('playoutDelayHint' in r) r.playoutDelayHint = 0; }); } catch (e) {}
}

/* ---------------- análisis de voz ---------------- */
const NOTES = ['Do', 'Do#', 'Re', 'Re#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];
const noteName = midi => NOTES[((Math.round(midi) % 12) + 12) % 12];

// Detección de tono (algoritmo YIN simplificado)
function yin(buf, sr) {
  const W = 1024, minT = Math.floor(sr / 1000), maxT = Math.min(Math.floor(sr / 75), buf.length - W - 1);
  const d = new Float32Array(maxT + 1);
  for (let t = 1; t <= maxT; t++) {
    let s = 0;
    for (let i = 0; i < W; i++) { const x = buf[i] - buf[i + t]; s += x * x; }
    d[t] = s;
  }
  d[0] = 1; let run = 0;
  for (let t = 1; t <= maxT; t++) { run += d[t]; d[t] = run ? d[t] * t / run : 1; }
  let tau = -1;
  for (let t = minT; t <= maxT; t++) {
    if (d[t] < 0.15) { while (t + 1 <= maxT && d[t + 1] < d[t]) t++; tau = t; break; }
  }
  if (tau < 0) return null;
  let better = tau;
  if (tau > 1 && tau < maxT) {
    const a = d[tau - 1], b = d[tau], c = d[tau + 1], den = a + c - 2 * b;
    if (den) better = tau + (a - c) / (2 * den);
  }
  return { f: sr / better, clarity: 1 - d[tau] };
}

class VoiceAnalyser {
  constructor(ctx, node) {
    this.an = ctx.createAnalyser(); this.an.fftSize = 2048; this.an.smoothingTimeConstant = 0;
    node.connect(this.an); this.buf = new Float32Array(2048); this.sr = ctx.sampleRate; this.nf = 0.004;
  }
  read(withPitch = true) {
    this.an.getFloatTimeDomainData(this.buf);
    let s = 0; for (let i = 0; i < this.buf.length; i++) s += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(s / this.buf.length);
    if (rms < this.nf) this.nf = this.nf * 0.85 + rms * 0.15; else this.nf = Math.min(this.nf * 1.0005, 0.03);
    const voiced = rms > Math.max(0.012, this.nf * 2.5);
    let pitch = null;
    if (voiced && withPitch) { pitch = yin(this.buf, this.sr); if (pitch && (pitch.f < 70 || pitch.f > 1100 || pitch.clarity < 0.7)) pitch = null; }
    return { rms, voiced, pitch, midi: pitch ? 69 + 12 * Math.log2(pitch.f / 440) : null };
  }
}

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const std = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
const median = a => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); const k = b.length >> 1; return b.length % 2 ? b[k] : (b[k - 1] + b[k]) / 2; };

// Calificación: se alimenta con ~20 lecturas por segundo mientras suena la canción
class ScoreSession {
  constructor() { this.frames = 0; this.voiced = 0; this.devs = []; this.changes = []; this.midis = []; this.dbs = []; this.prev = null; this.hadMic = false; }
  push(r) {
    this.frames++;
    if (!r || !r.voiced) { this.prev = null; return; }
    this.voiced++; this.dbs.push(20 * Math.log10(r.rms));
    if (r.midi != null) {
      const m = r.midi;
      this.devs.push(Math.abs(m - Math.round(m)) * 100);
      if (this.prev != null) { const c = Math.abs(m - this.prev) * 100; if (c < 150) this.changes.push(c); }
      this.prev = m; this.midis.push(m);
    } else this.prev = null;
  }
  result() {
    const part = this.frames ? this.voiced / this.frames : 0;
    const p = clamp(part / 0.5);
    const enough = this.devs.length >= 30;
    const t = enough ? clamp(1 - (mean(this.devs) - 10) / 22) : 0.3;
    const s = this.changes.length >= 20 ? clamp(1 - (median(this.changes) - 12) / 50) : 0.3;
    const e = this.dbs.length >= 20 ? clamp(1 - (std(this.dbs) - 5) / 10) : 0.3;
    const x = enough ? clamp((std(this.midis) - 0.8) / 2) : 0.2;
    const w = 0.20 * p + 0.35 * t + 0.20 * s + 0.05 * e + 0.20 * x;
    const total = part < 0.05 ? Math.round(part * 200) : Math.min(100, Math.round(30 + 70 * w));
    const pct = v => Math.round(v * 100);
    return { total, parts: { 'Participación': pct(p), 'Afinación': pct(t), 'Estabilidad': pct(s), 'Energía': pct(e), 'Expresión': pct(x) } };
  }
}
function scoreMessage(n) {
  if (n >= 90) return '¡Estrella del karaoke! 🌟';
  if (n >= 80) return '¡Increíble! 🔥';
  if (n >= 70) return '¡Muy bien! 👏';
  if (n >= 55) return '¡Nada mal! 🙌';
  if (n >= 40) return 'Sigue practicando 🎶';
  return '¿Seguro que estabas cantando? 😅';
}
function scoreHTML(res, singer, title, btnLabel) {
  const bars = Object.entries(res.parts).map(([k, v]) => `<div class="bar"><span>${esc(k)}</span><div class="meter"><i style="width:${v}%"></i></div><b>${v}</b></div>`).join('');
  return `<div class="score-card"><small class="muted">${esc(singer)} cantó</small><h3>${esc(title)}</h3>
    <div class="big-score">${res.total}</div><div class="score-msg">${esc(scoreMessage(res.total))}</div>
    <div class="bars">${bars}</div>${btnLabel ? `<button class="primary huge" data-act="next">${esc(btnLabel)}</button>` : ''}</div>`;
}

/* =====================================================================
   PANTALLA (TV)
   ===================================================================== */
function startTV() {
  show('#tv');
  let code = store.get('room', null) || newCode(); store.set('room', code);
  let queue = store.get('queue', []);
  let now = null, playing = false, scoring = false, session = null, scoreTimer = null;
  // Clave de YouTube por defecto (restringida en Google Cloud al dominio de CantaYa).
  // Así cualquier pantalla (laptop o Google TV) busca canciones sin escribir nada.
  const DEFAULT_YT_KEY = 'AIzaSyCzOcQVrHDalc7LEFqtVgRMNo33Jk5ZzT4';
  let apiKey = store.get('apikey', '') || DEFAULT_YT_KEY;
  const settings = Object.assign({ micVol: 1, reverb: 0.2 }, store.get('settings', {}));
  const mics = new Map();
  let ctx, voiceBus, wet, peer, idRetries = 0, player = null, ytReady = false, pendingVideo = null, lastSinger = store.get('lastSinger', 'Invitado');
  window.__cantaya = { mics, get session() { return session; }, setPlaying(v) { playing = v; }, finishSong: () => finishSong(), addToQueue: (v, s) => addToQueue(v, s), get queue() { return queue; }, get now() { return now; } };

  // ---------- audio ----------
  function initAudio() {
    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    voiceBus = ctx.createGain(); voiceBus.gain.value = settings.micVol;
    const dry = ctx.createGain(); dry.gain.value = 1;
    const conv = ctx.createConvolver(); conv.buffer = makeImpulse(ctx, 1.6, 3);
    wet = ctx.createGain(); wet.gain.value = settings.reverb;
    voiceBus.connect(dry).connect(ctx.destination);
    voiceBus.connect(conv).connect(wet).connect(ctx.destination);
    const outAn = ctx.createAnalyser(); outAn.fftSize = 1024; voiceBus.connect(outAn);
    window.__cantaya.outLevel = () => { const b = new Float32Array(1024); outAn.getFloatTimeDomainData(b); return Math.sqrt(b.reduce((x, y) => x + y * y, 0) / b.length); };
    ctx.resume();
  }
  function makeImpulse(c, sec, decay) {
    const len = Math.floor(c.sampleRate * sec), b = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay); }
    return b;
  }

  // ---------- sala / QR ----------
  const micUrl = () => `${location.origin}/?mic=${code}${TEST_PARAMS}`;
  function renderRoom() {
    $('#roomCode').textContent = code;
    $('#roomUrl').textContent = micUrl().replace(/^https?:\/\//, '');
    try { const qr = qrcode(0, 'M'); qr.addData(micUrl()); qr.make(); $('#qr').innerHTML = `<img alt="Código QR para unirse" src="${qr.createDataURL(5, 1)}">`; }
    catch (e) { $('#qr').textContent = ''; }
  }
  function setNet(txt, cls) { const n = $('#netStatus'); n.textContent = txt; n.className = 'pill ' + (cls || ''); }

  function createPeer() {
    setNet('Conectando…');
    peer = new Peer(PREFIX + code, PEER_OPTS);
    peer.on('open', () => { idRetries = 0; setNet('● En línea', 'ok'); });
    peer.on('connection', onConn);
    peer.on('call', onCall);
    peer.on('disconnected', () => { setNet('Reconectando…', 'bad'); setTimeout(() => { if (peer && !peer.destroyed && peer.disconnected) peer.reconnect(); }, 2000); });
    peer.on('error', e => {
      console.warn('peer error', e.type, e);
      if (e.type === 'unavailable-id') {
        // la sala anterior aún no se libera (recarga rápida): reintentar antes de cambiar de código
        peer.destroy();
        if (idRetries++ < 4) { setNet('Recuperando sala…'); setTimeout(createPeer, 3000); }
        else { code = newCode(); store.set('room', code); renderRoom(); idRetries = 0; createPeer(); }
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) {
        setNet('Sin conexión, reintentando…', 'bad');
        setTimeout(() => { if (peer.destroyed) createPeer(); else if (peer.disconnected) peer.reconnect(); }, 4000);
      }
    });
  }
  function getMic(id) {
    if (!mics.has(id)) mics.set(id, { id, name: 'Micrófono', conn: null, call: null, stream: null, va: null, gain: null, el: null, muted: false, level: 0, last: null });
    return mics.get(id);
  }
  function onConn(conn) {
    conn.on('open', () => { const m = getMic(conn.peer); m.conn = conn; sendState(conn); renderMics(); });
    conn.on('data', d => handleMsg(conn, d));
    conn.on('close', () => { const m = mics.get(conn.peer); if (m && m.conn === conn) { m.conn = null; if (!m.stream) removeMic(conn.peer); } });
  }
  function onCall(call) {
    call.answer(undefined, { sdpTransform: sdpLowLatency });
    call.on('stream', stream => attachStream(call.peer, stream, call));
    call.on('close', () => { const m = mics.get(call.peer); if (m && m.call === call) removeMic(call.peer); });
    call.on('error', e => console.warn('call error', e));
  }
  function attachStream(id, stream, call) {
    const m = getMic(id);
    if (m.stream === stream) return;
    detachAudio(m);
    m.call = call; m.stream = stream;
    // Chrome necesita el stream remoto en un elemento <audio> para que Web Audio lo reciba
    m.el = new Audio(); m.el.srcObject = stream; m.el.muted = true; m.el.play().catch(() => {});
    const src = ctx.createMediaStreamSource(stream);
    m.gain = ctx.createGain(); m.gain.gain.value = m.muted ? 0 : 1;
    src.connect(m.gain).connect(voiceBus);
    m.va = new VoiceAnalyser(ctx, src); m.src = src;
    tuneReceivers(call.peerConnection);
    if (ctx.state !== 'running') ctx.resume();
    renderMics();
  }
  function detachAudio(m) {
    try { m.src && m.src.disconnect(); m.gain && m.gain.disconnect(); } catch (e) {}
    if (m.el) { m.el.srcObject = null; }
    m.src = m.gain = m.va = m.el = m.stream = null;
  }
  function removeMic(id) {
    const m = mics.get(id); if (!m) return;
    detachAudio(m); try { m.conn && m.conn.close(); } catch (e) {} mics.delete(id); renderMics();
  }

  function handleMsg(conn, d) {
    if (!d || typeof d !== 'object') return;
    const m = getMic(conn.peer); m.conn = conn;
    switch (d.t) {
      case 'hello': m.name = cleanName(d.name) || 'Micrófono'; renderMics(); broadcastState(); toast(`🎤 ${m.name} se conectó`); break;
      case 'search':
        doSearch(String(d.q || '').slice(0, 120))
          .then(items => conn.send({ t: 'results', reqId: d.reqId, items }))
          .catch(err => conn.send({ t: 'results', reqId: d.reqId, error: err.message }));
        break;
      case 'add': if (d.video && /^[A-Za-z0-9_-]{11}$/.test(d.video.id)) { addToQueue(sanitizeVideo(d.video), m.name); conn.send({ t: 'added', title: d.video.title }); } break;
      case 'link':
        resolveLink(String(d.url || '')).then(v => { addToQueue(v, m.name); conn.send({ t: 'added', title: v.title }); })
          .catch(err => conn.send({ t: 'error', message: err.message }));
        break;
      case 'cmd': command(d.c); break;
      case 'reqState': sendState(conn); break;
    }
  }
  function sanitizeVideo(v) { return { id: v.id, title: String(v.title || 'Video de YouTube').slice(0, 140), channel: String(v.channel || '').slice(0, 80), thumb: thumbOf(v.id) }; }
  function stateMsg() {
    return { t: 'state', code, playing, hasKey: !!apiKey, scoring,
      now: now && { title: now.title, singer: now.singer, thumb: now.thumb },
      queue: queue.map(q => ({ uid: q.uid, title: q.title, singer: q.singer, thumb: q.thumb })) };
  }
  function sendState(conn) { try { if (conn && conn.open) conn.send(stateMsg()); } catch (e) {} }
  function broadcastState() { const msg = stateMsg(); mics.forEach(m => { try { m.conn && m.conn.open && m.conn.send(msg); } catch (e) {} }); }
  function broadcast(msg) { mics.forEach(m => { try { m.conn && m.conn.open && m.conn.send(msg); } catch (e) {} }); }

  // ---------- YouTube ----------
  async function doSearch(q) {
    q = q.trim(); if (!q) return [];
    if (!apiKey) throw new Error('Falta la clave de YouTube. Ponla en la pantalla: ⚙️ Ajustes. Mientras tanto puedes pegar un link de YouTube.');
    const query = /karaoke/i.test(q) ? q : q + ' karaoke';
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&maxResults=12&q=${encodeURIComponent(query)}&key=${encodeURIComponent(apiKey)}`;
    let r; try { r = await fetch(url); } catch (e) { throw new Error('No hay conexión con YouTube.'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const reason = j.error && j.error.errors && j.error.errors[0] && j.error.errors[0].reason;
      if (reason === 'quotaExceeded') throw new Error('Se acabó el cupo diario de búsquedas de YouTube. Mañana se renueva; mientras, pega links.');
      throw new Error('YouTube rechazó la búsqueda: ' + ((j.error && j.error.message) || r.status) + ' (revisa la clave en Ajustes).');
    }
    return (j.items || []).filter(it => it.id && it.id.videoId).map(it => ({
      id: it.id.videoId, title: decodeHtml(it.snippet.title), channel: decodeHtml(it.snippet.channelTitle), thumb: thumbOf(it.id.videoId)
    }));
  }
  async function resolveLink(url) {
    const id = parseYouTube(url);
    if (!id) throw new Error('Ese link no parece de YouTube.');
    let title = 'Video de YouTube', channel = '';
    try {
      const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}`);
      if (r.ok) { const j = await r.json(); title = j.title || title; channel = j.author_name || ''; }
    } catch (e) {}
    return { id, title, channel, thumb: thumbOf(id) };
  }
  function loadYT() {
    window.onYouTubeIframeAPIReady = () => { ytReady = true; if (pendingVideo) { const v = pendingVideo; pendingVideo = null; loadVideo(v); } };
    const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => toast('No se pudo cargar YouTube. Revisa el internet.', 6000);
    document.head.appendChild(s);
  }
  function loadVideo(id) {
    if (!ytReady) { pendingVideo = id; return; }
    if (!player) {
      player = new YT.Player('yt', {
        width: '100%', height: '100%', videoId: id,
        playerVars: { autoplay: 1, rel: 0, playsinline: 1, modestbranding: 1, iv_load_policy: 3 },
        events: { onReady: e => e.target.playVideo(), onStateChange: onYTState, onError: onYTError }
      });
    } else player.loadVideoById(id);
  }
  function onYTState(e) {
    const was = playing;
    playing = e.data === YT.PlayerState.PLAYING;
    if (playing && !was) playingSince = performance.now();
    if (e.data === YT.PlayerState.ENDED) finishSong();
    if (was !== playing) { broadcastState(); $('#btnPause').textContent = playing ? '⏸ Pausa' : '▶ Seguir'; }
  }
  function onYTError(e) {
    const msg = (e.data === 101 || e.data === 150) ? 'El dueño de este video no deja reproducirlo fuera de YouTube. Pasando al siguiente…' : 'No se pudo reproducir este video. Pasando al siguiente…';
    toast(msg, 5000); broadcast({ t: 'error', message: msg });
    session = null; setTimeout(playNext, 1500);
  }

  // ---------- fila ----------
  function addToQueue(video, singer) {
    const item = Object.assign({ uid: uid(), singer: cleanName(singer) || 'Invitado' }, video);
    queue.push(item); store.set('queue', queue);
    toast(`🎵 ${item.title} — canta ${item.singer}`);
    if (!now && !scoring) playNext(); else { renderQueue(); broadcastState(); }
  }
  function playNext() {
    clearTimeout(scoreTimer); scoring = false; $('#scoreBox').classList.add('hidden');
    if (!queue.length) {
      now = null; session = null; playing = false;
      try { player && player.stopVideo(); } catch (e) {}
      $('#idle').classList.remove('hidden'); $('#hud').classList.add('hidden');
      renderQueue(); broadcastState(); return;
    }
    now = queue.shift(); store.set('queue', queue);
    session = new ScoreSession(); playing = false;
    $('#idle').classList.add('hidden'); $('#hud').classList.remove('hidden');
    resetAdTracking();
    $('#hudSinger').textContent = now.singer; $('#hudTitle').textContent = now.title; $('#hudScore').textContent = '–';
    loadVideo(now.id); renderQueue(); broadcastState();
  }
  function finishSong() {
    if (!now || scoring) return;
    const s = session; session = null;
    try { player && player.pauseVideo(); } catch (e) {}
    if (!s || s.frames < 20 * 20 || !s.hadMic) {          // menos de 20 s cantados o sin micrófono: sin nota
      if (s && !s.hadMic && s.frames >= 400) toast('Conecta un celular como micrófono para recibir calificación 🎤', 5000);
      return playNext();
    }
    const res = s.result();
    scoring = true;
    const rank = store.get('ranking', []); rank.push({ name: now.singer, title: now.title, score: res.total, ts: Date.now() }); store.set('ranking', rank.slice(-200));
    renderRanking();
    broadcast({ t: 'score', result: res, singer: now.singer, title: now.title });
    const box = $('#scoreBox'); let n = 12;
    const paint = () => { box.innerHTML = scoreHTML(res, now.singer, now.title, queue.length ? `Siguiente canción (${n})` : `Continuar (${n})`); };
    paint(); box.classList.remove('hidden');
    const tick = () => { n--; if (n <= 0) return playNext(); paint(); scoreTimer = setTimeout(tick, 1000); };
    scoreTimer = setTimeout(tick, 1000);
    broadcastState();
  }
  $('#scoreBox').addEventListener('click', e => { if (e.target.closest('[data-act=next]')) playNext(); });
  function command(c) {
    if (c === 'skip') { if (scoring) playNext(); else if (now) finishSong(); else playNext(); }
    else if (c === 'pause') { if (!player || !now) return; if (playing) player.pauseVideo(); else player.playVideo(); }
    else if (c === 'restart') { if (!player || !now || scoring) return; player.seekTo(0, true); player.playVideo(); session = new ScoreSession(); resetAdTracking(); }
  }
  $('#btnSkip').onclick = () => command('skip');
  $('#btnPause').onclick = () => command('pause');
  $('#btnRestart').onclick = () => command('restart');

  // ---------- render ----------
  function renderMics() {
    const list = [...mics.values()].filter(m => m.stream || m.conn);
    $('#micCount').textContent = list.length;
    $('#micList').innerHTML = list.length ? list.map(m => `<div class="item" data-id="${esc(m.id)}">
      <div class="t"><b>${esc(m.name)}</b><small>${m.stream ? (m.muted ? 'Silenciado' : 'Micrófono activo') : 'Conectando audio…'}</small></div>
      <div class="meter"><i data-lvl="${esc(m.id)}"></i></div><button data-mute="${esc(m.id)}">${m.muted ? '🔈' : '🔇'}</button></div>`).join('')
      : '<p class="muted small">Nadie conectado todavía. Escanea el QR con el celular.</p>';
    renderSingerSelect();
  }
  $('#micList').addEventListener('click', e => {
    const b = e.target.closest('[data-mute]'); if (!b) return;
    const m = mics.get(b.dataset.mute); if (!m) return;
    m.muted = !m.muted; if (m.gain) m.gain.gain.value = m.muted ? 0 : 1; renderMics();
  });
  function renderQueue() {
    $('#queueList').innerHTML = queue.length ? queue.map((q, i) => `<div class="item"><img src="${esc(q.thumb)}" alt="" loading="lazy">
      <div class="t"><b>${i + 1}. ${esc(q.title)}</b><small>🎤 ${esc(q.singer)}</small></div><button data-del="${esc(q.uid)}" title="Quitar">✕</button></div>`).join('')
      : '<p class="muted small">La fila está vacía. Busca una canción arriba o desde el celular.</p>';
  }
  $('#queueList').addEventListener('click', e => {
    const b = e.target.closest('[data-del]'); if (!b) return;
    queue = queue.filter(q => q.uid !== b.dataset.del); store.set('queue', queue); renderQueue(); broadcastState();
  });
  function renderRanking() {
    const since = Date.now() - 12 * 3600e3;
    const r = store.get('ranking', []).filter(x => x.ts > since).sort((a, b) => b.score - a.score).slice(0, 8);
    $('#rankList').innerHTML = r.length ? r.map(x => `<li>${esc(x.name)} <b>${x.score}</b><br><span class="small">${esc(x.title.slice(0, 40))}</span></li>`).join('')
      : '<p class="muted small" style="margin:0 0 0 -1.4em">Todavía nadie ha cantado.</p>';
  }
  function renderSingerSelect() {
    const names = [...new Set([...[...mics.values()].map(m => m.name), lastSinger, 'Invitado'])].filter(Boolean);
    $('#resSinger').innerHTML = names.map(n => `<option ${n === lastSinger ? 'selected' : ''}>${esc(n)}</option>`).join('');
  }

  // ---------- búsqueda en la TV ----------
  $('#tvSearch').addEventListener('submit', async e => {
    e.preventDefault();
    const q = $('#tvQ').value.trim(); if (!q) return;
    if (parseYouTube(q)) {
      try { const v = await resolveLink(q); addToQueue(v, $('#resSinger').value || lastSinger); $('#tvQ').value = ''; } catch (err) { toast(err.message); }
      return;
    }
    $('#resTitle').textContent = `Buscando “${q}”…`; $('#resGrid').innerHTML = ''; $('#results').classList.remove('hidden'); renderSingerSelect();
    try {
      const items = await doSearch(q);
      $('#resTitle').textContent = items.length ? `Resultados para “${q}”` : `Nada encontrado para “${q}”`;
      $('#resGrid').innerHTML = items.map((v, i) => `<button class="vcard" data-i="${i}"><img src="${esc(v.thumb)}" alt="" loading="lazy"><div><b>${esc(v.title)}</b><small>${esc(v.channel)}</small><span class="add">+ Agregar a la fila</span></div></button>`).join('');
      $('#resGrid').onclick = ev => {
        const c = ev.target.closest('[data-i]'); if (!c) return;
        lastSinger = $('#resSinger').value || 'Invitado'; store.set('lastSinger', lastSinger);
        addToQueue(items[+c.dataset.i], lastSinger); c.querySelector('.add').textContent = '✓ Agregada';
      };
    } catch (err) { $('#resTitle').textContent = err.message; }
  });
  $('#resClose').onclick = () => $('#results').classList.add('hidden');

  // ---------- ajustes ----------
  function openSettings() {
    $('#setKey').value = apiKey; $('#setVol').value = settings.micVol; $('#setRev').value = settings.reverb;
    $('#settings').classList.remove('hidden');
  }
  $('#tvSettingsBtn').onclick = openSettings;
  $('#setClose').onclick = () => $('#settings').classList.add('hidden');
  $('#setVol').oninput = e => { settings.micVol = +e.target.value; if (voiceBus) voiceBus.gain.value = settings.micVol; store.set('settings', settings); };
  $('#setRev').oninput = e => { settings.reverb = +e.target.value; if (wet) wet.gain.value = settings.reverb; store.set('settings', settings); };
  $('#setSave').onclick = () => { store.set('apikey', $('#setKey').value.trim()); apiKey = $('#setKey').value.trim() || DEFAULT_YT_KEY; $('#settings').classList.add('hidden'); broadcastState(); toast(apiKey ? '✓ Clave guardada' : 'Clave borrada'); };
  $('#setTest').onclick = async () => {
    const old = apiKey; apiKey = $('#setKey').value.trim();
    try { const r = await doSearch('despacito'); toast(r.length ? '✓ ¡La clave funciona!' : 'La clave responde pero sin resultados'); }
    catch (e) { toast(e.message, 6000); } finally { apiKey = old; }
  };
  $('#setResetRank').onclick = () => { store.set('ranking', []); renderRanking(); toast('Ranking borrado'); };
  $('#setNewRoom').onclick = () => { code = newCode(); store.set('room', code); renderRoom(); mics.forEach((m, id) => removeMic(id)); try { peer.destroy(); } catch (e) {} createPeer(); toast('Nuevo código: ' + code); };

  // ---------- bucle de análisis ----------
  // Detección de anuncios: solo cuenta para la nota mientras la canción avanza de verdad.
  // Durante un anuncio (o si se traba cargando) el tiempo del video no se mueve.
  let lastT = -1, lastAdvanceAt = 0, playingSince = 0, adShown = false;
  function songAdvancing() {
    if (!player || typeof player.getCurrentTime !== 'function') return true; // sin reproductor (pruebas)
    const nowMs = performance.now();
    let t = 0; try { t = player.getCurrentTime() || 0; } catch (e) {}
    if (lastT >= 0 && t > lastT + 0.001 && t - lastT < 5) lastAdvanceAt = nowMs;
    lastT = t;
    return nowMs - lastAdvanceAt < 900;
  }
  function resetAdTracking() { lastT = -1; lastAdvanceAt = 0; playingSince = performance.now(); adShown = false; $('#hudTitle').style.color = ''; }
  function showAdNotice(on) {
    if (on === adShown || !now) return;
    adShown = on;
    $('#hudTitle').textContent = on ? '📢 Publicidad: no cuenta para la nota' : now.title;
    $('#hudTitle').style.color = on ? 'var(--yellow)' : '';
  }
  window.__cantaya.resetAdTracking = resetAdTracking;

  let hudTick = 0;
  setInterval(() => {
    if (!ctx) return;
    let best = null, singerMic = null;
    mics.forEach(m => {
      if (!m.va) return;
      const r = m.va.read(true); m.last = r; m.level = r.rms;
      if (m.muted) r.voiced = false;
      if (now && m.name === now.singer) singerMic = m;
      if (!best || r.rms > best.rms) best = r;
    });
    const r = singerMic ? singerMic.last : best;
    const advancing = playing ? songAdvancing() : false;
    // aviso de publicidad: sonando pero la canción no avanza por más de 2 s
    showAdNotice(playing && !advancing && performance.now() - playingSince > 2000);
    if (session && playing && advancing && !scoring) { if (r) session.hadMic = true; session.push(r); }
    if (++hudTick % 2) return;
    mics.forEach(m => { const el = document.querySelector(`[data-lvl="${CSS.escape(m.id)}"]`); if (el) el.style.width = Math.min(100, m.level * 400) + '%'; });
    if (now) {
      $('#hudLevel').style.width = r ? Math.min(100, r.rms * 400) + '%' : '0%';
      $('#hudNote').textContent = r && r.midi != null ? noteName(r.midi) : '–';
      if (session && session.frames > 100 && hudTick % 10 === 0) $('#hudScore').textContent = session.result().total;
    }
  }, 50);

  // ---------- arranque ----------
  renderRoom(); renderQueue(); renderRanking(); renderMics();
  setTimeout(() => $('#tvStartBtn').focus(), 50);   // control remoto de la TV: OK = empezar
  $('#tvStartBtn').onclick = () => {
    $('#tvStart').classList.add('hidden');
    initAudio(); loadYT(); createPeer();
    if (queue.length) playNext();
    if (!apiKey) setTimeout(() => toast('Tip: pon tu clave de YouTube en ⚙️ Ajustes para buscar canciones', 6000), 1500);
  };
  window.addEventListener('beforeunload', () => { try { peer && peer.destroy(); } catch (e) {} });
}

/* =====================================================================
   CELULAR (MICRÓFONO)
   ===================================================================== */
function startMic(initialCode) {
  show('#mic');
  $('#mjCode').value = (initialCode || '').toUpperCase();
  $('#mjName').value = store.get('name', '');
  let code, name, stream, ctx, va, peer, conn, call, gen = 0, muted = false, wakeLock = null, state = null, connectTimer = null, reqId = 0;
  const pending = new Map();

  function setStatus(txt, cls) { const s = $('#mStatus'); s.textContent = txt; s.className = 'pill ' + (cls || ''); }

  $('#mjGo').onclick = async () => {
    $('#mjErr').textContent = '';
    code = $('#mjCode').value.trim().toUpperCase(); name = cleanName($('#mjName').value);
    if (code.length !== 5) { $('#mjErr').textContent = 'Escribe el código de 5 letras que aparece en la pantalla.'; return; }
    if (!name) { $('#mjErr').textContent = 'Escribe tu nombre.'; $('#mjName').focus(); return; }
    store.set('name', name);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { $('#mjErr').textContent = 'Este navegador no permite usar el micrófono. Abre el link en Chrome o Safari (con https).'; return; }
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); ctx.resume(); } catch (e) {}
    const nr = $('#mjNr').checked;
    $('#mjGo').disabled = true; $('#mjGo').textContent = 'Pidiendo permiso…';
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: nr, noiseSuppression: nr, autoGainControl: false, channelCount: 1 } });
    } catch (e) {
      $('#mjGo').disabled = false; $('#mjGo').textContent = 'Conectar micrófono';
      $('#mjErr').textContent = e.name === 'NotAllowedError' ? 'No diste permiso al micrófono. Actívalo en la configuración del navegador y vuelve a intentar.' : 'No se pudo abrir el micrófono: ' + e.message;
      return;
    }
    if (ctx) { va = new VoiceAnalyser(ctx, ctx.createMediaStreamSource(stream)); meterLoop(); }
    $('#micJoin').classList.add('hidden'); $('#micMain').classList.remove('hidden');
    history.replaceState(null, '', `${location.pathname}?mic=${code}${TEST_PARAMS}`);
    keepAwake(); connect();
  };

  function connect() {
    const my = ++gen;
    clearTimeout(connectTimer);
    try { peer && peer.destroy(); } catch (e) {}
    setStatus('Conectando…');
    peer = new Peer(PEER_OPTS);
    const lost = why => { if (my !== gen) return; gen++; setStatus(why || 'Reconectando…', 'bad'); clearTimeout(connectTimer); setTimeout(connect, 3000); };
    connectTimer = setTimeout(() => lost('Sin respuesta, reintentando…'), 15000);
    peer.on('open', () => {
      if (my !== gen) return;
      conn = peer.connect(PREFIX + code, { reliable: true });
      conn.on('open', () => { if (my !== gen) return; clearTimeout(connectTimer); conn.send({ t: 'hello', name }); setStatus('● Conectado', 'ok'); });
      conn.on('data', onData);
      conn.on('close', () => lost());
      call = peer.call(PREFIX + code, stream, { sdpTransform: sdpLowLatency });
      call && call.on('close', () => lost());
    });
    peer.on('disconnected', () => { if (my === gen && !peer.destroyed) peer.reconnect(); });
    peer.on('error', e => {
      if (my !== gen) return;
      if (e.type === 'peer-unavailable') lost(`No se encuentra la pantalla ${code}. ¿Está abierta?`);
      else lost('Reconectando…');
    });
  }

  function onData(d) {
    if (!d || typeof d !== 'object') return;
    if (d.t === 'state') { state = d; renderState(); }
    else if (d.t === 'results') { const cb = pending.get(d.reqId); if (cb) { pending.delete(d.reqId); cb(d); } }
    else if (d.t === 'added') toast('✓ Agregada a la fila: ' + (d.title || ''));
    else if (d.t === 'error') toast(d.message, 5000);
    else if (d.t === 'score') {
      const box = $('#mScore'); box.innerHTML = scoreHTML(d.result, d.singer, d.title, 'Cerrar'); box.classList.remove('hidden');
      if (navigator.vibrate) navigator.vibrate([80, 60, 80]);
    }
  }
  $('#mScore').addEventListener('click', e => { if (e.target.closest('[data-act=next]')) $('#mScore').classList.add('hidden'); });
  const send = m => { try { if (conn && conn.open) { conn.send(m); return true; } } catch (e) {} toast('Todavía no hay conexión con la pantalla'); return false; };

  function renderState() {
    const n = state.now;
    const mine = n && n.singer === name;
    $('#mNow').className = 'now' + (mine ? ' mine' : '');
    $('#mNow').innerHTML = n ? `${mine ? '🎤 <b>¡Te toca!</b> ' : `Canta <b>${esc(n.singer)}</b>: `}${esc(n.title)}` : 'Nada sonando todavía. ¡Busca una canción!';
    if (!state.scoring) $('#mScore').classList.add('hidden');
    $('#mQCount').textContent = state.queue.length ? `(${state.queue.length})` : '';
    $('#mQueue').innerHTML = state.queue.length ? state.queue.map((q, i) => `<div class="item"><img src="${esc(q.thumb)}" alt=""><div class="t"><b>${i + 1}. ${esc(q.title)}</b><small>🎤 ${esc(q.singer)}</small></div></div>`).join('')
      : '<p class="muted small">La fila está vacía.</p>';
  }

  $('#mSearch').addEventListener('submit', e => {
    e.preventDefault();
    const q = $('#mQ').value.trim(); if (!q) return;
    if (parseYouTube(q)) { if (send({ t: 'link', url: q })) $('#mQ').value = ''; return; }
    const id = ++reqId;
    $('#mResults').innerHTML = '<p class="muted">Buscando…</p>';
    if (!send({ t: 'search', q, reqId: id })) { $('#mResults').innerHTML = ''; return; }
    pending.set(id, d => {
      if (d.error) { $('#mResults').innerHTML = `<p class="err">${esc(d.error)}</p>`; return; }
      const items = d.items || [];
      $('#mResults').innerHTML = items.length ? items.map((v, i) => `<button class="item" data-i="${i}"><img src="${esc(v.thumb)}" alt=""><div class="t"><b>${esc(v.title)}</b><small>${esc(v.channel)} · <span style="color:var(--pink)">+ Agregar</span></small></div></button>`).join('')
        : '<p class="muted">No se encontró nada. Prueba con otro nombre.</p>';
      $('#mResults').onclick = ev => { const b = ev.target.closest('[data-i]'); if (!b) return; if (send({ t: 'add', video: items[+b.dataset.i] })) b.disabled = true; };
    });
  });
  $$('[data-cmd]').forEach(b => b.onclick = () => send({ t: 'cmd', c: b.dataset.cmd }));
  $$('.tab').forEach(b => b.onclick = () => {
    $$('.tab').forEach(x => x.classList.toggle('on', x === b));
    $('#tabBuscar').classList.toggle('hidden', b.dataset.tab !== 'buscar'); $('#tabFila').classList.toggle('hidden', b.dataset.tab !== 'fila');
  });
  const toggleMute = () => {
    muted = !muted; stream.getAudioTracks().forEach(t => t.enabled = !muted);
    $('#mBig').classList.toggle('muted', muted); $('#mMute').textContent = muted ? '🔈 Activar micrófono' : '🔇 Silenciar';
  };
  $('#mMute').onclick = toggleMute; $('#mBig').onclick = toggleMute;

  function meterLoop() {
    let lastNote = 0;
    const loop = () => {
      const r = va.read(true);
      const lv = muted ? 0 : Math.min(1, r.rms * 5);
      $('#mRing').style.transform = `scale(${1 + lv * 0.18})`; $('#mRing').style.opacity = 0.15 + lv * 0.85;
      const t = performance.now();
      if (t - lastNote > 120) { lastNote = t; $('#mNote').textContent = muted ? 'Silenciado' : (r.midi != null ? '♪ ' + noteName(r.midi) : (r.voiced ? '…' : 'Habla para probar')); }
      requestAnimationFrame(loop);
    };
    loop();
  }
  async function keepAwake() {
    try { if ('wakeLock' in navigator) { wakeLock = await navigator.wakeLock.request('screen'); } } catch (e) {}
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { keepAwake(); if (ctx && ctx.state !== 'running') ctx.resume(); if (!conn || !conn.open) connect(); }
  });
}

/* ---------------- ruteo ---------------- */
var boot = document.getElementById('boot'); if (boot) boot.remove();
if (typeof Peer === 'undefined') { document.body.innerHTML = '<p style="padding:24px">No se pudo cargar el módulo de conexión. Recarga la página.</p>'; return; }
if (P.has('mic')) startMic(P.get('mic'));
else if (P.has('tv') || /\/tv\/?$/i.test(location.pathname)) startTV();
else {
  show('#home');
  $('#goTv').onclick = () => { location.search = '?tv' + TEST_PARAMS; };
  $('#homeJoin').addEventListener('submit', e => { e.preventDefault(); const c = $('#homeCode').value.trim().toUpperCase(); if (c.length === 5) location.search = '?mic=' + c + TEST_PARAMS; else toast('El código tiene 5 letras'); });
}
})();
