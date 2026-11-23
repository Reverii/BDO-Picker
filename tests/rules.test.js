const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGs } = require('./load_gs');

const R = loadGs(['Rules.gs']);
const today = '2026-12-01';
const open = (date = '2026-12-05') => ({ date, bdo: '', queue: [] });
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 'NO ERROR'; };

test('pick open day makes you BDO', () => {
  const r = R.pickDay(open(), 'mamba', today);
  assert.equal(r.result, 'bdo');
  assert.equal(r.day.bdo, 'MAMBA');
  assert.equal(r.position, 0);
});

test('second and third pickers queue in order', () => {
  let d = R.pickDay(open(), 'HAWK', today).day;
  const v = R.pickDay(d, 'VIPER', today);
  const o = R.pickDay(v.day, 'OSPREY', today);
  assert.equal(o.day.bdo, 'HAWK');
  assert.deepEqual([...o.day.queue], ['VIPER', 'OSPREY']);
  assert.equal(v.result, 'queued');
  assert.equal(v.position, 1);
  assert.equal(o.position, 2);
});

test('repeat pick is rejected', () => {
  const d = R.pickDay(open(), 'HAWK', today).day;
  assert.equal(code(() => R.pickDay(d, 'HAWK', today)), 'ALREADY_ON');
  const d2 = R.pickDay(d, 'VIPER', today).day;
  assert.equal(code(() => R.pickDay(d2, 'viper', today)), 'ALREADY_ON');
  assert.equal(d2.queue.length, 1);
});

test('pick does not change the day passed in', () => {
  const d = open();
  R.pickDay(d, 'HAWK', today);
  assert.equal(d.bdo, '');
});

test('BDO drop promotes queue head', () => {
  const r = R.dropDay({ date: '2026-12-05', bdo: 'HAWK', queue: ['VIPER', 'OSPREY'] }, 'HAWK', today);
  assert.equal(r.day.bdo, 'VIPER');
  assert.deepEqual([...r.day.queue], ['OSPREY']);
  assert.equal(r.promoted, 'VIPER');
  assert.equal(r.result, 'dropped');
});

test('BDO drop with empty queue opens the day', () => {
  const r = R.dropDay({ date: '2026-12-05', bdo: 'HAWK', queue: [] }, 'HAWK', today);
  assert.equal(r.day.bdo, '');
  assert.equal(r.promoted, '');
});

test('leaving the queue moves people up', () => {
  const r = R.dropDay({ date: '2026-12-05', bdo: 'HAWK', queue: ['VIPER', 'MAMBA', 'OSPREY'] }, 'MAMBA', today);
  assert.deepEqual([...r.day.queue], ['VIPER', 'OSPREY']);
  assert.equal(r.day.bdo, 'HAWK');
  assert.equal(r.result, 'left');
});

test('drop by someone not on the day', () => {
  assert.equal(code(() => R.dropDay({ date: '2026-12-05', bdo: 'HAWK', queue: [] }, 'VIPER', today)), 'NOT_ON');
});

test('past dates are rejected', () => {
  const past = { date: '2026-11-30', bdo: 'HAWK', queue: [] };
  assert.equal(code(() => R.pickDay(past, 'VIPER', today)), 'PAST');
  assert.equal(code(() => R.dropDay(past, 'HAWK', today)), 'PAST');
  assert.equal(code(() => R.setDay([], '2026-11-30', true, today)), 'PAST');
  assert.equal(code(() => R.setDay([past], '2026-11-30', false, today)), 'PAST');
});

test('today itself can still be picked', () => {
  assert.equal(R.pickDay(open(today), 'HAWK', today).result, 'bdo');
});

test('setDay adds sorted and removes returning the old day', () => {
  let r = R.setDay([], '2026-12-12', true, today);
  r = R.setDay(r.days, '2026-12-05', true, today);
  assert.deepEqual([...r.days.map((d) => d.date)], ['2026-12-05', '2026-12-12']);
  assert.equal(r.removed, null);
  const days = [{ date: '2026-12-05', bdo: 'HAWK', queue: [] }, open('2026-12-12')];
  const rm = R.setDay(days, '2026-12-05', false, today);
  assert.deepEqual([...rm.days.map((d) => d.date)], ['2026-12-12']);
  assert.equal(rm.removed.bdo, 'HAWK');
  const again = R.setDay(rm.days, '2026-12-12', true, today);
  assert.equal(again.days.length, 1);
  assert.equal(again.removed, null);
  const missing = R.setDay(rm.days, '2026-12-20', false, today);
  assert.equal(missing.days.length, 1);
  assert.equal(missing.removed, null);
});

test('setDay rejects a badly formed date', () => {
  assert.equal(code(() => R.setDay([], '5 Dec', true, today)), 'BAD_DATE');
});

test('link callsign', () => {
  const crew = [{ callsign: 'HAWK', telegramId: '1', username: 'h' }, { callsign: 'MAMBA', telegramId: '', username: '' }];
  const linked = R.linkCallsign(crew, '9', 'mamba_ops', ' mamba ');
  const m = linked.find((c) => c.callsign === 'MAMBA');
  assert.equal(m.telegramId, '9');
  assert.equal(m.username, 'mamba_ops');
  assert.equal(crew[1].telegramId, '', 'input not changed');
  assert.equal(code(() => R.linkCallsign(crew, '9', '', 'HAWK')), 'TAKEN');
  assert.equal(code(() => R.linkCallsign(crew, '9', '', 'NOBODY')), 'UNKNOWN');
  assert.equal(code(() => R.linkCallsign(linked, '9', '', 'HAWK')), 'ALREADY_LINKED');
});

test('admins', () => {
  const crew = [{ callsign: 'MAMBA', telegramId: '3', username: '' }, { callsign: 'OSPREY', telegramId: '4', username: '' }, { callsign: 'RAVEN', telegramId: '', username: '' }];
  assert.deepEqual([...R.addAdmin(['MAMBA'], crew, 'osprey')], ['MAMBA', 'OSPREY']);
  assert.equal(code(() => R.addAdmin(['MAMBA'], crew, 'RAVEN')), 'NOT_LINKED');
  assert.equal(code(() => R.addAdmin(['MAMBA'], crew, 'MAMBA')), 'ALREADY_ADMIN');
  assert.equal(code(() => R.removeSelf(['MAMBA'], 'MAMBA')), 'LAST_ADMIN');
  assert.deepEqual([...R.removeSelf(['MAMBA', 'OSPREY'], 'MAMBA')], ['OSPREY']);
});

test('fmtDay', () => {
  assert.equal(R.fmtDay('2026-12-05'), 'Saturday 5 Dec');
  assert.equal(R.fmtDay('2026-12-31'), 'Thursday 31 Dec');
});

test('assign as BDO moves the current BDO to the front of the queue', () => {
  const r = R.assignDay({ date: '2026-12-05', bdo: 'HAWK', queue: ['VIPER'] }, 'osprey', 'bdo', today);
  assert.equal(r.day.bdo, 'OSPREY');
  assert.deepEqual([...r.day.queue], ['HAWK', 'VIPER']);
  assert.equal(r.displaced, 'HAWK');
  assert.equal(r.position, 0);
});

test('assign as BDO on an open day', () => {
  const r = R.assignDay(open(), 'OSPREY', 'bdo', today);
  assert.equal(r.day.bdo, 'OSPREY');
  assert.equal(r.displaced, '');
});

test('assign a queued person as BDO moves them up', () => {
  const r = R.assignDay({ date: '2026-12-05', bdo: 'HAWK', queue: ['VIPER', 'OSPREY'] }, 'OSPREY', 'bdo', today);
  assert.equal(r.day.bdo, 'OSPREY');
  assert.deepEqual([...r.day.queue], ['HAWK', 'VIPER']);
});

test('assign to the queue adds at the end', () => {
  const r = R.assignDay({ date: '2026-12-05', bdo: 'HAWK', queue: ['VIPER'] }, 'OSPREY', 'queue', today);
  assert.deepEqual([...r.day.queue], ['VIPER', 'OSPREY']);
  assert.equal(r.position, 2);
  const o = R.assignDay(open(), 'OSPREY', 'queue', today);
  assert.equal(o.day.bdo, 'OSPREY', 'an empty day has no BDO to queue behind, so they become BDO');
});

test('assign rejects someone already in that place, and past days', () => {
  const d = { date: '2026-12-05', bdo: 'HAWK', queue: ['VIPER'] };
  assert.equal(code(() => R.assignDay(d, 'HAWK', 'bdo', today)), 'ALREADY_THERE');
  assert.equal(code(() => R.assignDay(d, 'HAWK', 'queue', today)), 'ALREADY_THERE');
  assert.equal(code(() => R.assignDay(d, 'VIPER', 'queue', today)), 'ALREADY_THERE');
  assert.equal(code(() => R.assignDay({ ...d, date: '2026-11-30' }, 'OSPREY', 'bdo', today)), 'PAST');
});

test('remove from day: BDO promotes the queue, queue member just leaves', () => {
  const d = { date: '2026-12-05', bdo: 'HAWK', queue: ['VIPER', 'OSPREY'] };
  const a = R.removeFromDay(d, 'HAWK', today);
  assert.equal(a.day.bdo, 'VIPER');
  assert.equal(a.promoted, 'VIPER');
  const b = R.removeFromDay(d, 'viper', today);
  assert.deepEqual([...b.day.queue], ['OSPREY']);
  assert.equal(b.promoted, '');
  assert.equal(code(() => R.removeFromDay(d, 'RAVEN', today)), 'NOT_THERE');
});
