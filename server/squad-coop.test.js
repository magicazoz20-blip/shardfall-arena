'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCoopService, phaseForHealth, scaledBoss, BOSSES } = require('./squad-coop');

test('boss phase thresholds switch exactly at 70% and 35%', () => {
  assert.equal(phaseForHealth(70, 100), 2);
  assert.equal(phaseForHealth(70.01, 100), 1);
  assert.equal(phaseForHealth(35, 100), 3);
  assert.equal(phaseForHealth(35.01, 100), 2);
  assert.equal(phaseForHealth(0, 100), 3);
});

test('difficulty tiers scale boss health and attack damage monotonically', () => {
  const values = Array.from({ length: 5 }, (_, i) => scaledBoss(BOSSES[0], i + 1));
  for (let i = 1; i < values.length; i++) {
    assert.ok(values[i].hp > values[i - 1].hp);
    assert.ok(values[i].damage > values[i - 1].damage);
  }
  assert.equal(values[0].hp, BOSSES[0].hp);
  assert.equal(values[4].hp, Math.round(BOSSES[0].hp * 2));
});

test('a cooperative fight cannot start until all three party members are ready', () => {
  const sockets = new Map();
  const io = {
    sockets: { sockets },
    to(channel) {
      return { emit(event, payload) { for (const socket of sockets.values()) if (socket.rooms.has(channel)) socket.emit(event, payload); } };
    }
  };
  class FakeSocket {
    constructor(id, name) { this.id = 'socket-' + id; this.data = { playerId: id, playerName: name }; this.handlers = new Map(); this.rooms = new Set(); this.sent = []; sockets.set(this.id, this); }
    on(event, callback) { this.handlers.set(event, callback); }
    emit(event, payload) { this.sent.push({ event, payload }); }
    join(channel) { this.rooms.add(channel); }
    leave(channel) { this.rooms.delete(channel); }
    receive(event, ...args) { return this.handlers.get(event)(...args); }
    last(event) { return this.sent.filter(item => item.event === event).at(-1); }
  }
  const service = createCoopService({ io, heroes: { balanced: { hp: 100, speed: 5, damage: 20, cooldown: .5, range: 10 } } });
  try {
    const a = new FakeSocket('a', 'ألف'); const b = new FakeSocket('b', 'باء'); const c = new FakeSocket('c', 'جيم');
    for (const socket of [a, b, c]) service.bind(socket);
    let created;
    a.receive('squad:create', { heroId: 'balanced' }, result => { created = result; });
    assert.equal(created.ok, true);
    b.receive('squad:join', { code: created.state.code }, () => {});
    c.receive('squad:join', { code: created.state.code }, () => {});
    a.receive('squad:ready', true, () => {});
    b.receive('squad:ready', true, () => {});
    assert.equal(a.last('boss:started'), undefined);
    c.receive('squad:ready', true, () => {});
    assert.equal(a.last('boss:started').payload.snapshot.boss.id, 'beacon_guardian');
    assert.equal(service.getState(created.state.code).status, 'boss');
  } finally { service.dispose(); }
});
