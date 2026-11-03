'use strict';

const crypto = require('node:crypto');

const DIFFICULTY = [
  { hp: 1, damage: 1, attackRate: 1 },
  { hp: 1.2, damage: 1.12, attackRate: 0.96 },
  { hp: 1.45, damage: 1.25, attackRate: 0.92 },
  { hp: 1.72, damage: 1.4, attackRate: 0.88 },
  { hp: 2, damage: 1.58, attackRate: 0.84 }
];
const BOSSES = [
  { id: 'beacon_guardian', name: 'حارس المنارة', hp: 5000, damage: 22, radius: 3.2, speed: 1.4 },
  { id: 'ember_tyrant', name: 'طاغية الجمر', hp: 6500, damage: 25, radius: 3.3, speed: 1.8 },
  { id: 'rift_weaver', name: 'ناسج الشقوق', hp: 8000, damage: 27, radius: 3.5, speed: 2.0 }
];
const DAMAGE_SCALE = [1, 1.12, 1.25, 1.4, 1.58];

function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }
function finite(value, fallback = 0) { return Number.isFinite(Number(value)) ? Number(value) : fallback; }
function phaseForHealth(hp, maxHp) {
  const ratio = clamp(finite(hp) / Math.max(1, finite(maxHp, 1)), 0, 1);
  return ratio <= 0.35 ? 3 : ratio <= 0.70 ? 2 : 1;
}
function scaledBoss(base, tier) {
  const d = DIFFICULTY[clamp(Math.floor(finite(tier, 1)) - 1, 0, 4)];
  return { hp: Math.round(base.hp * d.hp), damage: base.damage * d.damage, attackRate: d.attackRate };
}

function createCoopService({ io, heroes, isBusy = () => false, onReward = () => {} }) {
  const squads = new Map();
  const playerSquad = new Map();
  const queue = new Map();
  const timers = new Map();

  const codeFor = () => {
    let code;
    do {
      const chars = Array.from({ length: 8 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[crypto.randomInt(32)]);
      code = chars.slice(0, 4).join('') + '-' + chars.slice(4).join('');
    } while (squads.has(code));
    return code;
  };
  const members = room => [...room.players.values()];
  const playerConfig = id => heroes[id] || heroes.balanced;
  const socketFor = p => io.sockets.sockets.get(p.socketId);
  const roomChannel = room => 'squad:' + room.code;
  const emit = (room, event, payload) => io.to(roomChannel(room)).emit(event, payload);
  const publicPlayer = p => ({
    id: p.id, name: p.name, heroId: p.heroId, ready: p.ready,
    connected: p.connected, hp: p.hp, maxHp: p.maxHp,
    x: p.x, z: p.z, vx: p.vx, vz: p.vz, angle: p.angle,
    dead: p.dead, kills: p.kills
  });
  const publicBoss = b => b && ({
    id: b.id, name: b.name, hp: b.hp, maxHp: b.maxHp, phase: b.phase,
    x: b.x, z: b.z, radius: b.radius, enraged: b.enraged
  });
  function state(room) {
    return {
      code: room.code, leaderId: room.leaderId, status: room.status,
      difficulty: room.difficulty, players: members(room).map(publicPlayer),
      maxPlayers: 3, stage: room.stage + 1, boss: publicBoss(room.boss)
    };
  }
  function snapshot(room, now = Date.now()) {
    return {
      ...state(room), remaining: Math.max(0, Math.ceil((room.deadline - now) / 1000)),
      boss: publicBoss(room.boss), telegraph: room.telegraph,
      minions: room.minions.map(m => ({ id: m.id, x: m.x, z: m.z, hp: m.hp, maxHp: m.maxHp })),
      players: members(room).map(publicPlayer)
    };
  }
  function notifyState(room) { emit(room, 'squad:update', state(room)); }
  function attach(room, p, socket) {
    p.socketId = socket.id; p.connected = true; p.disconnectedAt = 0;
    socket.data.squadCode = room.code;
    socket.join(roomChannel(room));
    playerSquad.set(p.id, room.code);
    queue.delete(p.id);
  }
  function newPlayer(socket, heroId, index = 0) {
    const id = socket.data.playerId;
    const hero = heroes[heroId] ? heroId : 'balanced';
    const cfg = playerConfig(hero);
    const spots = [[-4, 1], [4, 1], [0, -5]];
    return {
      id, name: String(socket.data.playerName || 'مقاتل').slice(0, 20), heroId: hero,
      ready: false, connected: true, socketId: socket.id, disconnectedAt: 0,
      x: spots[index][0], z: spots[index][1], vx: 0, vz: 0, angle: 0,
      hp: cfg.hp, maxHp: cfg.hp, dead: false, respawnAt: 0,
      input: { mx: 0, mz: 0, ax: 0, az: 1, fire: false, ability: false },
      lastInputAt: 0, shotAt: 0, abilityAt: 0, abilityHeld: false, kills: 0
    };
  }
  function createRoom(leader, socket, heroId) {
    const room = {
      code: codeFor(), leaderId: leader.id, status: 'waiting', difficulty: 1,
      players: new Map(), stage: 0, boss: null, telegraph: null, minions: [],
      createdAt: Date.now(), startedAt: 0, stageStartedAt: 0, deadline: 0,
      lastTick: 0, lastSnapshot: 0, attackAt: 0, minionAt: 0,
      attackSerial: 0, enrageAt: 0, channel: null
    };
    room.channel = roomChannel(room);
    squads.set(room.code, room);
    const p = newPlayer(socket, heroId);
    room.players.set(p.id, p); attach(room, p, socket);
    return room;
  }
  function removeMember(room, id) {
    const p = room.players.get(id);
    if (!p) return;
    const socket = socketFor(p);
    if (socket) { socket.leave(roomChannel(room)); delete socket.data.squadCode; }
    room.players.delete(id); playerSquad.delete(id); queue.delete(id);
    if (room.leaderId === id) room.leaderId = members(room)[0]?.id || null;
  }
  function destroyRoom(room) {
    const timer = timers.get(room.code);
    if (timer) clearInterval(timer);
    timers.delete(room.code);
    for (const p of members(room)) removeMember(room, p.id);
    squads.delete(room.code);
  }
  function ackError(ack, error) { if (typeof ack === 'function') ack({ ok: false, error }); }
  function canJoin(socket, ack) {
    const id = socket.data.playerId;
    if (playerSquad.has(id) || queue.has(id)) { ackError(ack, 'أنت ضمن فريق أو في قائمة البحث بالفعل.'); return false; }
    if (isBusy(id)) { ackError(ack, 'غادر المباراة الحالية أولًا ثم أنشئ فريقًا تعاونيًا.'); return false; }
    return true;
  }
  function makeBoss(room, now) {
    const base = BOSSES[room.stage];
    const scale = scaledBoss(base, room.difficulty);
    room.boss = {
      id: base.id, name: base.name, hp: scale.hp, maxHp: scale.hp,
      damage: scale.damage, attackRate: scale.attackRate, radius: base.radius,
      speed: base.speed, x: 0, z: 0, phase: 1, enraged: false,
      phaseDamage: 1, baseHp: scale.hp
    };
    room.telegraph = null; room.minions = [];
    room.attackAt = now + 3200; room.minionAt = now + 6500;
    room.stageStartedAt = now;
    emit(room, 'boss:event', { type: 'stage', stage: room.stage + 1, id: base.id, name: base.name, phase: 1 });
  }
  function startBoss(room, now = Date.now()) {
    if (room.status !== 'waiting' || room.players.size !== 3) return false;
    if (members(room).some(p => !p.connected || !p.ready)) return false;
    room.status = 'boss'; room.startedAt = now; room.deadline = now + 480000;
    room.lastTick = now; room.lastSnapshot = 0; room.stage = 0;
    room.enrageAt = now + 180000; makeBoss(room, now);
    emit(room, 'boss:started', { ...state(room), startedAt: now, deadline: room.deadline, snapshot: snapshot(room, now) });
    const timer = setInterval(() => tick(room, Date.now()), 100);
    timer.unref?.(); timers.set(room.code, timer);
    notifyState(room);
    return true;
  }
  function finish(room, victory, reason, now) {
    if (room.status !== 'boss') return;
    room.status = 'finished'; room.telegraph = null;
    const reward = victory ? [30, 45, 65, 90, 125][room.difficulty - 1] : 0;
    if (victory) for (const p of members(room)) onReward(p.id, room.difficulty, reward);
    emit(room, 'boss:ended', {
      victory, reason, difficulty: room.difficulty, reward,
      stage: Math.min(3, room.stage + (victory ? 1 : 0)), remaining: Math.max(0, Math.ceil((room.deadline - now) / 1000))
    });
    notifyState(room);
    const timer = timers.get(room.code);
    if (timer) clearInterval(timer);
    timers.delete(room.code);
    setTimeout(() => { if (squads.get(room.code) === room) destroyRoom(room); }, 30000).unref?.();
  }
  function changePhase(room) {
    const b = room.boss;
    const next = phaseForHealth(b.hp, b.maxHp);
    if (next === b.phase) return;
    b.phase = next;
    emit(room, 'boss:event', { type: 'phase', id: b.id, name: b.name, phase: next, hp: b.hp, maxHp: b.maxHp });
  }
  function defeatBoss(room, now) {
    room.boss.hp = 0;
    emit(room, 'boss:event', { type: 'defeated', id: room.boss.id, stage: room.stage + 1 });
    if (room.stage === BOSSES.length - 1) { finish(room, true, 'victory', now); return; }
    room.stage++;
    makeBoss(room, now);
    emit(room, 'boss:stage', snapshot(room, now));
  }
  function damageBoss(room, amount, now) {
    const b = room.boss;
    if (!b || room.status !== 'boss') return;
    b.hp = Math.max(0, b.hp - amount);
    emit(room, 'boss:event', { type: 'damaged', id: b.id, hp: b.hp, maxHp: b.maxHp, x: b.x, z: b.z });
    changePhase(room);
    if (b.hp <= 0) defeatBoss(room, now);
  }
  function distanceToSegment(px, pz, x, z, dx, dz, length) {
    const along = clamp((px - x) * dx + (pz - z) * dz, 0, length);
    return Math.hypot(px - (x + dx * along), pz - (z + dz * along));
  }
  function chooseAttack(room, now) {
    const b = room.boss;
    const alive = members(room).filter(p => p.connected && !p.dead);
    if (!alive.length) return;
    const target = alive[crypto.randomInt(alive.length)];
    const type = room.stage === 0 ? 'ring' : room.stage === 1 ? 'line' : 'pull';
    const aimLen = Math.hypot(target.x - b.x, target.z - b.z) || 1;
    const delay = b.phase === 3 ? 900 : b.phase === 2 ? 1100 : 1350;
    room.attackSerial++;
    room.telegraph = {
      id: room.attackSerial, type, x: b.x, z: b.z,
      ax: (target.x - b.x) / aimLen, az: (target.z - b.z) / aimLen,
      tx: target.x, tz: target.z, radius: type === 'pull' ? 8 : type === 'ring' ? 5.4 : 0,
      width: type === 'line' ? 2.15 : 0, length: type === 'line' ? 17 : 0,
      resolveAt: now + delay
    };
    emit(room, 'boss:event', { type: 'telegraph', bossId: b.id, telegraph: room.telegraph, delay });
    room.attackAt = now + (b.phase === 3 ? 2300 : b.phase === 2 ? 2900 : 3600) * b.attackRate;
  }
  function resolveAttack(room, now) {
    const t = room.telegraph, b = room.boss;
    if (!t || now < t.resolveAt) return;
    for (const p of members(room)) {
      if (!p.connected || p.dead) continue;
      let hit = false;
      if (t.type === 'ring') hit = Math.hypot(p.x - t.tx, p.z - t.tz) < 2.25;
      else if (t.type === 'line') hit = distanceToSegment(p.x, p.z, t.x, t.z, t.ax, t.az, t.length) < t.width;
      else if (t.type === 'pull') hit = Math.hypot(p.x - t.x, p.z - t.z) > 3.0 && Math.hypot(p.x - t.x, p.z - t.z) < t.radius;
      if (hit) {
        const phaseScale = [1, 1.15, 1.32][b.phase - 1];
        const damage = b.damage * phaseScale * (b.enraged ? 1.25 : 1);
        p.hp = Math.max(0, p.hp - damage);
        emit(room, 'boss:event', { type: 'playerHit', playerId: p.id, hp: p.hp, maxHp: p.maxHp, damage: Math.round(damage) });
        if (p.hp <= 0) { p.dead = true; p.respawnAt = now + 3200; }
      }
    }
    emit(room, 'boss:event', { type: 'attack', bossId: b.id, attack: t.type, x: t.x, z: t.z, tx: t.tx, tz: t.tz, radius: t.radius });
    room.telegraph = null;
  }
  function fireAt(room, p, now, ability = false) {
    const b = room.boss;
    const cfg = playerConfig(p.heroId);
    const cooldown = ability ? 8000 : Math.max(260, finite(cfg.cooldown, .6) * 1000);
    if (now - (ability ? p.abilityAt : p.shotAt) < cooldown) return;
    if (ability) p.abilityAt = now; else p.shotAt = now;
    const targets = [{ id: 'boss', x: b.x, z: b.z, radius: b.radius }]
      .concat(room.minions.map(m => ({ id: m.id, x: m.x, z: m.z, radius: .7 })));
    let target = null, best = Infinity;
    const ax = p.input.ax, az = p.input.az;
    for (const candidate of targets) {
      const dx = candidate.x - p.x, dz = candidate.z - p.z, d = Math.hypot(dx, dz) || 1;
      const dot = dx / d * ax + dz / d * az;
      if (d <= finite(cfg.range, 9) + candidate.radius && dot >= .94 && d < best) { best = d; target = candidate; }
    }
    if (!target) return;
    const raw = finite(cfg.damage, 20) * (ability ? 2.25 : 1) * (best < 4 ? 1.15 : 1);
    if (target.id === 'boss') damageBoss(room, raw, now);
    else {
      const minion = room.minions.find(m => m.id === target.id);
      if (minion) { minion.hp -= raw; if (minion.hp <= 0) { room.minions = room.minions.filter(m => m !== minion); emit(room, 'boss:event', { type: 'minionDefeated', id: minion.id }); } }
    }
  }
  function spawnMinion(room, now) {
    const b = room.boss;
    if (b.phase < 2 || room.minions.length >= (b.phase === 3 ? 4 : 2)) return;
    const a = crypto.randomInt(6284) / 1000;
    const id = 'shardling-' + (++room.attackSerial);
    room.minions.push({ id, x: b.x + Math.cos(a) * 7, z: b.z + Math.sin(a) * 7, hp: 140, maxHp: 140, nextHitAt: now + 1800 });
    emit(room, 'boss:event', { type: 'minionSpawn', id, x: room.minions.at(-1).x, z: room.minions.at(-1).z });
  }
  function tick(room, now = Date.now()) {
    if (room.status !== 'boss') return;
    const dt = clamp((now - room.lastTick) / 1000, 0, .15); room.lastTick = now;
    if (now >= room.deadline) { finish(room, false, 'timeout', now); return; }
    if (now >= room.enrageAt && room.boss && !room.boss.enraged) {
      room.boss.enraged = true;
      room.boss.attackRate *= .74;
      emit(room, 'boss:event', { type: 'enrage', id: room.boss.id, name: room.boss.name });
    }
    for (const p of members(room)) {
      if (!p.connected && now - p.disconnectedAt > 30000) { removeMember(room, p.id); continue; }
      if (p.dead) {
        if (now >= p.respawnAt) { p.dead = false; p.hp = p.maxHp; p.x = 0; p.z = 7; }
        continue;
      }
      const cfg = playerConfig(p.heroId), speed = finite(cfg.speed, 5.5);
      p.vx = p.input.mx * speed; p.vz = p.input.mz * speed;
      p.x = clamp(p.x + p.vx * dt, -25, 25); p.z = clamp(p.z + p.vz * dt, -25, 25);
      p.angle = Math.atan2(p.input.ax, p.input.az);
      if (p.input.fire) fireAt(room, p, now, false);
      if (p.input.ability && !p.abilityHeld) fireAt(room, p, now, true);
      p.abilityHeld = p.input.ability;
      if (room.status !== 'boss') return;
    }
    const b = room.boss;
    if (!room.players.size) { finish(room, false, 'abandoned', now); return; }
    if (b) {
      b.x = Math.sin((now - room.stageStartedAt) / 6000) * b.speed;
      b.z = Math.cos((now - room.stageStartedAt) / 7000) * b.speed;
      resolveAttack(room, now);
      if (!room.telegraph && now >= room.attackAt) chooseAttack(room, now);
      if (now >= room.minionAt) { spawnMinion(room, now); room.minionAt = now + (b.phase === 3 ? 4800 : 7800); }
      for (const m of room.minions) {
        const target = members(room).filter(p => p.connected && !p.dead).sort((a, c) => Math.hypot(a.x - m.x, a.z - m.z) - Math.hypot(c.x - m.x, c.z - m.z))[0];
        if (target && now >= m.nextHitAt && Math.hypot(target.x - m.x, target.z - m.z) < 1.8) {
          target.hp = Math.max(0, target.hp - 8 * DAMAGE_SCALE[room.difficulty - 1]);
          m.nextHitAt = now + 2000;
          if (target.hp <= 0) { target.dead = true; target.respawnAt = now + 3200; }
        }
      }
    }
    if (now - room.lastSnapshot >= 100) { room.lastSnapshot = now; emit(room, 'boss:snapshot', snapshot(room, now)); }
  }
  function bind(socket) {
    const id = socket.data.playerId;
    const cleanHero = heroId => heroes[heroId] ? heroId : 'balanced';
    socket.on('squad:create', (data = {}, ack = () => {}) => {
      if (!canJoin(socket, ack)) return;
      const room = createRoom(socket, socket, cleanHero(data.heroId));
      ack({ ok: true, state: state(room) }); notifyState(room);
    });
    socket.on('squad:join', (data = {}, ack = () => {}) => {
      if (!canJoin(socket, ack)) return;
      const code = String(data.code || '').trim().toUpperCase();
      const room = squads.get(code);
      if (!room || room.status !== 'waiting') return ackError(ack, 'رمز الفريق غير موجود أو بدأت الغارة.');
      if (room.players.size >= 3) return ackError(ack, 'اكتمل الفريق؛ كل فريق يتكوّن من ثلاثة لاعبين.');
      const p = newPlayer(socket, cleanHero(data.heroId), room.players.size); room.players.set(id, p); attach(room, p, socket);
      ack({ ok: true, state: state(room) }); notifyState(room);
    });
    socket.on('squad:ready', (ready, ack = () => {}) => {
      const room = squads.get(playerSquad.get(id)), p = room?.players.get(id);
      if (!p || room.status !== 'waiting') return ackError(ack, 'لا يوجد فريق ينتظر الجاهزية.');
      p.ready = ready === true; notifyState(room); if (typeof ack === 'function') ack({ ok: true, state: state(room) });
      startBoss(room);
    });
    socket.on('squad:setDifficulty', (value, ack = () => {}) => {
      const room = squads.get(playerSquad.get(id));
      if (!room || room.status !== 'waiting' || room.leaderId !== id) return ackError(ack, 'قائد الفريق فقط يختار الصعوبة قبل بدء الغارة.');
      room.difficulty = clamp(Math.floor(finite(value, 1)), 1, 5);
      notifyState(room); if (typeof ack === 'function') ack({ ok: true, state: state(room) });
    });
    socket.on('squad:leave', ack => {
      const room = squads.get(playerSquad.get(id));
      if (!room) return typeof ack === 'function' ? ack({ ok: true }) : undefined;
      removeMember(room, id); socket.data.squadCode = null;
      if (!room.players.size) destroyRoom(room); else notifyState(room);
      if (typeof ack === 'function') ack({ ok: true });
    });
    socket.on('matchmaking:join', (data = {}, ack = () => {}) => {
      if (!canJoin(socket, ack)) return;
      queue.set(id, { id, name: socket.data.playerName, heroId: cleanHero(data.heroId), socketId: socket.id, socket });
      if (typeof ack === 'function') ack({ ok: true, queued: true });
      if (queue.size < 3) { socket.emit('matchmaking:status', { queued: queue.size, needed: 3 }); return; }
      const group = [...queue.values()].slice(0, 3); group.forEach(q => queue.delete(q.id));
      const leaderSocket = group[0].socket;
      const room = createRoom(leaderSocket, leaderSocket, group[0].heroId);
      for (let i = 1; i < group.length; i++) {
        const q = group[i], memberSocket = q.socket, p = newPlayer(memberSocket, q.heroId, i);
        p.name = q.name; room.players.set(p.id, p); attach(room, p, memberSocket);
      }
      for (const p of members(room)) { const s = socketFor(p); if (s) s.emit('matchmaking:found', state(room)); }
      notifyState(room);
    });
    socket.on('matchmaking:cancel', ack => {
      const removed = queue.delete(id);
      if (typeof ack === 'function') ack({ ok: true, removed });
    });
    let inputAt = 0;
    socket.on('boss:input', data => {
      const now = Date.now(); if (now - inputAt < 28) return; inputAt = now;
      const room = squads.get(playerSquad.get(id)), p = room?.players.get(id);
      if (!p || room.status !== 'boss' || p.dead || !p.connected) return;
      let mx = clamp(finite(data?.mx), -1, 1), mz = clamp(finite(data?.mz), -1, 1);
      const moveLength = Math.hypot(mx, mz); if (moveLength > 1) { mx /= moveLength; mz /= moveLength; }
      let ax = clamp(finite(data?.ax), -1, 1), az = clamp(finite(data?.az), -1, 1);
      const aimLength = Math.hypot(ax, az) || 1; ax /= aimLength; az /= aimLength;
      p.input = { mx, mz, ax, az, fire: data?.fire === true, ability: data?.ability === true };
    });
    socket.on('disconnect', () => {
      queue.delete(id);
      const room = squads.get(playerSquad.get(id)), p = room?.players.get(id);
      if (!p || p.socketId !== socket.id) return;
      p.connected = false; p.disconnectedAt = Date.now(); p.input = { mx: 0, mz: 0, ax: 0, az: 1, fire: false, ability: false };
      if (room.status === 'waiting') p.ready = false;
      notifyState(room);
    });
  }
  function reconnect(socket) {
    const room = squads.get(playerSquad.get(socket.data.playerId));
    const p = room?.players.get(socket.data.playerId);
    if (!room || !p) return false;
    attach(room, p, socket); p.name = String(socket.data.playerName || p.name).slice(0, 20);
    socket.emit('squad:resumed', state(room));
    if (room.status === 'boss') socket.emit('boss:started', { ...state(room), startedAt: room.startedAt, deadline: room.deadline, snapshot: snapshot(room) });
    notifyState(room); return true;
  }
  function disconnect(socket) {
    queue.delete(socket.data.playerId);
    const room = squads.get(playerSquad.get(socket.data.playerId)), p = room?.players.get(socket.data.playerId);
      if (p && p.socketId === socket.id) { p.connected = false; p.disconnectedAt = Date.now(); p.input = { mx: 0, mz: 0, ax: 0, az: 1, fire: false, ability: false }; if (room.status === 'waiting') p.ready = false; notifyState(room); }
  }
  return {
    bind, reconnect, disconnect,
    isInSquad: id => playerSquad.has(id) || queue.has(id),
    getState: code => { const room = squads.get(code); return room ? state(room) : null; },
    dispose() { for (const timer of timers.values()) clearInterval(timer); timers.clear(); }
  };
}

module.exports = { createCoopService, phaseForHealth, scaledBoss, DIFFICULTY, BOSSES };
