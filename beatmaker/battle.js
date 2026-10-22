// BEATLAB — комнаты баттлов поверх битмейкера.
// Сервер (serve.js) ведёт комнату и таймеры; события приходят по SSE, команды уходят POST /api/send.
// Читка идёт вживую: у выступающего играет бит, бит + микрофон уходят остальным по WebRTC.
(() => {
'use strict';
const B = window.beatlab;
if (!B) return;

// ================= кто я =================
const hex = n => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
const COLORS = ['#ff3d6e', '#ffb02e', '#3ddc97', '#3db8ff', '#a46bff', '#ff7a3d', '#e5e5e5'];
// id — на вкладку (две вкладки = два игрока), ник и цвет — общие для браузера
let pid = sessionStorage.getItem('bl-pid');
if (!pid) { pid = 'p' + hex(16); sessionStorage.setItem('bl-pid', pid); }
let nick = localStorage.getItem('beatlab-nick') || 'Игрок ' + (1000 + Math.floor(Math.random() * 9000));
let color = localStorage.getItem('beatlab-color') || COLORS[Math.floor(Math.random() * COLORS.length)];

const TEAM = { A: 'Команда A', B: 'Команда B' };
const ROLE = { both: 'Бит и читка', beat: 'Битмейкер', rap: 'Читка' };
const PHASE = { prep: 'Приготовьтесь', beat: 'Делаем бит', perf: 'Выступление', vote: 'Голосует жюри', done: 'Итоги матча' };
const STASH = 'beatlab-pre-battle';   // бит, который был открыт до матча — вернём после
const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const pickMime = list => (window.MediaRecorder ? list.find(t => MediaRecorder.isTypeSupported(t)) || '' : '');

// ================= состояние =================
let es = null, connected = false, offset = 0;
let room = null, rooms = [];
let shown = false, newMode = '1v1', newTest = false;
let phase = null;                 // текущая фаза, в которую мы «вошли» (для действий при смене)
let teammateBeat = null, previewing = false;
let perf = null, listen = null, display = null, screenRec = null, snapT = 0, lastSent = '';
const wants = new Set();          // кто попросил звук раньше, чем мы вышли на сцену
const media = new Map();          // url записи → <video>/<audio>, чтобы перерисовка не сбивала просмотр

const now = () => Date.now() + offset;
const mySeat = (r = room) => {
  if (!r) return null;
  for (const t of ['A', 'B']) { const i = r.seats[t].indexOf(pid); if (i >= 0) return { team: t, i, role: r.roles[i] }; }
  return null;
};
const makesBeat = s => !!s && s.role !== 'rap';
const raps = s => !!s && s.role !== 'beat';
const member = p => (room && room.members.find(m => m.pid === p)) || null;
const nickOf = p => (member(p) || {}).nick || '—';
const beatTime = () => (room.times.beat >= 60 ? Math.round(room.times.beat / 60) + ' мин' : room.times.beat + ' секунд');
const isLive = () => !!(room && room.match && room.match.phase !== 'done');

// ================= связь с сервером =================
function connect() {
  if (es) return;
  es = new EventSource(`/api/events?pid=${pid}&nick=${encodeURIComponent(nick)}&color=${encodeURIComponent(color)}`);
  es.addEventListener('hello', e => {
    const d = JSON.parse(e.data);
    connected = true; offset = d.now - Date.now(); rooms = d.rooms;
    setRoom(d.room);
    const want = new URLSearchParams(location.search).get('room');
    if (!d.room && want) { shown = true; send('join', { code: want }).then(j => { if (j.err) setUrl(null); }); }
    // вернулись на страницу не в матче — отдаём бит, который был до матча
    if (!(isLive() && mySeat())) restoreStash();
    render();
  });
  es.addEventListener('rooms', e => { rooms = JSON.parse(e.data); if (!room) render(); });
  es.addEventListener('room', e => setRoom(JSON.parse(e.data)));
  es.addEventListener('beat', e => onBeat(JSON.parse(e.data)));
  es.addEventListener('rtc', e => onRtc(JSON.parse(e.data)).catch(() => {}));
  es.onerror = () => { if (connected) { connected = false; render(); } };
}
function reconnect() { if (es) { es.close(); es = null; } connected = false; connect(); }
async function send(t, d = {}) {
  try {
    const r = await fetch('/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid, t, ...d }) });
    const j = await r.json();
    if (j.err) B.toast(j.err);
    return j;
  } catch (e) { B.toast('Нет связи с сервером BEATLAB'); return { err: 'net' }; }
}
function setUrl(code) {
  const u = new URL(location.href);
  if (code) u.searchParams.set('room', code); else u.searchParams.delete('room');
  history.replaceState(null, '', u.pathname + u.search);
}
const inviteLink = () => `${location.origin}/?room=${room.code}`;

function setRoom(v) {
  const was = room && room.code;
  room = v;
  if (v) offset = v.now - Date.now();
  if ((v && v.code) !== was) setUrl(v && v.code);
  syncPhase();
  render();
}

// ================= смена фаз матча =================
function phaseOf() {
  if (!room || !room.match) return null;
  const m = room.match;
  return { key: `${room.code}|${m.round}|${m.phase}|${m.team}`, round: m.round, phase: m.phase, team: m.team, performer: m.performer, seat: mySeat(), code: room.code, rapAt: m.rapAt };
}
function syncPhase() {
  const next = phaseOf();
  if ((next && next.key) === (phase && phase.key)) { if (next) phase.rapAt = next.rapAt; return; }
  const prev = phase;
  phase = next;
  if (prev) exitPhase(prev);
  if (next) enterPhase(next);
}
function exitPhase(p) {
  if (p.phase === 'beat' && makesBeat(p.seat)) {
    clearInterval(snapT); snapT = 0;
    if (B.playing) B.stop();
    sendBeat(true);
    stopScreen();
    B.keep(`Баттл ${p.code} · раунд ${p.round}`);
  }
  if (p.phase === 'beat' && previewing) { previewing = false; if (B.playing) B.stop(); }
  if (p.phase === 'perf') { if (p.performer === pid) stopPerformance(); else stopListen(); }
}
function enterPhase(p) {
  const live = p.phase !== 'done';
  if (live && p.seat && !localStorage.getItem(STASH)) stash();
  document.body.classList.toggle('bt-live', live && !!p.seat);
  if (p.phase === 'prep') {
    if (B.playing) B.stop();
    teammateBeat = null;
    // каждый раунд — новый бит с нуля
    if (makesBeat(p.seat)) B.fresh();
  } else if (p.phase === 'beat') {
    if (makesBeat(p.seat)) {
      shown = false;
      lastSent = '';
      if (room.roles.length > 1) snapT = setInterval(() => sendBeat(false), 3000);   // напарник слышит бит, пока он делается
      startScreen(p.round);
      B.toast(`Раунд ${p.round}: время пошло — ${beatTime()} на бит`);
    }
  } else if (p.phase === 'perf') {
    if (B.playing) B.stop();
    if (p.performer === pid) startPerformance(p); else startListen(p.performer);
  } else if (p.phase === 'done') {
    shown = true;   // итоги и записи — сразу на экран
    if (display) { display.getTracks().forEach(t => t.stop()); display = null; }
    restoreStash();
  }
}

function stash() {
  try { localStorage.setItem(STASH, JSON.stringify({ data: B.serialize(), project: B.project })); } catch (e) {}
}
function restoreStash() {
  const s = localStorage.getItem(STASH);
  if (!s) return;
  localStorage.removeItem(STASH);
  document.body.classList.remove('bt-live');
  try {
    const o = JSON.parse(s);
    B.load(o.data, o.project);
    B.toast('Твой бит, открытый до матча, вернулся. Биты из матча лежат в «Мои биты»');
  } catch (e) {}
}

// ================= бит: отправка и приём =================
function beatJson() {
  // вокал живёт в IndexedDB этого браузера — в баттл уходят только синтезированные каналы
  const o = JSON.parse(B.serialize());
  o.channels = (o.channels || []).filter(c => c.sound !== 'audio');
  if (o.song && Array.isArray(o.song.clips)) o.song.clips = o.song.clips.filter(c => c.a === undefined);
  return JSON.stringify(o);
}
function sendBeat(final) {
  const j = beatJson();
  if (!final && j === lastSent) return;
  lastSent = j;
  send('beat', { json: j, final });
}
function onBeat(b) {
  const s = mySeat();
  if (!s || b.team !== s.team || s.role !== 'rap') return;
  teammateBeat = { ...b, at: Date.now() };
  // финальная версия пришла, пока бит разгоняется перед читкой — переставляем
  if (perf && now() < (phase.rapAt || 0) && perf.beatV !== b.v) { perf.beatV = b.v; B.load(b.json); playBeat(); }
  render();
}
function playBeat() {
  if (B.start() === false) { B.state.mode = 'pat'; B.start(); }
}

// ================= сцена: выступающий =================
function startPerformance(p) {
  B.ensureAudio();
  if (p.seat && p.seat.role === 'rap') {
    if (teammateBeat) B.load(teammateBeat.json);
    else B.toast('Бит напарника не дошёл — играет то, что открыто у тебя');
  }
  // бит + голос → лимитер → поток в комнату и запись (чтобы сумма не хрипела)
  const c = B.ctx, dest = c.createMediaStreamDestination(), bus = c.createGain(), lim = c.createDynamicsCompressor();
  lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.12;
  bus.connect(lim).connect(dest);
  B.E.master.connect(bus);
  perf = { p, dest, bus, mic: null, pcs: new Map(), chunks: [], rec: null, beatV: teammateBeat && teammateBeat.v };
  const mime = pickMime(['audio/webm;codecs=opus', 'audio/webm']);
  try {
    const rec = new MediaRecorder(dest.stream, mime ? { mimeType: mime, audioBitsPerSecond: 192000 } : {});
    rec.ondataavailable = e => { if (e.data.size) perf && perf.rec === rec ? perf.chunks.push(e.data) : null; };
    rec.start(1000);
    perf.rec = rec;
  } catch (e) {}
  playBeat();
  const cur = perf;
  (B.mic ? Promise.resolve(true) : B.enableMic()).then(ok => {
    if (perf !== cur) return;
    if (ok && B.mic) { cur.mic = B.ctx.createMediaStreamSource(B.mic.stream); cur.mic.connect(cur.bus); }
    else B.toast('Микрофон не включился — в комнате слышен только бит');
    render();
  });
  for (const w of wants) offerTo(w);
  wants.clear();
}
function stopPerformance() {
  const p = perf;
  if (!p) return;
  perf = null;
  if (B.playing) B.stop();
  for (const pc of p.pcs.values()) pc.close();
  if (p.mic) p.mic.disconnect();
  if (p.rec && p.rec.state !== 'inactive') {
    p.rec.ondataavailable = e => { if (e.data.size) p.chunks.push(e.data); };
    p.rec.onstop = () => {
      try { B.E.master.disconnect(p.bus); } catch (e) {}
      upload(new Blob(p.chunks, { type: 'audio/webm' }), 'rap', p.p.round);
    };
    p.rec.stop();
  } else { try { B.E.master.disconnect(p.bus); } catch (e) {} }
}
// SDP целиком, со всеми адресами — без пересылки кандидатов по одному
const gathered = pc => new Promise(ok => {
  if (pc.iceGatheringState === 'complete') return ok();
  const t = setTimeout(ok, 2500);
  pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); ok(); } });
});
// голос и бит в стерео и с нормальным битрейтом, а не «телефонным»
const hiFi = sdp => sdp.replace(/a=fmtp:(\d+) (.*useinbandfec=1.*)/g, (m, pt, rest) => `a=fmtp:${pt} ${rest};stereo=1;sprop-stereo=1;maxaveragebitrate=192000`);
async function offerTo(from) {
  if (!perf) { wants.add(from); return; }
  const cur = perf;
  const old = cur.pcs.get(from);
  if (old) old.close();
  const pc = new RTCPeerConnection(ICE);
  cur.pcs.set(from, pc);
  for (const t of cur.dest.stream.getAudioTracks()) pc.addTrack(t, cur.dest.stream);
  const offer = await pc.createOffer();
  offer.sdp = hiFi(offer.sdp);
  await pc.setLocalDescription(offer);
  await gathered(pc);
  if (perf !== cur || cur.pcs.get(from) !== pc) return;
  send('rtc', { to: from, data: { sdp: pc.localDescription.toJSON() } });
}

// ================= сцена: слушатели =================
function startListen(from) {
  stopListen();
  if (!from) return;
  listen = { from, pc: null, got: false, blocked: false, audio: null, an: null, src: null };
  const ask = () => send('rtc', { to: from, data: { want: true } });
  ask();
  listen.retry = setInterval(() => { if (listen && !listen.got) ask(); }, 4000);
}
function stopListen() {
  const l = listen;
  if (!l) return;
  listen = null;
  clearInterval(l.retry);
  if (l.pc) l.pc.close();
  if (l.audio) { l.audio.pause(); l.audio.srcObject = null; }
  if (l.src) l.src.disconnect();
}
async function onRtc({ from, data }) {
  if (data.want) return offerTo(from);
  if (data.sdp && data.sdp.type === 'offer') {
    const l = listen;
    if (!l || l.from !== from) return;
    if (l.pc) l.pc.close();
    const pc = (l.pc = new RTCPeerConnection(ICE));
    pc.ontrack = e => { if (listen === l) hear(l, e.streams[0] || new MediaStream([e.track])); };
    await pc.setRemoteDescription(data.sdp);
    const ans = await pc.createAnswer();
    ans.sdp = hiFi(ans.sdp);
    await pc.setLocalDescription(ans);
    await gathered(pc);
    if (listen === l && l.pc === pc) send('rtc', { to: from, data: { sdp: pc.localDescription.toJSON() } });
  } else if (data.sdp && data.sdp.type === 'answer') {
    const pc = perf && perf.pcs.get(from);
    if (pc && pc.signalingState === 'have-local-offer') await pc.setRemoteDescription(data.sdp);
  }
}
function hear(l, stream) {
  l.got = true;
  l.audio = l.audio || new Audio();
  l.audio.srcObject = stream;
  l.audio.play().then(() => { l.blocked = false; render(); }, () => { l.blocked = true; render(); });
  try {
    B.ensureAudio();
    l.src = B.ctx.createMediaStreamSource(stream);
    l.an = B.ctx.createAnalyser(); l.an.fftSize = 1024;
    l.src.connect(l.an);
  } catch (e) {}
  render();
}

// ================= запись экрана битмейкера =================
async function askScreen() {
  if (display && display.getVideoTracks()[0].readyState === 'live') return true;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return false;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 15 }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude',
    });
    display.getVideoTracks()[0].addEventListener('ended', () => { display = null; render(); });
    return true;
  } catch (e) { display = null; return false; }
}
function startScreen(round) {
  if (!display || !window.MediaRecorder) return;
  B.ensureAudio();
  // звук в записи — прямо из битмейкера, а не из колонок
  const dest = B.ctx.createMediaStreamDestination();
  B.E.master.connect(dest);
  const stream = new MediaStream([...display.getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const mime = pickMime(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']);
  let rec;
  try { rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 1.2e6 }); }
  catch (e) { try { B.E.master.disconnect(dest); } catch (_) {} return; }
  const chunks = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  rec.start(1000);
  screenRec = { rec, chunks, dest, round };
}
function stopScreen() {
  const s = screenRec;
  if (!s) return;
  screenRec = null;
  s.rec.onstop = () => {
    try { B.E.master.disconnect(s.dest); } catch (e) {}
    upload(new Blob(s.chunks, { type: 'video/webm' }), 'screen', s.round);
  };
  s.rec.stop();
}
async function upload(blob, kind, round) {
  if (!blob.size) return;
  try {
    const r = await fetch(`/api/upload?pid=${pid}&kind=${kind}&round=${round}`, { method: 'POST', body: blob });
    const j = await r.json();
    if (j.err) B.toast('Запись не сохранилась: ' + j.err);
  } catch (e) { B.toast('Запись не загрузилась на сервер'); }
}

// ================= действия =================
async function toggleReady() {
  const s = mySeat();
  if (!s) return;
  const on = !room.ready.includes(pid);
  if (on) {
    B.ensureAudio();
    // экран просим первым: браузер разрешает это только сразу после нажатия
    if (makesBeat(s) && !(await askScreen())) B.toast('Запись экрана выключена — как ты делал бит, не сохранится');
    if (raps(s) && !(await B.enableMic())) B.toast('Микрофон не включился — читать не получится');
  }
  send('ready', { on });
}
async function copyInvite() {
  const link = inviteLink();
  try { await navigator.clipboard.writeText(link); B.toast('Ссылка скопирована: ' + link); }
  catch (e) { window.prompt('Ссылка на комнату', link); }
}
function saveNick() {
  const v = (ov.querySelector('#btNick') || {}).value;
  const n = String(v || '').trim().slice(0, 20);
  if (!n) return;
  nick = n; localStorage.setItem('beatlab-nick', nick);
  send('nick', { nick, color });
  reconnect();
  B.toast('Ник: ' + nick);
}
function sendChat() {
  const inp = ov.querySelector('#btMsg');
  if (!inp || !inp.value.trim()) return;
  send('chat', { text: inp.value });
  inp.value = '';
}
async function leave() {
  shown = false;
  if (phase) { exitPhase(phase); phase = null; }
  await send('leave');
  room = null; setUrl(null);
  restoreStash();
  render();
}

const ACTS = {
  close() { shown = false; render(); },
  open() { shown = true; render(); },
  mode(el) { newMode = el.dataset.v; render(); },
  color(el) { color = el.dataset.v; localStorage.setItem('beatlab-color', color); send('nick', { nick, color }); render(); },
  nick: saveNick,
  create() { B.ensureAudio(); send('create', { mode: newMode, test: newTest }); },
  join(el) {
    const code = el.dataset.code || ((ov.querySelector('#btCode') || {}).value || '').trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) return B.toast('Код комнаты — 4 латинские буквы');
    B.ensureAudio();
    send('join', { code });
  },
  leave,
  seat(el) { send('seat', { team: el.dataset.team, i: +el.dataset.i }); },
  jury() { send('seat', { team: null }); },
  ready: toggleReady,
  start() { send('start'); },
  lobby() { send('lobby'); },
  invite: copyInvite,
  chat: sendChat,
  vote(el) { send('vote', { team: el.dataset.team }); },
  unmute() { if (listen && listen.audio) listen.audio.play().then(() => { listen.blocked = false; render(); }, () => {}); },
  preview() {
    if (previewing) { previewing = false; if (B.playing) B.stop(); return render(); }
    if (!teammateBeat) return;
    B.load(teammateBeat.json); playBeat(); previewing = true; render();
  },
  screen() { askScreen().then(render); },
};

// ================= интерфейс =================
const css = document.createElement('style');
css.textContent = `
  .bt{position:fixed;inset:0;z-index:45;background:#05050af2;display:flex;padding:14px;overflow:auto}
  .bt[hidden],.bthud[hidden]{display:none}
  .btbox{margin:auto;width:min(1100px,100%);background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px 18px}
  .bthead{display:flex;align-items:center;gap:12px;margin-bottom:12px}
  .bthead .logo{font-size:22px}
  .bthead .st{color:var(--mute);font-size:12px}
  .bt h3{margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--mute)}
  .btcard{background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:12px}
  .btgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
  .btgrid>.btcard{margin-bottom:0}
  .btsplit{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:12px}
  @media(max-width:820px){.btsplit{grid-template-columns:1fr}}
  .btrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .bt input[type=text]{background:#22222f;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:inherit;flex:1;min-width:0}
  .btnote{color:var(--mute);font-size:13px;margin:8px 0}
  .btcolors{display:flex;gap:6px;margin-top:10px}
  .btsw{width:24px;height:24px;border-radius:50%;border:2px solid transparent;cursor:pointer}
  .btsw.sel{border-color:#fff}
  .btroom{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--line)}
  .btroom:first-child{border-top:none}
  .btroom .code{font-weight:900;letter-spacing:.12em;font-size:16px;min-width:64px}
  .btroom .info{flex:1;color:var(--mute);font-size:13px}
  .btlive{color:var(--accent);font-weight:700}
  .btteams{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
  @media(max-width:820px){.btteams{grid-template-columns:1fr}}
  .btteams>.btcard{margin-bottom:0}
  .tA h3{color:#ff6b8f}.tB h3{color:#5cc8ff}
  .btseat{background:#22222f;border:1px solid var(--line);border-radius:10px;padding:10px;margin-top:8px;display:flex;flex-direction:column;gap:2px}
  .btseat small{color:var(--mute);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
  .btseat b{font-size:16px}
  .btseat.free{cursor:pointer;border-style:dashed}
  .btseat.free:hover{border-color:var(--accent)}
  .btseat.me{border-color:var(--accent)}
  .btseat .tag{font-size:12px;color:var(--mute)}
  .btok{color:#3ddc97;font-size:12px;font-weight:700}
  .btoff{color:#ffb02e;font-size:12px}
  .btwarn{color:#ffb02e;font-size:13px;margin:8px 0}
  .btchat .log{height:220px;overflow:auto;font-size:13px;display:flex;flex-direction:column;gap:3px;margin-bottom:8px;padding-right:4px}
  .btchat .sys{color:var(--mute);font-style:italic}
  .btscore{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:12px;text-align:center}
  .btscore .num{font-size:34px;font-weight:900;font-variant-numeric:tabular-nums}
  .btscore .tA{color:#ff6b8f;font-weight:700}.btscore .tB{color:#5cc8ff;font-weight:700}
  .btphase{text-align:center;color:var(--mute);text-transform:uppercase;letter-spacing:.1em;font-size:12px;margin-top:6px}
  .bttimer{text-align:center;font-size:44px;font-weight:900;font-variant-numeric:tabular-nums;margin:6px 0}
  .bttimer.big{font-size:84px;line-height:1}
  .bttimer.pre{color:var(--mute);font-size:30px}
  .bttimer.hot{color:var(--accent)}
  .btstage{text-align:center;padding:18px}
  .btstage .who{font-size:30px;font-weight:900;margin:4px 0 10px}
  .btmeter{height:10px;background:#22222f;border-radius:6px;overflow:hidden;margin:12px auto;max-width:420px}
  .btmeter i{display:block;height:100%;width:0;background:linear-gradient(90deg,#3ddc97,#ffb02e 70%,#ff3d6e);transition:width .08s}
  .btvote{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:10px}
  .btvote button{padding:22px 10px;font-size:18px;font-weight:900;border-radius:12px;cursor:pointer;border:2px solid var(--line);background:#22222f;color:var(--text)}
  .btvote button.tA:hover,.btvote button.tA.sel{border-color:#ff6b8f}
  .btvote button.tB:hover,.btvote button.tB.sel{border-color:#5cc8ff}
  .btvote button:disabled{opacity:.4;cursor:default}
  .btrounds div{display:flex;justify-content:space-between;padding:6px 0;border-top:1px solid var(--line);font-size:14px}
  .btrounds div:first-child{border-top:none}
  .btrec{display:flex;flex-direction:column;gap:6px;padding:10px 0;border-top:1px solid var(--line)}
  .btrec video{width:100%;max-height:340px;background:#000;border-radius:8px}
  .btrec audio{width:100%}
  .btrec a{color:var(--mute);font-size:12px}
  .btwin{text-align:center;font-size:28px;font-weight:900;margin:6px 0 12px}
  .bthud{position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:44;display:flex;align-items:center;gap:12px;
    background:#13131bf2;border:1px solid var(--accent);border-radius:12px;padding:8px 14px;box-shadow:0 8px 30px #0008;white-space:nowrap}
  .bthud .t{font-size:22px;font-weight:900;font-variant-numeric:tabular-nums;min-width:64px;text-align:center}
  .bthud .t.hot{color:var(--accent)}
  .bthud .m{color:var(--mute);font-size:13px}
  body.bt-hud .wrap{padding-top:72px}
  body.bt-live #projBtn,body.bt-live #share{display:none}
`;
document.head.append(css);

const ov = document.createElement('div');
ov.className = 'bt'; ov.id = 'bt'; ov.hidden = true;
ov.innerHTML = `<div class="btbox"><div class="bthead"><div class="logo">BEAT<span>LAB</span></div><b>Баттлы</b><span class="st"></span><span class="spacer"></span><button class="btn" data-act="close">Закрыть</button></div><div class="btbody"></div></div>`;
const hud = document.createElement('div');
hud.className = 'bthud'; hud.hidden = true;
document.body.append(ov, hud);
const body = ov.querySelector('.btbody');

const RULES = `<h3>Правила</h3>
  <div class="btnote" style="margin:0">Матч из 3 раундов, в каждом раунде новый бит с нуля. На бит — 5 минут.
  Выступление команды — до 1:30: 15 секунд бит разгоняется, потом 75 секунд читки по таймеру.
  Команды выходят по очереди, в каждом раунде первой выступает другая. После раунда голосует жюри — все в комнате, кто не играет.
  Побеждает тот, кто взял больше раундов. Пока делаешь бит, пишется экран, читка пишется звуком — после матча всё остаётся в комнате.
  Читай в наушниках, иначе бит из колонок попадёт в микрофон.</div>`;

function chatHtml() {
  const lines = room.chat.map(m => m.sys ? `<div class="sys">${esc(m.text)}</div>` : `<div><b style="color:${esc(m.color)}">${esc(m.nick)}</b> ${esc(m.text)}</div>`).join('');
  return `<div class="btcard btchat"><h3>Чат комнаты</h3><div class="log">${lines || '<div class="sys">Тут пока тихо</div>'}</div>
    <div class="btrow"><input type="text" id="btMsg" maxlength="200" placeholder="Сообщение"><button class="btn" data-act="chat">Отправить</button></div></div>`;
}
function teamNicks(t) { return room.seats[t].map(p => (p ? esc(nickOf(p)) : '—')).join(' и '); }

function lobbyView() {
  const list = rooms.length ? rooms.map(r => `<div class="btroom"><span class="code">${esc(r.code)}</span>
      <span class="info">${r.mode === '1v1' ? '1 на 1' : '2 на 2'} · игроков ${r.players}/${r.seats} · в комнате ${r.people}${r.test ? ' · тест' : ''} · создал ${esc(r.host)}
      ${r.status === 'live' ? ' · <span class="btlive">идёт матч</span>' : r.status === 'done' ? ' · матч окончен' : ''}</span>
      <button class="btn" data-act="join" data-code="${esc(r.code)}">${r.status === 'live' ? 'Смотреть' : 'Войти'}</button></div>`).join('')
    : '<div class="btnote">Открытых комнат пока нет — создай свою и кинь ссылку.</div>';
  return `<div class="btgrid">
    <div class="btcard"><h3>Ты</h3>
      <div class="btrow"><input type="text" id="btNick" maxlength="20" value="${esc(nick)}" placeholder="Ник"><button class="btn" data-act="nick">Сохранить</button></div>
      <div class="btcolors">${COLORS.map(c => `<button class="btsw${c === color ? ' sel' : ''}" style="background:${c}" data-act="color" data-v="${c}" title="Цвет ника"></button>`).join('')}</div>
    </div>
    <div class="btcard"><h3>Новая комната</h3>
      <div class="seg">${['1v1', '2v2'].map(m => `<button data-act="mode" data-v="${m}" class="${m === newMode ? 'sel' : ''}">${m === '1v1' ? '1 на 1' : '2 на 2'}</button>`).join('')}</div>
      <div class="btnote">${newMode === '1v1' ? 'Каждый сам делает бит и сам на нём читает.' : 'В команде двое: битмейкер делает бит, напарник на нём читает.'}</div>
      <label class="switch"><input type="checkbox" id="btTest" ${newTest ? 'checked' : ''}><span>Быстрый тест: бит 30 с, читка 15 с</span></label>
      <div class="btrow" style="margin-top:10px"><button class="btn primary" data-act="create">Создать комнату</button></div>
    </div>
  </div>
  <div class="btcard" style="margin-top:12px"><h3>Комнаты</h3>
    <div class="btrow" style="margin-bottom:8px"><input type="text" id="btCode" maxlength="4" placeholder="Код комнаты, например KQZX"><button class="btn" data-act="join">Войти по коду</button></div>
    ${list}
  </div>
  <div class="btcard">${RULES}</div>`;
}

function seatHtml(t, i, role) {
  const p = room.seats[t][i], m = p && member(p);
  const free = !p || (m && !m.online);
  const inner = p && m
    ? `<b style="color:${esc(m.color)}">${esc(m.nick)}${p === pid ? ' (ты)' : ''}</b>
       ${room.ready.includes(p) ? '<span class="btok">готов</span>' : '<span class="tag">не готов</span>'}${m.online ? '' : ' <span class="btoff">нет связи</span>'}`
    : '<b>Свободно</b><span class="tag">нажми, чтобы занять</span>';
  return `<div class="btseat${p === pid ? ' me' : ''}${free ? ' free' : ''}" ${free ? `data-act="seat" data-team="${t}" data-i="${i}"` : ''}>
    <small>${ROLE[role]}</small>${inner}</div>`;
}

function roomLobbyView() {
  const s = mySeat(), host = room.host === pid;
  const seatsAll = [...room.seats.A, ...room.seats.B];
  const juryList = room.members.filter(m => !seatsAll.includes(m.pid));
  const ready = room.ready.includes(pid);
  let why = '';
  if (seatsAll.some(p => !p)) why = 'Ждём, пока займут все места';
  else if (seatsAll.some(p => !(member(p) || {}).online)) why = 'Кто-то из игроков без связи';
  else if (seatsAll.some(p => !room.ready.includes(p))) why = 'Ждём, пока все нажмут «Готов»';
  const myJob = s ? (makesBeat(s) && raps(s) ? 'делаешь бит и читаешь' : makesBeat(s) ? 'делаешь бит' : 'читаешь на бите напарника') : '';
  return `<div class="btcard"><div class="btrow">
      <div style="flex:1"><h3 style="margin:0">Комната ${esc(room.code)} · ${room.mode === '1v1' ? '1 на 1' : '2 на 2'}${room.test ? ' · быстрый тест' : ''}</h3>
      <div class="btnote" style="margin:4px 0 0">Ссылка для друзей: ${esc(inviteLink())}</div></div>
      <button class="btn" data-act="invite">Скопировать ссылку</button><button class="btn" data-act="leave">Выйти</button></div></div>
    <div class="btsplit"><div>
      <div class="btteams">
        <div class="btcard tA"><h3>${TEAM.A}</h3>${room.roles.map((r, i) => seatHtml('A', i, r)).join('')}</div>
        <div class="btcard tB"><h3>${TEAM.B}</h3>${room.roles.map((r, i) => seatHtml('B', i, r)).join('')}</div>
        <div class="btcard"><h3>Жюри</h3>
          ${juryList.map(m => `<div class="btseat"><b style="color:${esc(m.color)}">${esc(m.nick)}${m.pid === pid ? ' (ты)' : ''}</b>${m.online ? '' : '<span class="btoff">нет связи</span>'}</div>`).join('') || '<div class="btnote">Пока никого</div>'}
          ${s ? '<div class="btrow" style="margin-top:8px"><button class="btn" data-act="jury">Перейти в жюри</button></div>' : ''}
        </div>
      </div>
      ${juryList.length ? '' : '<div class="btwarn">Жюри пока нет — без него раунды пройдут без оценки. Позови хотя бы одного человека по ссылке.</div>'}
      <div class="btcard" style="margin-top:12px">
        ${s ? `<div class="btnote" style="margin-top:0">Ты в команде ${s.team}: ${myJob}.
            ${ready ? '' : makesBeat(s) ? 'По кнопке «Готов» браузер спросит запись экрана — выбери эту вкладку.' : 'По кнопке «Готов» браузер спросит микрофон.'}</div>
          <div class="btrow"><button class="btn ${ready ? '' : 'primary'}" data-act="ready">${ready ? 'Не готов' : 'Готов'}</button>
          ${makesBeat(s) && ready ? (display ? '<span class="btok">экран пишется</span>' : '<button class="btn" data-act="screen">Включить запись экрана</button>') : ''}</div>`
          : '<div class="btnote" style="margin-top:0">Ты в жюри: после каждого раунда выбираешь, кто был сильнее. Чтобы играть — нажми на свободное место в команде.</div>'}
        <div class="btrow" style="margin-top:10px">${host
          ? `<button class="btn primary" data-act="start" ${why ? 'disabled' : ''}>Начать матч</button><span class="btnote">${why}</span>`
          : `<span class="btnote">Матч начнёт создатель комнаты — ${esc(nickOf(room.host))}</span>`}</div>
      </div>
      <div class="btcard">${RULES}</div>
    </div>${chatHtml()}</div>`;
}

function stageHtml(m) {
  const p = m.performer, mine = p === pid;
  let note;
  if (!p) note = 'Выступающий не на месте';
  else if (mine) note = perf && perf.mic ? 'Ты на сцене. Бит играет у тебя, вся комната слышит бит и твой голос.' : 'Ты на сцене. Микрофон не включён — комната слышит только бит.';
  else note = !listen ? '' : listen.got ? (listen.blocked ? 'Браузер не дал включить звук сам' : 'Звук идёт') : 'Подключаемся к выступающему…';
  return `<div class="btcard btstage t${m.team}">
    <h3>На сцене · ${TEAM[m.team]}${mine ? ' · это ты' : ''}</h3>
    <div class="who">${esc(nickOf(p))}</div>
    <div class="bttimer big" data-timer="phase"></div>
    <div class="btmeter"><i data-meter></i></div>
    <div class="btnote">${note}</div>
    ${listen && listen.blocked ? '<button class="btn primary" data-act="unmute">Включить звук</button>' : ''}
  </div>`;
}

function matchView() {
  const m = room.match, s = mySeat();
  let main = '';
  if (m.phase === 'prep') {
    main = `<div class="btcard btstage"><h3>Раунд ${m.round} из 3</h3>
      <div class="bttimer big" data-timer="phase"></div>
      <div class="btnote">${makesBeat(s) ? 'Сейчас откроется пустой проект — у тебя ${beatTime()} на бит. Твой прошлый бит сохранён и вернётся после матча.' : 'Битмейкеры готовятся. Каждый раунд — новый бит с нуля.'}</div></div>`;
  } else if (m.phase === 'beat') {
    const tb = teammateBeat;
    main = `<div class="btcard btstage"><h3>Раунд ${m.round} из 3 · битмейкеры делают биты</h3><div class="bttimer big" data-timer="phase"></div>
      ${makesBeat(s) ? '<button class="btn primary" data-act="close">Вернуться к биту</button>' : ''}</div>
      ${s && s.role === 'rap' ? `<div class="btcard"><h3>Бит напарника</h3>
        <div class="btnote">${tb ? 'Последняя версия пришла ' + fmt(Date.now() - tb.at) + ' назад' : 'Напарник ещё ничего не прислал'}. Пиши текст, пока он делает бит.</div>
        <button class="btn" data-act="preview" ${tb || previewing ? '' : 'disabled'}>${previewing ? 'Стоп' : 'Слушать последнюю версию'}</button></div>` : ''}`;
  } else if (m.phase === 'perf') {
    main = stageHtml(m);
  } else if (m.phase === 'vote') {
    const isJury = (m.jury || []).includes(pid), mv = m.voted.includes(pid);
    main = `<div class="btcard btstage"><h3>Раунд ${m.round} · голосует жюри</h3><div class="bttimer" data-timer="phase"></div>
      ${!m.jury.length ? '<div class="btnote">В комнате нет жюри — раунд без оценки.</div>'
        : isJury ? `<div class="btnote">${mv ? 'Голос принят. Можно передумать, пока идёт время.' : 'Кто был сильнее в этом раунде?'}</div>
          <div class="btvote">${['A', 'B'].map(t => `<button class="t${t}" data-act="vote" data-team="${t}">${TEAM[t]}<br><small style="font-weight:400">${teamNicks(t)}</small></button>`).join('')}</div>`
        : `<div class="btnote">Проголосовали ${m.voted.length} из ${m.jury.length}</div>`}</div>`;
  } else {
    main = doneHtml(m);
  }
  const rounds = m.rounds.length ? `<div class="btcard btrounds"><h3>Раунды</h3>${m.rounds.map(r => `<div><span>Раунд ${r.round}</span><span>${r.noJury ? 'без жюри' : `A ${r.A} — ${r.B} B`}</span><b>${r.winner ? 'взяла команда ' + r.winner : r.noJury ? '' : 'ничья'}</b></div>`).join('')}</div>` : '';
  return `<div class="btcard"><div class="btscore"><div class="tA">${TEAM.A}<br>${teamNicks('A')}</div><div class="num">${m.score.A} : ${m.score.B}</div><div class="tB">${TEAM.B}<br>${teamNicks('B')}</div></div>
      <div class="btphase">${m.phase === 'done' ? PHASE.done : `Раунд ${m.round} из 3 · ${PHASE[m.phase]}`} · комната ${esc(room.code)}${room.test ? ' · тест' : ''}</div></div>
    <div class="btsplit"><div>${main}${rounds}</div>${chatHtml()}</div>`;
}

function doneHtml(m) {
  const host = room.host === pid;
  const recs = room.records.length
    ? room.records.map(r => `<div class="btrec"><b>${esc(r.title)}</b><span data-media="${esc(r.url)}"></span>
        <a href="${esc(r.url)}" download>Скачать (${(r.size / 1048576).toFixed(1)} МБ)</a></div>`).join('')
    : '<div class="btnote">Записей нет — экран и микрофон не были включены.</div>';
  return `<div class="btcard"><div class="btwin">${m.winner ? `Победила команда ${m.winner}: ${teamNicks(m.winner)}` : 'Ничья'}</div>
      <div class="btrow" style="justify-content:center">
        ${host ? '<button class="btn primary" data-act="lobby">Реванш</button>' : ''}<button class="btn" data-act="leave">Выйти из комнаты</button></div>
      <div class="btnote" style="text-align:center">Биты из матча сохранены у битмейкеров в «Мои биты».</div></div>
    <div class="btcard"><h3>Записи матча</h3>${recs}</div>`;
}

function hudHtml() {
  const m = room.match;
  if (!m || m.phase === 'done') return `<b>Комната ${esc(room.code)}</b><span class="m">${m ? 'матч окончен' : 'ждём игроков'}</span><button class="btn" data-act="open">Открыть</button>`;
  return `<span class="m">Раунд ${m.round}/3 · ${m.phase === 'perf' ? 'выступает ' + esc(nickOf(m.performer)) : PHASE[m.phase]}</span>
    <span class="t" data-timer="phase"></span><span class="m">A ${m.score.A} : ${m.score.B} B</span><button class="btn" data-act="open">Комната</button>`;
}

// перерисовка не должна сбивать набранный текст и курсор
function render() {
  const s = mySeat();
  const forced = isLive() && !(room.match.phase === 'beat' && makesBeat(s));
  ov.hidden = !(forced || shown);
  ov.querySelector('[data-act=close]').hidden = !!forced;
  ov.querySelector('.st').textContent = connected ? '' : 'нет связи с сервером, переподключаемся…';
  hud.hidden = !room || !ov.hidden;
  document.body.classList.toggle('bt-hud', !hud.hidden);
  if (!hud.hidden) hud.innerHTML = hudHtml();
  if (!ov.hidden) {
    const act = document.activeElement, keep = {};
    for (const i of ov.querySelectorAll('input[type=text]')) keep[i.id] = i.value;
    const focus = act && act.id && ov.contains(act) ? { id: act.id, a: act.selectionStart, b: act.selectionEnd } : null;
    for (const el of media.values()) el.remove();
    body.innerHTML = !room ? (connected ? lobbyView() : '<div class="btnote">Подключаемся к серверу BEATLAB…</div>') : room.match ? matchView() : roomLobbyView();
    for (const id in keep) { const i = body.querySelector('#' + id); if (i && id !== 'btNick') i.value = keep[id]; }
    if (focus) { const i = body.querySelector('#' + focus.id); if (i) { i.focus(); try { i.setSelectionRange(focus.a, focus.b); } catch (e) {} } }
    for (const ph of body.querySelectorAll('[data-media]')) {
      const url = ph.dataset.media;
      let el = media.get(url);
      if (!el) {
        el = document.createElement(url.includes('-rap-') ? 'audio' : 'video');
        el.controls = true; el.preload = 'metadata'; el.src = url;
        media.set(url, el);
      }
      ph.replaceWith(el);
    }
    const log = body.querySelector('.btchat .log');
    if (log) log.scrollTop = log.scrollHeight;
  }
  tick();
}

const meterBuf = new Float32Array(1024);
function level(an) {
  if (!an) return 0;
  an.getFloatTimeDomainData(meterBuf);
  let p = 0;
  for (let i = 0; i < an.fftSize; i++) p = Math.max(p, Math.abs(meterBuf[i]));
  return Math.min(1, p * 1.2);
}
function tick() {
  if (!room || !room.match) return;
  const m = room.match, t = now();
  for (const el of document.querySelectorAll('[data-timer]')) {
    let txt, cls = '';
    if (m.phase === 'perf' && m.rapAt && t < m.rapAt) { txt = 'читка через ' + fmt(m.rapAt - t); cls = 'pre'; }
    else { const left = (m.endsAt || 0) - t; txt = m.endsAt ? fmt(left) : ''; if (left < 10000 && m.phase !== 'prep') cls = 'hot'; }
    if (el.textContent !== txt) el.textContent = txt;
    el.classList.toggle('pre', cls === 'pre' && el.classList.contains('big'));
    el.classList.toggle('hot', cls === 'hot');
  }
  const meter = ov.hidden ? null : ov.querySelector('[data-meter]');
  if (meter) {
    const an = perf ? B.mic && B.mic.analyser : listen && listen.an;
    meter.style.width = (level(an) * 100).toFixed(0) + '%';
  }
}
setInterval(tick, 100);
// раз в секунду — подписи «пришло N секунд назад»
setInterval(() => { if (room && room.match && room.match.phase === 'beat' && !ov.hidden && mySeat() && mySeat().role === 'rap') render(); }, 1000);

// клики и клавиши
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || !(ov.contains(el) || hud.contains(el))) return;
  if (el.disabled) return;
  const f = ACTS[el.dataset.act];
  if (f) f(el);
});
ov.addEventListener('change', e => { if (e.target.id === 'btTest') newTest = e.target.checked; });
ov.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'btMsg') sendChat();
  if (e.key === 'Enter' && e.target.id === 'btNick') saveNick();
  if (e.key === 'Enter' && e.target.id === 'btCode') ACTS.join(e.target);
  if (e.key === 'Escape' && !isLive()) ACTS.close();
  e.stopPropagation();   // горячие клавиши битмейкера под окном не срабатывают
});
window.addEventListener('keydown', e => {
  if (ov.hidden || ov.contains(e.target)) return;
  e.stopPropagation();
  if (e.code === 'Space') e.preventDefault();
}, true);

document.getElementById('battleBtn').addEventListener('click', () => { shown = true; connect(); render(); });

// сразу подключаемся, если пришли по ссылке на комнату или вкладка уже была в комнате / в матче
if (new URLSearchParams(location.search).get('room') || sessionStorage.getItem('bl-pid-room') || localStorage.getItem(STASH)) connect();
window.addEventListener('beforeunload', () => { if (room) sessionStorage.setItem('bl-pid-room', room.code); else sessionStorage.removeItem('bl-pid-room'); });

window.beatlabBattle = { get room() { return room; }, get pid() { return pid; }, get perf() { return perf; }, get listen() { return listen; }, send, connect };
})();
