'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');

try {
  const envText = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !Object.hasOwn(process.env, match[1])) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}

const PORT = Number(process.env.PORT) || 3000;
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const ROOT = path.resolve(__dirname, '..');
const DATA_FILE = process.env.DATA_FILE
  ? path.resolve(__dirname, process.env.DATA_FILE)
  : path.join(__dirname, 'data', 'profiles.json');
const ALLOWED_ORIGINS = (process.env.CLIENT_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
const HEROES = {
  balanced: { hp: 100, speed: 5.8, damage: 22, cooldown: 0.50, range: 9 },
  sniper: { hp: 70, speed: 5.6, damage: 55, cooldown: 1.35, range: 22 },
  tank: { hp: 230, speed: 4.3, damage: 20, cooldown: 0.65, range: 10 },
  trickster: { hp: 65, speed: 7.6, damage: 20, cooldown: 0.45, range: 11 },
  edgar: { hp: 80, speed: 7.3, damage: 14, cooldown: 0.26, range: 5.5 },
  colette: { hp: 110, speed: 5.6, damage: 12, cooldown: 0.50, range: 9 },
  mortis: { hp: 95, speed: 6.2, damage: 24, cooldown: 0.50, range: 4.5 },
  max: { hp: 75, speed: 7.0, damage: 17, cooldown: 0.40, range: 11 },
  star: { hp: 70, speed: 5.5, damage: 30, cooldown: 0.85, range: 19 },
  nova: { hp: 120, speed: 5.3, damage: 21, cooldown: 0.60, range: 12 },
  prism: { hp: 105, speed: 6.1, damage: 18, cooldown: 0.72, range: 13 },
  warden: { hp: 155, speed: 4.9, damage: 18, cooldown: 0.72, range: 12 },
  ember: { hp: 112, speed: 5.7, damage: 25, cooldown: 0.56, range: 10.5 },
  rift: { hp: 88, speed: 6.7, damage: 23, cooldown: 0.48, range: 8.5 }
};
const EMOTES = {
  gg: 'لعب جميل! ✨', hello: 'أهلًا! 👋', attack: 'هجوم! ⚔️',
  defend: 'دافعوا عن الموقع! 🛡️', thanks: 'شكرًا! 💙'
};

function readProfiles() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return {}; }
}
let profiles = readProfiles();
let saveQueued = false;
function saveProfiles() {
  if (saveQueued) return;
  saveQueued = true;
  setTimeout(() => {
    saveQueued = false;
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(profiles, null, 2));
      fs.renameSync(tmp, DATA_FILE);
    } catch (err) { console.error('Could not save player profiles:', err.message); }
  }, 80).unref?.();
}

function b64(value) { return Buffer.from(value).toString('base64url'); }
function sign(value) { return crypto.createHmac('sha256', SECRET).update(value).digest('base64url'); }
function issueToken(id, name) {
  const payload = b64(JSON.stringify({ id, name, exp: Date.now() + 1000 * 60 * 60 * 24 * 365 }));
  return payload + '.' + sign(payload);
}
function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() && /^[a-f0-9-]{36}$/i.test(data.id) ? data : null;
  } catch { return null; }
}
function cleanName(value) {
  return String(value || 'مقاتل').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 20) || 'مقاتل';
}
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function finite(n, fallback = 0) { return Number.isFinite(Number(n)) ? Number(n) : fallback; }
function newPlayer(id, name, heroId, socketId) {
  const hero = HEROES[heroId] ? heroId : 'balanced';
  const stats = HEROES[hero];
  return {
    id, name: cleanName(name), heroId: hero, team: 0,
    x: (Math.random() - 0.5) * 8, z: (Math.random() - 0.5) * 8,
    vx: 0, vz: 0, angle: 0, hp: stats.hp, maxHp: stats.hp,
    kills: 0, deaths: 0, dead: false, respawnAt: 0, shieldUntil: 0,
    shotAt: 0, abilityAt: 0, pendingAbility: false, input: {}, socketId, disconnectedAt: 0,
    isBot: false, lastEmote: 0, joinAt: Date.now()
  };
}

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  const origin = req.get('Origin');
  if (!ALLOWED_ORIGINS.length) res.setHeader('Access-Control-Allow-Origin', '*');
  else if (!origin || ALLOWED_ORIGINS.includes(origin)) {
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '8kb' }));
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      if (!origin || !ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      return callback(new Error('Origin is not allowed by CLIENT_ORIGIN'));
    },
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 16 * 1024
});
const rooms = new Map();
const playerRooms = new Map();

app.get('/health', (_req, res) => res.json({ ok: true, game: 'Shardfall Arena', rooms: rooms.size }));
app.post('/api/session', (req, res) => {
  const name = cleanName(req.body && req.body.name);
  const old = verifyToken(req.body && req.body.token);
  const id = old ? old.id : crypto.randomUUID();
  const profile = profiles[id] || (profiles[id] = { name, matches: 0, wins: 0, kills: 0, trophies: 0, lastSeen: Date.now() });
  profile.name = name;
  profile.lastSeen = Date.now();
  saveProfiles();
  res.json({ playerId: id, name, token: issueToken(id, name), stats: { matches: profile.matches, wins: profile.wins, kills: profile.kills, trophies: profile.trophies } });
});
app.get('/net-client.js', (_req, res) => res.sendFile(path.join(ROOT, 'net-client.js')));
app.get('/net-client-04.js', (_req, res) => res.sendFile(path.join(ROOT, 'net-client-04.js')));
app.get('/net-client-05.js', (_req, res) => res.sendFile(path.join(ROOT, 'net-client-05.js')));
app.get('/health', (_req, res) => res.json({ ok: true, game: 'Shardfall Arena v9' }));
app.get('/', (_req, res) => res.sendFile(path.join(ROOT, 'Shardfall_Arena_v9.html')));

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join(''); }
  while (rooms.has(code));
  return code;
}
function getRoomForSocket(socket) {
  const code = playerRooms.get(socket.data.playerId);
  return code && rooms.get(code);
}
function roomMembers(room) { return [...room.players.values()].filter(p => !p.disconnectedAt); }
function publicPlayer(p) {
  return { id: p.id, name: p.name, heroId: p.heroId, team: p.team, x: p.x, z: p.z, vx: p.vx, vz: p.vz, angle: p.angle, hp: p.hp, maxHp: p.maxHp, kills: p.kills, deaths: p.deaths, dead: p.dead, shield: p.shieldUntil > Date.now(), bot: p.isBot };
}
function lobbyState(room) {
  return { code: room.code, status: room.status, mapIndex: room.mapIndex, players: roomMembers(room).map(p => ({ id: p.id, name: p.name, heroId: p.heroId, bot: p.isBot })), maxPlayers: 6 };
}
function createRoom() {
  const room = { code: makeCode(), players: new Map(), status: 'waiting', mapIndex: Math.floor(Math.random() * 8), startedAt: 0, endAt: 0, timer: null, lastTick: Date.now(), lastSnapshot: 0, scores: new Map() };
  rooms.set(room.code, room);
  room.timer = setInterval(() => tickRoom(room), 50);
  return room;
}
function addHuman(room, session, socket, heroId) {
  let p = room.players.get(session.id);
  if (p) {
    p.socketId = socket.id; p.disconnectedAt = 0; p.input = {};
    p.name = session.name;
    if (room.status !== 'playing') p.heroId = HEROES[heroId] ? heroId : p.heroId;
  } else {
    if (room.players.size >= 6) return null;
    p = newPlayer(session.id, session.name, heroId, socket.id);
    p.team = room.players.size;
    room.players.set(p.id, p);
    playerRooms.set(p.id, room.code);
  }
  socket.join(room.code);
  socket.data.roomCode = room.code;
  return p;
}
function emitLobby(room) { io.to(room.code).emit('lobby:update', lobbyState(room)); }
function startRoom(room) {
  if (room.status === 'playing' || !room.players.size) return;
  const members = roomMembers(room);
  if (members.length < 2) {
    // Fill remaining seats with clearly marked server-controlled bots.
    while (room.players.size < 4) {
      const id = 'bot-' + crypto.randomUUID();
      const heroIds = Object.keys(HEROES);
      const heroId = heroIds[Math.floor(Math.random() * heroIds.length)];
      const bot = newPlayer(id, ['حارس الساحة', 'ظلّ العاصفة', 'مستكشف'][Math.floor(Math.random() * 3)], heroId, '');
      bot.id = id; bot.isBot = true; bot.team = room.players.size; bot.x = (Math.random() - .5) * 14; bot.z = (Math.random() - .5) * 14;
      room.players.set(id, bot);
    }
  }
  room.status = 'playing'; room.startedAt = Date.now(); room.endAt = room.startedAt + 180000; room.lastTick = Date.now();
  for (const p of room.players.values()) room.scores.set(p.id, 0);
  io.to(room.code).emit('match:started', { code: room.code, mapIndex: room.mapIndex, duration: 180, players: [...room.players.values()].map(publicPlayer) });
}
function endRoom(room, winnerId, reason = 'score') {
  if (room.status !== 'playing') return;
  room.status = 'ended';
  const rank = [...room.players.values()].sort((a, b) => (room.scores.get(b.id) || 0) - (room.scores.get(a.id) || 0) || Number(b.id === winnerId) - Number(a.id === winnerId));
  for (const p of room.players.values()) {
    if (p.isBot) continue;
    const profile = profiles[p.id] || (profiles[p.id] = { name: p.name, matches: 0, wins: 0, kills: 0, trophies: 0 });
    profile.name = p.name; profile.matches = (profile.matches || 0) + 1;
    profile.kills = (profile.kills || 0) + p.kills;
    if (p.id === winnerId) { profile.wins = (profile.wins || 0) + 1; profile.trophies = (profile.trophies || 0) + 25; }
  }
  saveProfiles();
  io.to(room.code).emit('match:ended', {
    winnerId: winnerId || null, reason,
    summary: `المركز الأول: ${room.players.get(winnerId)?.name || 'لا أحد'} • ${rank.map(p => `${p.name}: ${p.kills}`).join('  |  ')}`
  });
  setTimeout(() => removeRoom(room), 12000).unref?.();
}
function removeRoom(room) {
  clearInterval(room.timer);
  for (const p of room.players.values()) {
    if (!p.isBot) playerRooms.delete(p.id);
  }
  rooms.delete(room.code);
}
function nearestEnemy(room, p) {
  let chosen = null, best = Infinity;
  for (const q of room.players.values()) {
    if (q.id === p.id || q.dead || q.disconnectedAt) continue;
    const d = Math.hypot(q.x - p.x, q.z - p.z);
    if (d < best) { best = d; chosen = q; }
  }
  return chosen;
}
function shoot(room, p, now) {
  const cfg = HEROES[p.heroId] || HEROES.balanced;
  if (now - p.shotAt < cfg.cooldown * 1000) return;
  const ax = p.input.ax, az = p.input.az;
  if (Math.hypot(ax, az) < .2) return;
  let target = null, score = Infinity;
  for (const q of room.players.values()) {
    if (q.id === p.id || q.dead || q.disconnectedAt) continue;
    const dx = q.x - p.x, dz = q.z - p.z, d = Math.hypot(dx, dz);
    if (d > cfg.range) continue;
    const dot = (dx / (d || 1)) * ax + (dz / (d || 1)) * az;
    const hitScore = d + (1 - dot) * 8;
    if (dot > .91 && hitScore < score) { score = hitScore; target = q; }
  }
  p.shotAt = now;
  if (!target) return;
  const critical = score < 2.6;
  const damage = cfg.damage * (critical ? 1.35 : 1);
  applyDamage(room, p, target, damage, now, critical);
}
function applyDamage(room, attacker, target, amount, now, critical = false) {
  if (!target || target.dead) return;
  target.hp = Math.max(0, target.hp - (target.shieldUntil > now ? amount * .45 : amount));
  const killed = target.hp <= 0;
  io.to(room.code).emit('combat:event', { x: target.x, z: target.z, color: 0x8df7ff, critical, victim: target.id, attacker: attacker.id, killed });
  if (killed) {
    target.dead = true; target.deaths++; target.respawnAt = now + 2600; target.input = {};
    attacker.kills++; room.scores.set(attacker.id, (room.scores.get(attacker.id) || 0) + 1);
    if ((room.scores.get(attacker.id) || 0) >= 10) endRoom(room, attacker.id);
  }
}
function ability(room, p, now) {
  if (now < p.abilityAt || p.dead) return;
  const cooldowns = { tank: 9000, trickster: 11000, edgar: 4000, colette: 6000, mortis: 7000, max: 8000, sniper: 6000, star: 6000, nova: 7000, prism: 8000, warden: 9000, ember: 7500, rift: 8500 };
  p.abilityAt = now + (cooldowns[p.heroId] || 5000);
  const color = p.heroId === 'ember' ? 0xff7036 : p.heroId === 'rift' ? 0x72e6ff : p.heroId === 'prism' ? 0x8df7ff : p.heroId === 'warden' ? 0xb294ff : 0xf3b5ff;
  const target = nearestEnemy(room, p);
  if (p.heroId === 'tank') p.shieldUntil = now + 3000;
  else if (p.heroId === 'max') p.speedUntil = now + 3500;
  else if (p.heroId === 'trickster' && target) {
    const dx = target.x - p.x, dz = target.z - p.z, d = Math.hypot(dx, dz) || 1;
    p.x = clamp(target.x - dx / d * 3.5, -40, 40); p.z = clamp(target.z - dz / d * 3.5, -40, 40); p.shieldUntil = now + 700;
  } else if ((p.heroId === 'edgar' || p.heroId === 'mortis') && target) {
    const dx = target.x - p.x, dz = target.z - p.z, d = Math.hypot(dx, dz) || 1;
    p.x = clamp(p.x + dx / d * Math.min(4.5, d), -40, 40); p.z = clamp(p.z + dz / d * Math.min(4.5, d), -40, 40);
    if (d < 6.5) applyDamage(room, p, target, p.heroId === 'edgar' ? 38 : 32, now, true);
  } else if (p.heroId === 'sniper' || p.heroId === 'colette') {
    if (target) {
      const dx = target.x - p.x, dz = target.z - p.z, d = Math.hypot(dx, dz) || 1;
      const dot = (dx / d) * (p.input.ax || 0) + (dz / d) * (p.input.az || 0);
      if (d < (p.heroId === 'sniper' ? 22 : 13) && dot > .84)
        applyDamage(room, p, target, p.heroId === 'sniper' ? 72 : Math.max(24, target.maxHp * .28), now, true);
    }
  } else if (p.heroId === 'prism') {
    p.hp = Math.min(p.maxHp, p.hp + 35);
  } else if (p.heroId === 'ember') {
    const ax = p.input.ax, az = p.input.az;
    for (const q of room.players.values()) {
      if (q.id === p.id || q.dead || q.disconnectedAt) continue;
      const dx = q.x - p.x, dz = q.z - p.z, d = Math.hypot(dx, dz) || 1;
      if (d < 16 && (dx / d) * ax + (dz / d) * az > .66) applyDamage(room, p, q, 20, now, true);
    }
  } else if (p.heroId === 'rift') {
    const ax = p.input.ax, az = p.input.az; p.x = clamp(p.x + ax * 6, -40, 40); p.z = clamp(p.z + az * 6, -40, 40);
  }
  const radius = p.heroId === 'rift' ? 4.15 : p.heroId === 'warden' ? 4.5 : p.heroId === 'nova' || p.heroId === 'star' ? 5.5 : p.heroId === 'prism' ? 3.2 : 2.8;
  for (const q of room.players.values()) {
    if (q.id === p.id || q.dead || q.disconnectedAt) continue;
    const d = Math.hypot(q.x - p.x, q.z - p.z);
    if (d < radius && !['tank', 'max', 'trickster', 'edgar', 'mortis', 'sniper', 'colette', 'ember'].includes(p.heroId))
      applyDamage(room, p, q, p.heroId === 'rift' ? 42 : p.heroId === 'warden' ? 34 : p.heroId === 'nova' ? 46 : p.heroId === 'star' ? 42 : 24, now, true);
    if (room.status !== 'playing') break;
  }
  io.to(room.code).emit('combat:event', { x: p.x, z: p.z, color, critical: true, victim: '' });
}
function botThink(room, bot, now) {
  if (bot.dead) return;
  const target = nearestEnemy(room, bot);
  if (!target) return;
  const dx = target.x - bot.x, dz = target.z - bot.z, d = Math.hypot(dx, dz) || 1;
  const ideal = 5.5 + (bot.team % 3);
  const dir = d > ideal ? 1 : d < 3.2 ? -0.35 : 0;
  bot.input.mx = dx / d * dir; bot.input.mz = dz / d * dir;
  bot.input.ax = dx / d; bot.input.az = dz / d;
  bot.angle = Math.atan2(bot.input.ax, bot.input.az);
  if (d < (HEROES[bot.heroId] || HEROES.balanced).range) shoot(room, bot, now);
  if (d < 4 && Math.random() < .008) ability(room, bot, now);
}
function tickRoom(room) {
  if (room.status === 'waiting') {
    if (roomMembers(room).length >= 2) startRoom(room);
    else if (Date.now() - room.createdAt >= 12000 && roomMembers(room).length) startRoom(room);
    else { if (Date.now() - room.createdAt > 30000 && !roomMembers(room).length) removeRoom(room); return; }
  }
  if (room.status !== 'playing') return;
  const now = Date.now(), dt = clamp((now - room.lastTick) / 1000, .015, .09); room.lastTick = now;
  for (const p of room.players.values()) {
    if (p.disconnectedAt && now - p.disconnectedAt > 30000) { room.players.delete(p.id); playerRooms.delete(p.id); continue; }
    if (p.dead) {
      if (now >= p.respawnAt) { p.dead = false; p.hp = p.maxHp; p.x = (Math.random() - .5) * 12; p.z = (Math.random() - .5) * 12; p.vx = p.vz = 0; }
      continue;
    }
    if (p.isBot) botThink(room, p, now);
    const speed = (HEROES[p.heroId] || HEROES.balanced).speed * (p.speedUntil > now ? 1.5 : 1);
    const mx = p.input.mx || 0, mz = p.input.mz || 0, length = Math.hypot(mx, mz) || 1;
    const targetVx = (Math.abs(mx) + Math.abs(mz) > .01 ? mx / length * speed : 0);
    const targetVz = (Math.abs(mx) + Math.abs(mz) > .01 ? mz / length * speed : 0);
    const blend = 1 - Math.exp(-12 * dt);
    p.vx += (targetVx - p.vx) * blend; p.vz += (targetVz - p.vz) * blend;
    p.x = clamp(p.x + p.vx * dt, -40, 40); p.z = clamp(p.z + p.vz * dt, -40, 40);
    p.angle = Math.atan2(p.input.ax || Math.sin(p.angle), p.input.az || Math.cos(p.angle));
    if (p.pendingAbility) { p.pendingAbility = false; ability(room, p, now); }
    if (p.input.fire) shoot(room, p, now);
    if (room.status !== 'playing') break;
  }
  if (room.status !== 'playing') return;
  if (now >= room.endAt) {
    const winner = [...room.scores.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]; endRoom(room, winner, 'time'); return;
  }
  if (now - room.lastSnapshot >= 50) {
    room.lastSnapshot = now;
    io.to(room.code).volatile.emit('match:snapshot', { remaining: Math.max(0, (room.endAt - now) / 1000), players: [...room.players.values()].map(publicPlayer) });
  }
}

io.use((socket, next) => {
  const session = verifyToken(socket.handshake.auth && socket.handshake.auth.token);
  if (!session) return next(new Error('الجلسة غير صالحة؛ أعد تسجيل الدخول كضيف.'));
  socket.data.playerId = session.id;
  socket.data.playerName = cleanName(session.name);
  next();
});
io.on('connection', socket => {
  const id = socket.data.playerId;
  const room = rooms.get(playerRooms.get(id));
  if (room) {
    addHuman(room, { id, name: socket.data.playerName }, socket, 'balanced');
    socket.emit('match:resumed', { code: room.code, status: room.status, mapIndex: room.mapIndex, playerId: id, players: [...room.players.values()].map(publicPlayer) });
    if (room.status === 'playing') socket.emit('match:started', { code: room.code, mapIndex: room.mapIndex, duration: Math.max(0, (room.endAt - Date.now()) / 1000), players: [...room.players.values()].map(publicPlayer) });
    emitLobby(room);
  }

  socket.on('match:join', (data = {}, ack = () => {}) => {
    const name = cleanName(data.name || socket.data.playerName);
    const heroId = HEROES[data.heroId] ? data.heroId : 'balanced';
    let targetRoom;
    const requested = String(data.roomCode || '').trim().toUpperCase();
    if (requested) {
      targetRoom = rooms.get(requested);
      if (!targetRoom || targetRoom.status !== 'waiting') return ack({ error: 'رمز الغرفة غير موجود أو بدأت المباراة.' });
    } else {
      targetRoom = [...rooms.values()].find(r => r.status === 'waiting' && roomMembers(r).length < 6) || createRoom();
      targetRoom.createdAt ||= Date.now();
    }
    if (targetRoom.players.size >= 6 && !targetRoom.players.has(id)) return ack({ error: 'الغرفة مكتملة.' });
    const player = addHuman(targetRoom, { id, name }, socket, heroId);
    if (!player) return ack({ error: 'تعذر الانضمام إلى الغرفة.' });
    socket.data.playerName = name;
    ack({ ok: true, code: targetRoom.code, playerId: id, state: lobbyState(targetRoom) });
    emitLobby(targetRoom);
    if (roomMembers(targetRoom).length >= 2) startRoom(targetRoom);
  });

  let inputAt = 0;
  socket.on('player:input', data => {
    const now = Date.now(); if (now - inputAt < 28) return; inputAt = now;
    const room = getRoomForSocket(socket), p = room && room.players.get(id);
    if (!p || room.status !== 'playing' || p.dead) return;
    const mx = clamp(finite(data && data.mx), -1, 1), mz = clamp(finite(data && data.mz), -1, 1);
    const ax = clamp(finite(data && data.ax), -1, 1), az = clamp(finite(data && data.az), -1, 1);
    const len = Math.hypot(ax, az) || 1;
    p.pendingAbility ||= data.ability === true;
    p.input = { mx, mz, ax: ax / len, az: az / len, fire: data.fire === true };
  });
  socket.on('chat:emote', key => {
    const room = getRoomForSocket(socket), p = room && room.players.get(id), now = Date.now();
    if (!p || now - p.lastEmote < 2500 || !Object.hasOwn(EMOTES, key)) return;
    p.lastEmote = now; io.to(room.code).emit('chat:emote', { playerId: id, name: p.name, text: EMOTES[key] });
  });
  socket.on('match:leave', () => {
    const room = getRoomForSocket(socket); if (!room) return;
    const p = room.players.get(id); if (p) { room.players.delete(id); playerRooms.delete(id); }
    socket.leave(room.code); emitLobby(room);
    if (!room.players.size) removeRoom(room);
    else if (room.status === 'playing' && ![...room.players.values()].some(x => !x.isBot && !x.disconnectedAt)) endRoom(room, null, 'abandoned');
  });
  socket.on('net:ping', ack => { if (typeof ack === 'function') ack(Date.now()); });
  socket.on('disconnect', () => {
    const room = getRoomForSocket(socket), p = room && room.players.get(id);
    if (p && p.socketId === socket.id) { p.disconnectedAt = Date.now(); p.input = {}; }
  });
});

server.listen(PORT, () => console.log(`Shardfall Arena ready at http://localhost:${PORT}`));
