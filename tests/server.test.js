const test = require('node:test');
const assert = require('node:assert/strict');
const { Picker } = require('../worker/src/picker.mjs');
const { makeD1 } = require('./fake_d1');
const { makeTelegram } = require('./fake_telegram');
const { initDataFor } = require('./tg_sign');

const TOKEN = '123456:TEST-token';
const NOW = new Date('2026-12-01T02:00:00Z'); // 10:00 Singapore time

const SEED = {
  days: [['2026-12-05', '', ''], ['2026-12-12', '', '']],
  crew: [['HAWK', '1', 'hawk'], ['VIPER', '2', 'viper'], ['MAMBA', '3', 'mamba'], ['OSPREY', '4', 'osprey'], ['RAVEN', '', ''], ['KESTREL', '', '']],
  admins: [['MAMBA']],
};
const COLS = { days: '(date, bdo, queue)', crew: '(callsign, telegram_id, username)', admins: '(callsign)' };

function start(opts = {}) {
  const db = makeD1({ delay: opts.delay || 0 });
  const tables = { ...SEED, ...(opts.tables || {}) };
  Object.keys(tables).forEach((t) => tables[t].forEach((r) => {
    db.sql.prepare(`INSERT INTO ${t} ${COLS[t]} VALUES (${r.map(() => '?').join(', ')})`).run(...r);
  }));
  const events = [];
  db.onBatch = () => events.push('save');
  const tg = makeTelegram({ status: opts.telegramStatus || 200, updates: opts.updates || [], events });
  const picker = new Picker({ db, env: { BOT_TOKEN: TOKEN }, fetch: tg.fetch, now: () => new Date(NOW.getTime()), lockWaitMs: opts.lockWaitMs });
  const call = (tgId, action, args = {}, initData) => {
    const id = initData !== undefined ? initData : initDataFor({ id: tgId, username: 'u' + tgId }, TOKEN, Math.floor(NOW.getTime() / 1000) - 10);
    return picker.post(JSON.stringify({ initData: id, action, ...args }));
  };
  const table = (t) => db.sql.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().map((r) => Object.values(r));
  const row = (date) => table('days').find((r) => r[0] === date);
  const log = () => db.sql.prepare('SELECT at, who, what FROM log ORDER BY id').all().map((r) => [r.at, r.who, r.what]);
  return { db, tg, picker, call, table, row, log, events, sent: tg.state.sent };
}

test('pick then pick: BDO then queue', async () => {
  const { call, row } = start();
  const a = await call(1, 'pick', { date: '2026-12-05' });
  const b = await call(2, 'pick', { date: '2026-12-05' });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.deepEqual(row('2026-12-05'), ['2026-12-05', 'HAWK', 'VIPER']);
  assert.equal(b.message, 'HAWK got there first. You are number 1 in the queue for Saturday 5 Dec.');
  assert.equal(b.day.bdo, 'HAWK');
});

test('people picking at the same moment are all kept, in order', async () => {
  const { call, row } = start({ delay: 2 });
  const out = await Promise.all([1, 2, 3, 4].map((id) => call(id, 'pick', { date: '2026-12-05' })));
  assert.ok(out.every((r) => r.ok), JSON.stringify(out));
  // Whoever reaches the lock first wins; nobody is lost or listed twice, and what each person was
  // told matches what was saved.
  const saved = row('2026-12-05');
  const order = [saved[1]].concat(saved[2].split(', '));
  assert.deepEqual(order.slice().sort(), ['HAWK', 'MAMBA', 'OSPREY', 'VIPER']);
  const names = ['HAWK', 'VIPER', 'MAMBA', 'OSPREY'];
  out.forEach((r, i) => {
    const at = order.indexOf(names[i]);
    if (at === 0) assert.match(r.message, /^You are BDO/);
    else assert.match(r.message, new RegExp('You are number ' + at + ' in the queue'));
  });
});

test('drop promotes and messages the new BDO', async () => {
  const { call, row, sent } = start();
  await call(1, 'pick', { date: '2026-12-05' });
  await call(2, 'pick', { date: '2026-12-05' });
  await call(4, 'pick', { date: '2026-12-05' });
  const r = await call(1, 'drop', { date: '2026-12-05' });
  assert.equal(r.ok, true);
  assert.deepEqual(row('2026-12-05'), ['2026-12-05', 'VIPER', 'OSPREY']);
  assert.deepEqual(sent, [{ chat_id: '2', text: "You're now BDO on Saturday 5 Dec. HAWK dropped the day, so you moved up from first in the queue." }]);
  assert.match(r.message, /VIPER moved up to BDO/);
});

test('bad initData changes nothing', async () => {
  const { call, table } = start();
  const before = JSON.stringify(table('days'));
  const forged = initDataFor({ id: 1, username: 'x' }, 'wrong:token', Math.floor(NOW.getTime() / 1000));
  const r = await call(1, 'pick', { date: '2026-12-05' }, forged);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Open BDO Picker from the Telegram link.');
  assert.equal(JSON.stringify(table('days')), before);
  assert.equal((await call(1, 'pick', { date: '2026-12-05' }, '')).ok, false);
});

test('a missing bot token gives the general error', async () => {
  const db = makeD1();
  const r = await new Picker({ db, env: {} }).post('{"action":"init"}');
  assert.deepEqual(r, { ok: false, error: 'Something went wrong. Try again in a moment.' });
});

test('picking a day the planner has not set is refused', async () => {
  const { call } = start();
  const r = await call(1, 'pick', { date: '2026-12-06' });
  assert.equal(r.ok, false);
  assert.equal(r.error, "The planner hasn't set that day as a BDO day.");
});

test('unlinked user cannot pick', async () => {
  const { call } = start();
  const r = await call(77, 'pick', { date: '2026-12-05' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Pick your callsign first.');
});

test('month returns only that month', async () => {
  const { call } = start({ tables: { days: [['2026-12-05', 'HAWK', 'VIPER, OSPREY'], ['2027-01-02', '', '']] } });
  const r = await call(3, 'month', { month: '2026-12' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.days, [{ date: '2026-12-05', bdo: 'HAWK', queue: ['VIPER', 'OSPREY'] }]);
});

test('rows typed by hand in the database read and update correctly', async () => {
  const { call, row, table } = start({ tables: {
    days: [['2026-12-05', ' hawk ', 'viper,osprey']],
    crew: [[' hawk', '1', ''], ['viper ', '2', ''], ['MAMBA', '3', ''], ['osprey', '4', ''], ['raven', '', '']],
    admins: [['mamba ']],
  } });
  const m = await call(3, 'month', { month: '2026-12' });
  assert.deepEqual(m.days, [{ date: '2026-12-05', bdo: 'HAWK', queue: ['VIPER', 'OSPREY'] }]);
  assert.equal((await call(1, 'drop', { date: '2026-12-05' })).ok, true);
  assert.deepEqual(row('2026-12-05'), ['2026-12-05', 'VIPER', 'OSPREY']);
  assert.equal((await call(77, 'link', { callsign: 'RAVEN' })).callsign, 'RAVEN');
  assert.deepEqual(table('crew').find((c) => c[0] === 'raven'), ['raven', '77', 'u77']);
  assert.equal((await call(3, 'removeCrew', { callsign: 'OSPREY' })).ok, true);
  assert.ok(!table('crew').some((c) => c[0].trim().toUpperCase() === 'OSPREY'));
});

test('non-admin cannot setDay', async () => {
  const { call, table } = start();
  const r = await call(1, 'setDay', { date: '2026-12-19', on: true });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Only the BDO planner can do that.');
  assert.equal(table('days').length, 2);
});

test('admin setDay on adds the day', async () => {
  const { call, db } = start();
  const r = await call(3, 'setDay', { date: '2026-12-08', on: true });
  assert.equal(r.ok, true);
  assert.deepEqual(db.sql.prepare('SELECT date FROM days ORDER BY date').all().map((x) => x.date), ['2026-12-05', '2026-12-08', '2026-12-12']);
  assert.deepEqual(r.days.map((d) => d.date), ['2026-12-05', '2026-12-08', '2026-12-12']);
});

test('admin setDay off messages everyone on it', async () => {
  const { call, row, sent } = start();
  await call(1, 'pick', { date: '2026-12-05' });
  await call(2, 'pick', { date: '2026-12-05' });
  const r = await call(3, 'setDay', { date: '2026-12-05', on: false });
  assert.equal(r.ok, true);
  assert.equal(row('2026-12-05'), undefined);
  const text = 'Saturday 5 Dec is no longer needed as a BDO day, so it has been taken off your days.';
  assert.deepEqual(sent, [{ chat_id: '1', text }, { chat_id: '2', text }]);
});

test('failed Telegram send still succeeds', async () => {
  const { call, row, log, tg } = start({ telegramStatus: 403 });
  await call(1, 'pick', { date: '2026-12-05' });
  await call(2, 'pick', { date: '2026-12-05' });
  const r = await call(1, 'drop', { date: '2026-12-05' });
  assert.equal(r.ok, true);
  assert.equal(row('2026-12-05')[1], 'VIPER');
  assert.ok(log().some((l) => l[2] === 'message to VIPER not delivered'));
  assert.doesNotMatch(r.message, /got a Telegram message/);
  assert.ok(tg.state.urls[0].startsWith('https://api.telegram.org/bot' + TOKEN + '/sendMessage'));
});

test('whoami for an unlinked user lists crew with taken flags', async () => {
  const { call } = start();
  const r = await call(77, 'whoami');
  assert.equal(r.ok, true);
  assert.equal(r.linked, false);
  assert.deepEqual(r.crew.find((c) => c.callsign === 'HAWK'), { callsign: 'HAWK', taken: true });
  assert.deepEqual(r.crew.find((c) => c.callsign === 'RAVEN'), { callsign: 'RAVEN', taken: false });
});

test('link then whoami shows linked', async () => {
  const { call, table } = start();
  const r = await call(77, 'link', { callsign: 'raven' });
  assert.equal(r.ok, true);
  assert.equal(r.linked, true);
  assert.equal(r.callsign, 'RAVEN');
  assert.equal(r.isAdmin, false);
  assert.deepEqual(table('crew').find((c) => c[0] === 'RAVEN'), ['RAVEN', '77', 'u77']);
  const again = await call(77, 'whoami');
  assert.equal(again.callsign, 'RAVEN');
  assert.equal(again.crew, undefined);
});

test('linking a taken callsign is refused', async () => {
  const { call } = start();
  const r = await call(77, 'link', { callsign: 'HAWK' });
  assert.equal(r.ok, false);
  assert.match(r.error, /already linked to someone else/);
});

test('addAdmin sends the new-admin message', async () => {
  const { call, table, sent } = start();
  const r = await call(3, 'addAdmin', { callsign: 'OSPREY' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.admins, ['MAMBA', 'OSPREY']);
  assert.deepEqual(table('admins'), [['MAMBA'], ['OSPREY']]);
  assert.deepEqual(sent, [{ chat_id: '4', text: "You're now a BDO planner. Open BDO Picker to set the BDO days." }]);
  assert.equal(r.lastChange, 'MAMBA added OSPREY as admin · 1 Dec');
  assert.equal((await call(3, 'admins')).lastChange, 'MAMBA added OSPREY as admin · 1 Dec', 'read back from the log');
});

test('removeMe as last admin is refused', async () => {
  const { call, table } = start();
  const r = await call(3, 'removeMe');
  assert.equal(r.ok, false);
  assert.match(r.error, /only admin/);
  assert.deepEqual(table('admins'), [['MAMBA']]);
});

test('removeMe with another admin works', async () => {
  const { call, table } = start({ tables: { admins: [['MAMBA'], ['OSPREY']] } });
  const r = await call(3, 'removeMe');
  assert.equal(r.ok, true);
  assert.deepEqual(table('admins'), [['OSPREY']]);
  assert.equal((await call(3, 'whoami')).isAdmin, false);
});

test('the schema is safe to apply twice', () => {
  const { db, table } = start();
  const fs = require('fs');
  db.sql.exec(fs.readFileSync(require('path').join(__dirname, '..', 'worker', 'migrations', '0001_init.sql'), 'utf8'));
  assert.equal(table('days').length, 2);
});

test('every write is logged', async () => {
  const { call, log } = start();
  await call(1, 'pick', { date: '2026-12-05' });
  const l = log();
  assert.deepEqual(l[l.length - 1], ['2026-12-01 10:00', 'HAWK', 'picked Saturday 5 Dec (BDO)']);
});

test('admins lists linked callsigns for the add-admin choice', async () => {
  const { call } = start();
  const r = await call(3, 'admins');
  assert.equal(r.ok, true);
  assert.deepEqual(r.linked, ['HAWK', 'VIPER', 'MAMBA', 'OSPREY']);
});

test('callsigns that look like numbers stay as typed', async () => {
  const { call, row, table } = start({ tables: {
    crew: [['HAWK', '1', 'hawk'], ['007', '9', 'bond'], ['0800', '', '']],
    admins: [['007']],
  } });
  const who = await call(9, 'whoami');
  assert.equal(who.callsign, '007');
  assert.equal(who.isAdmin, true);
  await call(1, 'pick', { date: '2026-12-05' });
  await call(9, 'pick', { date: '2026-12-05' });
  assert.deepEqual(row('2026-12-05'), ['2026-12-05', 'HAWK', '007']);
  assert.equal((await call(77, 'link', { callsign: '0800' })).callsign, '0800');
  assert.deepEqual(table('crew').find((c) => c[0] === '0800'), ['0800', '77', 'u77']);
});

test('Telegram messages go out after the change is saved', async () => {
  const { call, events } = start();
  await call(1, 'pick', { date: '2026-12-05' });
  await call(2, 'pick', { date: '2026-12-05' });
  events.length = 0;
  const r = await call(1, 'drop', { date: '2026-12-05' });
  assert.match(r.message, /They got a Telegram message/);
  assert.ok(events.indexOf('save') >= 0 && events.indexOf('save') < events.indexOf('send'), events.join(' '));
});

test('a refused change saves nothing and sends nothing', async () => {
  const { call, events, sent, log } = start();
  events.length = 0;
  const r = await call(1, 'drop', { date: '2026-12-05' });
  assert.equal(r.ok, false);
  assert.deepEqual(events, []);
  assert.deepEqual(sent, []);
  assert.deepEqual(log(), []);
});

test('a busy lock gives a clear message', async () => {
  const { call, picker } = start({ lockWaitMs: 20 });
  let release;
  const held = picker.withLock(() => new Promise((r) => { release = r; }));
  const r = await call(1, 'pick', { date: '2026-12-05' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'BDO Picker is busy. Try again in a moment.');
  release();
  await held;
  assert.equal((await call(1, 'pick', { date: '2026-12-05' })).ok, true, 'works again once the lock is free');
});

test('a change that fails part-way still frees the lock', async () => {
  const { call, db } = start();
  const batch = db.batch;
  db.batch = async () => { throw new Error('D1 down'); };
  const r = await call(1, 'pick', { date: '2026-12-05' });
  assert.deepEqual(r, { ok: false, error: 'Something went wrong. Try again in a moment.' });
  db.batch = batch;
  assert.equal((await call(1, 'pick', { date: '2026-12-05' })).ok, true);
});

const reads = (db, table) => db.stats.reads.filter((s) => new RegExp('FROM ' + table + '\\b').test(s)).length;

test('init gives an admin everything in one call', async () => {
  const { call } = start({ tables: { days: [['2026-11-28', 'HAWK', ''], ['2026-12-05', 'HAWK', 'VIPER'], ['2027-01-02', '', '']] } });
  const r = await call(3, 'init');
  assert.equal(r.ok, true);
  assert.equal(r.linked, true);
  assert.equal(r.callsign, 'MAMBA');
  assert.equal(r.isAdmin, true);
  assert.deepEqual(r.days.map((d) => d.date), ['2026-12-05', '2027-01-02'], 'from the start of this month onwards');
  assert.deepEqual(r.admins, ['MAMBA']);
  assert.deepEqual(r.linkedCallsigns, ['HAWK', 'VIPER', 'MAMBA', 'OSPREY']);
  assert.equal(typeof r.lastChange, 'string');
});

test('init for a non-admin has no admin data', async () => {
  const { call } = start();
  const r = await call(1, 'init');
  assert.equal(r.isAdmin, false);
  assert.equal(r.days.length, 2);
  assert.equal(r.admins, undefined);
});

test('init for an unlinked user lists the crew and no days', async () => {
  const { call } = start();
  const r = await call(77, 'init');
  assert.equal(r.linked, false);
  assert.ok(r.crew.length > 0);
  assert.equal(r.days, undefined);
});

test('link answers with the same data as init', async () => {
  const { call } = start();
  const r = await call(77, 'link', { callsign: 'RAVEN' });
  assert.equal(r.linked, true);
  assert.equal(r.days.length, 2);
});

test('setDay answers with all upcoming days', async () => {
  const { call } = start({ tables: { days: [['2026-12-05', '', ''], ['2027-01-02', '', '']] } });
  const r = await call(3, 'setDay', { date: '2026-12-08', on: true });
  assert.deepEqual(r.days.map((d) => d.date), ['2026-12-05', '2026-12-08', '2027-01-02']);
});

test('a request reads each table only as often as it needs', async () => {
  const { call, db } = start();
  await call(1, 'pick', { date: '2026-12-05' });
  await call(2, 'pick', { date: '2026-12-05' });
  db.stats.reads.length = 0;
  await call(1, 'drop', { date: '2026-12-05' }); // promotes VIPER and messages them
  assert.equal(reads(db, 'crew'), 2, 'once to see who you are, once fresh under the lock');
  assert.equal(reads(db, 'days'), 1);
  db.stats.reads.length = 0;
  await call(3, 'init');
  assert.equal(reads(db, 'crew'), 1);
  assert.equal(reads(db, 'admins'), 1);
  assert.equal(reads(db, 'days'), 1);
});

test('a change saves only the rows that changed, in one batch', async () => {
  const { call, db } = start({ tables: { days: Array.from({ length: 20 }, (_, i) => ['2026-12-' + String(i + 5).padStart(2, '0'), '', '']) } });
  db.stats.batches = 0;
  db.stats.queries = 0;
  await call(1, 'pick', { date: '2026-12-05' });
  assert.equal(db.stats.batches, 1);
  assert.ok(db.stats.queries <= 8, 'queries: ' + db.stats.queries);
});

test('admin makes someone BDO: old BDO goes to queue 1, both are told', async () => {
  const { call, row, sent, log } = start();
  await call(1, 'pick', { date: '2026-12-05' });
  await call(2, 'pick', { date: '2026-12-05' });
  sent.length = 0;
  const r = await call(3, 'assign', { date: '2026-12-05', callsign: 'osprey', as: 'bdo' });
  assert.equal(r.ok, true);
  assert.deepEqual(row('2026-12-05'), ['2026-12-05', 'OSPREY', 'HAWK, VIPER']);
  assert.deepEqual(sent, [
    { chat_id: '4', text: 'The BDO planner has put you on Saturday 5 Dec as BDO.' },
    { chat_id: '1', text: 'The BDO planner has made OSPREY BDO on Saturday 5 Dec. You are now number 1 in the queue.' },
  ]);
  assert.equal(r.message, 'OSPREY is now BDO on Saturday 5 Dec. HAWK moved to number 1 in the queue.');
  const l = log();
  assert.equal(l[l.length - 1][2], 'put OSPREY on Saturday 5 Dec as BDO');
});

test('admin adds someone to the queue', async () => {
  const { call, row, sent, log } = start();
  await call(1, 'pick', { date: '2026-12-05' });
  sent.length = 0;
  const r = await call(3, 'assign', { date: '2026-12-05', callsign: 'RAVEN', as: 'queue' });
  assert.equal(r.ok, true);
  assert.deepEqual(row('2026-12-05'), ['2026-12-05', 'HAWK', 'RAVEN']);
  assert.equal(r.message, 'RAVEN is number 1 in the queue for Saturday 5 Dec.');
  assert.deepEqual(sent, [], 'RAVEN has no Telegram linked yet, so nothing is sent');
  assert.ok(log().some((l) => l[2] === 'message to RAVEN not delivered'));
});

test('admin takes someone off a day', async () => {
  const { call, row, sent } = start();
  await call(1, 'pick', { date: '2026-12-05' });
  await call(2, 'pick', { date: '2026-12-05' });
  sent.length = 0;
  const r = await call(3, 'unassign', { date: '2026-12-05', callsign: 'HAWK' });
  assert.equal(r.ok, true);
  assert.deepEqual(row('2026-12-05'), ['2026-12-05', 'VIPER', '']);
  assert.deepEqual(sent, [
    { chat_id: '1', text: 'The BDO planner has taken you off Saturday 5 Dec.' },
    { chat_id: '2', text: "You're now BDO on Saturday 5 Dec. HAWK was taken off the day, so you moved up from first in the queue." },
  ]);
  assert.equal(r.message, 'HAWK is off Saturday 5 Dec. VIPER moved up to BDO.');
});

test('only admins can put people on days, and only crew callsigns', async () => {
  const { call } = start();
  assert.equal((await call(1, 'assign', { date: '2026-12-05', callsign: 'VIPER', as: 'bdo' })).error, 'Only the BDO planner can do that.');
  assert.equal((await call(1, 'unassign', { date: '2026-12-05', callsign: 'VIPER' })).error, 'Only the BDO planner can do that.');
  assert.match((await call(3, 'assign', { date: '2026-12-05', callsign: 'NOBODY', as: 'bdo' })).error, /not on the crew list/);
  assert.equal((await call(3, 'assign', { date: '2026-12-06', callsign: 'VIPER', as: 'bdo' })).error, "The planner hasn't set that day as a BDO day.");
});

test('init gives admins the whole crew list for putting people on days', async () => {
  const { call } = start();
  assert.deepEqual((await call(3, 'init')).crewCallsigns, ['HAWK', 'VIPER', 'MAMBA', 'OSPREY', 'RAVEN', 'KESTREL']);
  assert.equal((await call(1, 'init')).crewCallsigns, undefined);
});

test('admin adds crew', async () => {
  const { call, table } = start();
  const r = await call(3, 'addCrew', { callsign: ' falcon ' });
  assert.equal(r.ok, true);
  assert.deepEqual(table('crew')[table('crew').length - 1], ['FALCON', '', '']);
  assert.deepEqual(r.crewList.find((c) => c.callsign === 'FALCON'), { callsign: 'FALCON', linked: false });
  assert.equal((await call(3, 'addCrew', { callsign: 'hawk' })).error, 'HAWK is already on the crew list.');
  assert.equal((await call(1, 'addCrew', { callsign: 'X1' })).error, 'Only the BDO planner can do that.');
});

test('admin removes crew: off upcoming days, queue moves up, promoted person told', async () => {
  const { call, table, sent, db } = start({ tables: {
    days: [['2026-11-28', 'VIPER', ''], ['2026-12-05', 'HAWK', 'VIPER'], ['2026-12-12', 'VIPER', 'OSPREY']],
    admins: [['MAMBA'], ['VIPER']],
  } });
  const r = await call(3, 'removeCrew', { callsign: 'VIPER' });
  assert.equal(r.ok, true);
  assert.ok(!table('crew').some((c) => c[0] === 'VIPER'));
  assert.deepEqual(table('admins'), [['MAMBA']]);
  assert.deepEqual(db.sql.prepare('SELECT date, bdo, queue FROM days ORDER BY date').all().map((x) => Object.values(x)),
    [['2026-11-28', 'VIPER', ''], ['2026-12-05', 'HAWK', ''], ['2026-12-12', 'OSPREY', '']]);
  assert.deepEqual(sent, [{ chat_id: '4', text: "You're now BDO on Saturday 12 Dec. VIPER was taken off the crew list, so you moved up from first in the queue." }]);
  assert.equal(r.message, 'VIPER removed from the crew and taken off 2 upcoming days.');
  assert.deepEqual(r.days.map((d) => d.date), ['2026-12-05', '2026-12-12']);
  assert.equal((await call(3, 'removeCrew', { callsign: 'MAMBA' })).ok, false);
});

test('find group saves the group the bot last heard /bdo in', async () => {
  const updates = [
    { update_id: 1, message: { chat: { id: 555, type: 'private', first_name: 'M' }, text: '/start' } },
    { update_id: 2, message: { chat: { id: -100123, type: 'supergroup', title: '121 SQN BDO' }, text: '/bdo@bdo_test_bot' } },
  ];
  const { call, table } = start({ updates });
  const r = await call(3, 'findGroup');
  assert.equal(r.ok, true);
  assert.equal(r.groupTitle, '121 SQN BDO');
  assert.deepEqual(table('settings').find((s) => s[0] === 'GROUP_CHAT_ID'), ['GROUP_CHAT_ID', '-100123']);
  assert.equal((await call(3, 'init')).groupTitle, '121 SQN BDO');
});

test('find group explains what to do when it finds nothing', async () => {
  const { call } = start({ updates: [] });
  assert.equal((await call(3, 'findGroup')).error, "I couldn't find the group. Add the bot to the group, send /bdo there, then tap Find group again.");
});

test('announce: preview sends nothing, post goes to the group with an app button', async () => {
  const { call, sent, log, table } = start({ updates: [{ update_id: 2, message: { chat: { id: -100123, type: 'group', title: 'BDO' }, text: '/bdo' } }] });
  await call(3, 'findGroup');
  const p = await call(3, 'announce', { month: '2026-12', note: '', preview: true });
  assert.equal(p.ok, true);
  assert.match(p.text, /^BDO dates for December 2026 are up\./);
  assert.equal(sent.length, 0);
  const r = await call(3, 'announce', { month: '2026-12', note: 'Thanks all.' });
  assert.equal(r.ok, true);
  assert.equal(r.message, 'Posted to BDO.');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, '-100123');
  assert.match(sent[0].text, /Thanks all\.$/);
  assert.deepEqual(sent[0].reply_markup, { inline_keyboard: [[{ text: 'Open BDO Picker', url: 'https://t.me/bdo_test_bot/pick' }]] });
  assert.ok(log().some((l) => l[2] === 'posted December 2026 to the group'));
  assert.deepEqual(table('settings').find((s) => s[0] === 'BOT_USERNAME'), ['BOT_USERNAME', 'bdo_test_bot'], 'bot name remembered');
});

test('announce without a group, or by a non-admin, is refused', async () => {
  const { call } = start();
  assert.equal((await call(3, 'announce', { month: '2026-12' })).error, 'Connect the group first: tap Find group.');
  assert.equal((await call(1, 'announce', { month: '2026-12' })).error, 'Only the BDO planner can do that.');
});

test('admins can read the log, newest first, 50 at a time', async () => {
  const { call, db } = start();
  for (let i = 1; i <= 60; i++) db.sql.prepare('INSERT INTO log (at, who, what) VALUES (?, ?, ?)').run('2026-11-30 09:00', 'HAWK', 'line ' + i);
  const first = await call(3, 'log');
  assert.equal(first.ok, true);
  assert.equal(first.entries.length, 50);
  assert.equal(first.more, true);
  assert.deepEqual(first.entries[0], { id: 60, at: '2026-11-30 09:00', who: 'HAWK', what: 'line 60' });
  const older = await call(3, 'log', { before: first.entries[49].id });
  assert.deepEqual(older.entries.map((e) => e.what), Array.from({ length: 10 }, (_, i) => 'line ' + (10 - i)));
  assert.equal(older.more, false);
});

test('only admins can read the log', async () => {
  const { call } = start();
  assert.equal((await call(1, 'log')).error, 'Only the BDO planner can do that.');
  assert.equal((await call(77, 'log')).error, 'Pick your callsign first.');
});

test('setDay that changes nothing writes no log line and messages nobody', async () => {
  const { call, log, sent } = start();
  await call(1, 'pick', { date: '2026-12-05' });
  const before = log().length;
  const on = await call(3, 'setDay', { date: '2026-12-05', on: true });
  const off = await call(3, 'setDay', { date: '2026-12-25', on: false });
  assert.equal(on.ok, true);
  assert.equal(off.ok, true);
  assert.equal(on.days.length, 2);
  assert.equal(log().length, before);
  assert.deepEqual(sent, []);
});

test('a day-old sign-in answers EXPIRED and changes nothing', async () => {
  const { call, table } = start();
  const before = JSON.stringify(table('days'));
  const old = initDataFor({ id: 1, username: 'hawk' }, TOKEN, Math.floor(NOW.getTime() / 1000) - 86401);
  const r = await call(1, 'pick', { date: '2026-12-05' }, old);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EXPIRED');
  assert.match(r.error, /open it again from Telegram/);
  assert.equal(JSON.stringify(table('days')), before);
  assert.equal((await call(1, 'pick', { date: '2026-12-05' }, 'junk')).code, 'AUTH');
});
