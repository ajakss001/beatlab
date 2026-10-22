// Сервер BEATLAB: node serve.js → http://localhost:5173
// раздаёт битмейкер и держит комнаты баттлов (живые события — через Server-Sent Events, команды — POST /api/send)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 5173;
const REC_LIMIT = +process.env.REC_LIMIT || 4e9;   // записей на диске не больше ~4 ГБ (на хостинге меньше) — старые комнаты удаляются
const ROOT = __dirname;
const REC_DIR = path.join(ROOT, 'records');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.webm': 'video/webm', '.json': 'application/json',
};

// ================= игроки и комнаты =================
const clients = new Map();   // pid → { pid, nick, color, res (SSE-поток или null), room, offAt }
const rooms = new Map();     // код → комната

// режимы: места в каждой команде; both — сам делает бит и сам читает
const MODES = { '1v1': ['both'], '2v2': ['beat', 'rap'] };
// длительности фаз, секунды (тест — чтобы быстро прогнать весь матч)
const TIMES = test => test
  ? { prep: 4, beat: 30, intro: 5, rap: 15, vote: 12 }
  : { prep: 8, beat: 300, intro: 15, rap: 75, vote: 30 };

const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
const okColor = c => (/^#[0-9a-f]{6}$/i.test(c) ? c : '#ff3d6e');

function emit(pid, ev, data) {
  const c = clients.get(pid);
  if (c && c.res) c.res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
}

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do c = Array.from({ length: 4 }, () => A[crypto.randomInt(A.length)]).join(''); while (rooms.has(c));
  return c;
}

const seatOf = (r, pid) => {
  for (const t of ['A', 'B']) { const i = r.seats[t].indexOf(pid); if (i >= 0) return { team: t, role: MODES[r.mode][i], i }; }
  return null;
};
const performer = (r, team) => r.seats[team][MODES[r.mode].findIndex(x => x !== 'beat')];
const online = pid => !!(clients.get(pid) || {}).res;
const jury = r => r.members.filter(p => !seatOf(r, p) && online(p));

function roomView(r) {
  const m = r.match;
  return {
    code: r.code, mode: r.mode, test: r.test, host: r.host,
    members: r.members.map(p => { const c = clients.get(p) || {}; return { pid: p, nick: c.nick || '?', color: c.color || '#888', online: online(p) }; }),
    seats: r.seats, roles: MODES[r.mode], ready: [...r.ready], chat: r.chat.slice(-60), records: r.records,
    times: TIMES(r.test),
    match: m && {
      round: m.round, phase: m.phase, team: m.team || null, endsAt: m.endsAt, rapAt: m.rapAt || null,
      performer: m.team ? performer(r, m.team) : null,
      voted: Object.keys(m.votes), jury: m.jury || [], rounds: m.rounds, score: m.score, winner: m.winner,
    },
    now: Date.now(),
  };
}
const roomList = () => [...rooms.values()].map(r => ({
  code: r.code, mode: r.mode, test: r.test,
  players: ['A', 'B'].reduce((n, t) => n + r.seats[t].filter(Boolean).length, 0), seats: MODES[r.mode].length * 2,
  people: r.members.filter(online).length,
  status: !r.match ? 'lobby' : r.match.phase === 'done' ? 'done' : 'live',
  host: (clients.get(r.host) || {}).nick || '',
}));

function pushRoom(r) {
  const v = roomView(r);
  for (const p of r.members) emit(p, 'room', v);
  pushList();
}
let listT = 0;
function pushList() {   // список комнат — тем, кто сейчас не в комнате (не чаще 4 раз в секунду)
  if (listT) return;
  listT = setTimeout(() => {
    listT = 0;
    const l = roomList();
    for (const c of clients.values()) if (!c.room) emit(c.pid, 'rooms', l);
  }, 250);
}

function leaveRoom(pid) {
  const c = clients.get(pid);
  const r = c && c.room && rooms.get(c.room);
  if (c && c.room) { c.room = null; emit(pid, 'room', null); emit(pid, 'rooms', roomList()); }
  if (!r) return;
  r.members = r.members.filter(p => p !== pid);
  r.ready.delete(pid);
  // во время матча место остаётся за игроком (вдруг вернётся), в лобби — освобождаем
  if (!r.match || r.match.phase === 'done') for (const t of ['A', 'B']) r.seats[t] = r.seats[t].map(p => (p === pid ? null : p));
  if (r.host === pid) r.host = r.members.find(online) || r.members[0] || null;
  if (!r.members.length) { clearTimeout(r.match && r.match.timer); rooms.delete(r.code); pushList(); return; }
  pushRoom(r);
}

// ================= ход матча =================
function startMatch(r) {
  const P = TIMES(r.test), steps = [];
  for (let k = 1; k <= 3; k++) {
    const order = k % 2 ? ['A', 'B'] : ['B', 'A'];   // кто выступает первым — по очереди
    steps.push({ round: k, phase: 'prep', dur: P.prep }, { round: k, phase: 'beat', dur: P.beat });
    for (const team of order) steps.push({ round: k, phase: 'perf', team, dur: P.intro + P.rap, intro: P.intro });
    steps.push({ round: k, phase: 'vote', dur: P.vote });
  }
  r.match = { steps, i: -1, rounds: [], score: { A: 0, B: 0 }, votes: {}, winner: null };
  r.beats = { A: null, B: null };
  r.ready.clear();
  r.chat.push({ sys: true, text: 'Матч начался', t: Date.now() });
  advance(r);
}
function advance(r) {
  const m = r.match;
  clearTimeout(m.timer);
  if (m.phase === 'vote') tally(r);
  m.i++;
  if (m.i >= m.steps.length) {
    m.phase = 'done'; m.team = null; m.endsAt = null; m.rapAt = null;
    m.winner = m.score.A > m.score.B ? 'A' : m.score.B > m.score.A ? 'B' : null;
    r.chat.push({ sys: true, text: m.winner ? `Матч окончен. Победила команда ${m.winner}` : 'Матч окончен. Ничья', t: Date.now() });
    return pushRoom(r);
  }
  const s = m.steps[m.i], now = Date.now();
  m.round = s.round; m.phase = s.phase; m.team = s.team || null;
  let dur = s.dur;
  if (s.phase === 'beat') r.beats = { A: null, B: null };
  if (s.phase === 'vote') {
    m.votes = {};
    m.jury = jury(r);
    if (!m.jury.length) dur = 4;   // некому судить — раунд без оценки
  }
  m.endsAt = now + dur * 1000;
  m.rapAt = s.phase === 'perf' ? now + s.intro * 1000 : null;
  if (s.phase === 'perf') {
    // читающему из 2 на 2 — последний бит его битмейкера
    const p = performer(r, s.team), b = r.beats[s.team];
    if (b && p) emit(p, 'beat', { team: s.team, ...b });
  }
  m.timer = setTimeout(() => advance(r), dur * 1000);
  pushRoom(r);
}
function tally(r) {
  const m = r.match, cnt = { A: 0, B: 0 };
  for (const [p, t] of Object.entries(m.votes)) if (m.jury.includes(p)) cnt[t]++;
  const winner = !m.jury.length ? null : cnt.A > cnt.B ? 'A' : cnt.B > cnt.A ? 'B' : null;
  if (winner) m.score[winner]++;
  m.rounds.push({ round: m.round, A: cnt.A, B: cnt.B, winner, noJury: !m.jury.length });
}

// ================= команды от клиентов =================
const HANDLERS = {
  nick(c, d) {
    c.nick = clean(d.nick, 20) || c.nick; c.color = okColor(d.color);
    const r = rooms.get(c.room); if (r) pushRoom(r);
  },
  create(c, d) {
    leaveRoom(c.pid);
    const mode = MODES[d.mode] ? d.mode : '1v1';
    const r = {
      code: newCode(), mode, test: !!d.test, host: c.pid, members: [c.pid],
      seats: { A: MODES[mode].map(() => null), B: MODES[mode].map(() => null) },
      ready: new Set(), chat: [], records: [], match: null, beats: { A: null, B: null }, recN: 0,
    };
    r.seats.A[0] = c.pid;
    if (rooms.size >= 200) throw new Error('Сейчас слишком много комнат, попробуй чуть позже');
    rooms.set(r.code, r);
    c.room = r.code;
    pushRoom(r);
    return { code: r.code };
  },
  join(c, d) {
    const r = rooms.get(String(d.code || '').toUpperCase());
    if (!r) throw new Error('Комнаты с таким кодом нет');
    if (c.room !== r.code) { leaveRoom(c.pid); r.members.push(c.pid); c.room = r.code; }
    if (!r.host || !online(r.host)) r.host = c.pid;
    pushRoom(r);
  },
  leave(c) { leaveRoom(c.pid); },
  seat(c, d, r) {
    if (r.match && r.match.phase !== 'done') throw new Error('Матч уже идёт');
    const team = d.team, i = d.i;
    for (const t of ['A', 'B']) r.seats[t] = r.seats[t].map(p => (p === c.pid ? null : p));
    r.ready.delete(c.pid);
    if (team === 'A' || team === 'B') {
      if (!Number.isInteger(i) || i < 0 || i >= r.seats[team].length) throw new Error('Нет такого места');
      if (r.seats[team][i] && r.seats[team][i] !== c.pid && online(r.seats[team][i])) throw new Error('Место занято');
      r.seats[team][i] = c.pid;
    }
    pushRoom(r);
  },
  ready(c, d, r) {
    if (!seatOf(r, c.pid)) throw new Error('Сначала займи место в команде');
    d.on ? r.ready.add(c.pid) : r.ready.delete(c.pid);
    pushRoom(r);
  },
  start(c, d, r) {
    if (r.host !== c.pid) throw new Error('Начать может только создатель комнаты');
    if (r.match && r.match.phase !== 'done') throw new Error('Матч уже идёт');
    const all = [...r.seats.A, ...r.seats.B];
    if (all.some(p => !p || !online(p))) throw new Error('Не все места заняты');
    if (all.some(p => !r.ready.has(p))) throw new Error('Не все игроки нажали «Готов»');
    startMatch(r);
  },
  lobby(c, d, r) {   // после матча — назад в лобби (реванш)
    if (r.host !== c.pid) throw new Error('Только создатель комнаты');
    if (r.match && r.match.phase !== 'done') throw new Error('Матч ещё идёт');
    r.match = null; r.ready.clear();
    pushRoom(r);
  },
  chat(c, d, r) {
    const text = clean(d.text, 200);
    if (!text) return;
    r.chat.push({ nick: c.nick, color: c.color, text, t: Date.now() });
    if (r.chat.length > 200) r.chat.splice(0, r.chat.length - 200);
    pushRoom(r);
  },
  beat(c, d, r) {
    const s = seatOf(r, c.pid), m = r.match;
    if (!s || s.role === 'rap' || !m) throw new Error('Бит сейчас не принимается');
    // финальная версия может прийти чуть позже конца 5 минут — принимаем до начала читки
    const late = m.phase === 'perf' && (m.steps[m.i - 1] || {}).phase === 'beat' && Date.now() < m.rapAt;
    if (m.phase !== 'beat' && !(late && d.final)) throw new Error('Время на бит вышло');
    const json = String(d.json || '');
    if (json.length > 1.5e6) throw new Error('Бит слишком большой');
    const prev = r.beats[s.team];
    r.beats[s.team] = { json, v: (prev ? prev.v : 0) + 1, final: !!d.final, round: m.round };
    for (const p of r.seats[s.team]) if (p && p !== c.pid) emit(p, 'beat', { team: s.team, ...r.beats[s.team] });
  },
  vote(c, d, r) {
    const m = r.match;
    if (!m || m.phase !== 'vote') throw new Error('Сейчас не голосование');
    if (!m.jury.includes(c.pid)) throw new Error('Голосует только жюри');
    if (d.team !== 'A' && d.team !== 'B') throw new Error('Выбери команду');
    m.votes[c.pid] = d.team;
    if (m.jury.every(p => m.votes[p] || !online(p))) return void advance(r);
    pushRoom(r);
  },
  rtc(c, d, r) {   // пересылка WebRTC-сигналов между участниками одной комнаты
    if (!r.members.includes(d.to)) return;
    emit(d.to, 'rtc', { from: c.pid, data: d.data });
  },
};

function readBody(req, limit) {
  return new Promise((ok, bad) => {
    const parts = []; let n = 0;
    req.on('data', b => { n += b.length; if (n > limit) { bad(new Error('Слишком большой запрос')); req.destroy(); } else parts.push(b); });
    req.on('end', () => ok(Buffer.concat(parts)));
    req.on('error', bad);
  });
}
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

async function api(req, res, url) {
  const q = url.searchParams;
  if (url.pathname === '/api/events') {
    const pid = clean(q.get('pid'), 40);
    if (!/^[\w-]{8,40}$/.test(pid)) return json(res, 400, { err: 'bad pid' });
    let c = clients.get(pid);
    if (!c && clients.size >= 3000) return json(res, 503, { err: 'Сервер переполнен' });
    if (!c) clients.set(pid, (c = { pid, nick: 'Игрок', color: '#ff3d6e', res: null, room: null }));
    c.nick = clean(q.get('nick'), 20) || c.nick; c.color = okColor(q.get('color'));
    if (c.res) c.res.end();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    c.res = res; c.offAt = 0;
    const r = rooms.get(c.room);
    if (!r && c.room) c.room = null;
    emit(pid, 'hello', { pid, now: Date.now(), room: r ? roomView(r) : null, rooms: roomList() });
    if (r) pushRoom(r);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      if (c.res !== res) return;
      c.res = null; c.offAt = Date.now();
      const rr = rooms.get(c.room);
      if (rr) pushRoom(rr);
    });
    return;
  }
  if (url.pathname === '/api/send' && req.method === 'POST') {
    let d;
    try { d = JSON.parse((await readBody(req, 2e6)).toString('utf8')); } catch (e) { return json(res, 400, { err: 'Не удалось прочитать запрос' }); }
    const c = clients.get(d.pid), h = HANDLERS[d.t];
    if (!c || !h) return json(res, 400, { err: 'Нет соединения с сервером — обнови страницу' });
    const r = rooms.get(c.room);
    if (!['nick', 'create', 'join', 'leave'].includes(d.t) && !r) return json(res, 400, { err: 'Ты не в комнате' });
    try { return json(res, 200, { ok: true, ...(h(c, d, r) || {}) }); } catch (e) { return json(res, 400, { err: e.message }); }
  }
  if (url.pathname === '/api/upload' && req.method === 'POST') {
    // запись экрана / читки после фазы — сохраняем на память в records/<комната>/
    const c = clients.get(q.get('pid')), r = c && rooms.get(c.room);
    if (!r || !r.match) return json(res, 400, { err: 'Ты не в матче' });
    let body;
    if (r.records.length >= 60) return json(res, 400, { err: 'В комнате уже слишком много записей' });
    // через Cloudflare-туннель запрос не может быть больше 100 МБ
    try { body = await readBody(req, 95e6); } catch (e) { return json(res, 413, { err: e.message }); }
    const kind = q.get('kind') === 'rap' ? 'rap' : 'screen';
    const round = Math.max(1, Math.min(3, +q.get('round') || 1));
    const s = seatOf(r, c.pid);
    const dir = path.join(REC_DIR, r.code);
    pruneRecords(r.code, body.length);
    fs.mkdirSync(dir, { recursive: true });
    const name = `${++r.recN}-r${round}-${kind}-${c.pid.slice(0, 6)}.webm`;
    fs.writeFileSync(path.join(dir, name), body);
    r.records.push({
      url: `/records/${r.code}/${name}`, kind, round, nick: c.nick, team: s ? s.team : null,
      size: body.length, title: `Раунд ${round} · ${kind === 'rap' ? 'читка' : 'как делал бит'} · ${c.nick}${s ? ' · команда ' + s.team : ''}`,
    });
    pushRoom(r);
    return json(res, 200, { ok: true });
  }
  json(res, 404, { err: 'not found' });
}

// место на диске: если записей стало слишком много — удаляем самые старые комнаты целиком
function pruneRecords(keep, incoming) {
  let dirs;
  try { dirs = fs.readdirSync(REC_DIR, { withFileTypes: true }).filter(d => d.isDirectory()); } catch (e) { return; }
  const list = dirs.map(d => {
    const p = path.join(REC_DIR, d.name);
    let size = 0, t = 0;
    for (const f of fs.readdirSync(p)) { const st = fs.statSync(path.join(p, f)); size += st.size; t = Math.max(t, st.mtimeMs); }
    return { name: d.name, p, size, t };
  }).sort((a, b) => a.t - b.t);
  let total = list.reduce((n, d) => n + d.size, 0) + incoming;
  for (const d of list) {
    if (total <= REC_LIMIT) break;
    if (d.name === keep) continue;
    fs.rmSync(d.p, { recursive: true, force: true });
    const r = rooms.get(d.name);
    if (r) { r.records = []; pushRoom(r); }
    total -= d.size;
  }
}

// чистим тех, кто ушёл: из лобби — через 20 с без связи, пустые комнаты — сразу
setInterval(() => {
  const now = Date.now();
  for (const c of clients.values()) {
    if (c.res || !c.offAt) continue;
    const r = rooms.get(c.room);
    const live = r && r.match && r.match.phase !== 'done';
    if (now - c.offAt > (live ? 10 * 60e3 : 20e3)) { leaveRoom(c.pid); clients.delete(c.pid); }
  }
}, 5000);

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    return api(req, res, url).catch(e => { try { json(res, 500, { err: e.message }); } catch (_) {} });
  }
  const p = decodeURIComponent(url.pathname);
  const file = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!file.startsWith(ROOT + path.sep) || path.basename(file) === 'serve.js') { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`BEAT LAB: http://localhost:${PORT}`));
