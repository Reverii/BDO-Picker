const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGs } = require('./load_gs');
const { makeGas } = require('./gas_fakes');
const { initDataFor } = require('./tg_sign');

const TOKEN = '123456:TEST-token';
const NOW = new Date('2026-12-01T02:00:00Z'); // 10:00 Singapore time

function start(opts = {}) {
  const tabs = {
    Days: [['Date', 'BDO', 'Queue'], ['2026-12-05', '', ''], ['2026-12-12', '', '']],
    Crew: [['Callsign', 'Telegram ID', 'Telegram username'], ['HAWK', '1', 'hawk'], ['VIPER', '2', 'viper'], ['MAMBA', '3', 'mamba'], ['OSPREY', '4', 'osprey'], ['RAVEN', '', ''], ['KESTREL', '', '']],
    Admins: [['Callsign'], ['MAMBA']],
    Log: [['When', 'Who', 'What']],
    ...(opts.tabs || {}),
  };
  const gas = makeGas({ botToken: TOKEN, now: NOW, tabs, telegramStatus: opts.telegramStatus || 200 });
  const ctx = loadGs(['Rules.gs', 'Auth.gs', 'Code.gs'], gas.globals);
  ctx.nowDate = () => new Date(NOW.getTime());
  const call = (tgId, action, args = {}, initData) => {
    const id = initData !== undefined ? initData : initDataFor({ id: tgId, username: 'u' + tgId }, TOKEN, Math.floor(NOW.getTime() / 1000) - 10);
    const out = ctx.doPost({ postData: { contents: JSON.stringify({ initData: id, action, ...args }) } });
    return JSON.parse(out.getContent());
  };
  return { gas, ctx, call };
}
const row = (gas, date) => gas.sheet('Days').find((r) => r[0] === date);

test('pick then pick: BDO then queue', () => {
  const { gas, call } = start();
  const a = call(1, 'pick', { date: '2026-12-05' });
  const b = call(2, 'pick', { date: '2026-12-05' });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.deepEqual(row(gas, '2026-12-05'), ['2026-12-05', 'HAWK', 'VIPER']);
  assert.equal(gas.state.lockCalls, 2);
  assert.equal(gas.state.released, 2);
  assert.equal(b.message, 'HAWK got there first. You are number 1 in the queue for Saturday 5 Dec.');
  assert.equal(b.day.bdo, 'HAWK');
});

test('drop promotes and messages the new BDO', () => {
  const { gas, call } = start();
  call(1, 'pick', { date: '2026-12-05' });
  call(2, 'pick', { date: '2026-12-05' });
  call(4, 'pick', { date: '2026-12-05' });
  const r = call(1, 'drop', { date: '2026-12-05' });
  assert.equal(r.ok, true);
  assert.deepEqual(row(gas, '2026-12-05'), ['2026-12-05', 'VIPER', 'OSPREY']);
  assert.deepEqual(gas.state.sent, [{ chat_id: '2', text: "You're now BDO on Saturday 5 Dec. HAWK dropped the day, so you moved up from first in the queue." }]);
  assert.match(r.message, /VIPER moved up to BDO/);
});

test('bad initData changes nothing', () => {
  const { gas, call } = start();
  const before = JSON.stringify(gas.sheet('Days'));
  const forged = initDataFor({ id: 1, username: 'x' }, 'wrong:token', Math.floor(NOW.getTime() / 1000));
  const r = call(1, 'pick', { date: '2026-12-05' }, forged);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Open BDO Picker from the Telegram link.');
  assert.equal(JSON.stringify(gas.sheet('Days')), before);
  assert.equal(call(1, 'pick', { date: '2026-12-05' }, '').ok, false);
});

test('picking a day the planner has not set is refused', () => {
  const { call } = start();
  const r = call(1, 'pick', { date: '2026-12-06' });
  assert.equal(r.ok, false);
  assert.equal(r.error, "The planner hasn't set that day as a BDO day.");
});

test('unlinked user cannot pick', () => {
  const { call } = start();
  const r = call(77, 'pick', { date: '2026-12-05' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Pick your callsign first.');
});

test('month returns only that month', () => {
  const { call } = start({ tabs: { Days: [['Date', 'BDO', 'Queue'], ['2026-12-05', 'HAWK', 'VIPER, OSPREY'], ['2027-01-02', '', '']] } });
  const r = call(3, 'month', { month: '2026-12' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.days, [{ date: '2026-12-05', bdo: 'HAWK', queue: ['VIPER', 'OSPREY'] }]);
});

test('dates typed as real dates in the Sheet still read correctly', () => {
  const { call } = start({ tabs: { Days: [['Date', 'BDO', 'Queue'], [new Date('2026-12-04T16:00:00Z'), 'HAWK', '']] } });
  const r = call(3, 'month', { month: '2026-12' });
  assert.equal(r.days[0].date, '2026-12-05');
});

test('non-admin cannot setDay', () => {
  const { gas, call } = start();
  const r = call(1, 'setDay', { date: '2026-12-19', on: true });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Only the BDO planner can do that.');
  assert.equal(gas.sheet('Days').length, 3);
});

test('admin setDay on adds the day', () => {
  const { gas, call } = start();
  const r = call(3, 'setDay', { date: '2026-12-08', on: true });
  assert.equal(r.ok, true);
  assert.deepEqual(gas.sheet('Days').map((x) => x[0]), ['Date', '2026-12-05', '2026-12-08', '2026-12-12']);
  assert.deepEqual(r.days.map((d) => d.date), ['2026-12-05', '2026-12-08', '2026-12-12']);
});

test('admin setDay off messages everyone on it', () => {
  const { gas, call } = start();
  call(1, 'pick', { date: '2026-12-05' });
  call(2, 'pick', { date: '2026-12-05' });
  const r = call(3, 'setDay', { date: '2026-12-05', on: false });
  assert.equal(r.ok, true);
  assert.equal(row(gas, '2026-12-05'), undefined);
  const text = 'Saturday 5 Dec is no longer needed as a BDO day, so it has been taken off your days.';
  assert.deepEqual(gas.state.sent, [{ chat_id: '1', text }, { chat_id: '2', text }]);
});

test('failed Telegram send still succeeds', () => {
  const { gas, call } = start({ telegramStatus: 403 });
  call(1, 'pick', { date: '2026-12-05' });
  call(2, 'pick', { date: '2026-12-05' });
  const r = call(1, 'drop', { date: '2026-12-05' });
  assert.equal(r.ok, true);
  assert.equal(row(gas, '2026-12-05')[1], 'VIPER');
  assert.ok(gas.sheet('Log').some((l) => l[2] === 'message to VIPER not delivered'));
  assert.doesNotMatch(r.message, /got a Telegram message/);
  assert.ok(gas.state.fetchUrls[0].startsWith('https://api.telegram.org/bot' + TOKEN + '/sendMessage'));
});

test('whoami for an unlinked user lists crew with taken flags', () => {
  const { call } = start();
  const r = call(77, 'whoami');
  assert.equal(r.ok, true);
  assert.equal(r.linked, false);
  assert.deepEqual(r.crew.find((c) => c.callsign === 'HAWK'), { callsign: 'HAWK', taken: true });
  assert.deepEqual(r.crew.find((c) => c.callsign === 'RAVEN'), { callsign: 'RAVEN', taken: false });
});

test('link then whoami shows linked', () => {
  const { gas, call } = start();
  const r = call(77, 'link', { callsign: 'raven' });
  assert.equal(r.ok, true);
  assert.equal(r.linked, true);
  assert.equal(r.callsign, 'RAVEN');
  assert.equal(r.isAdmin, false);
  assert.deepEqual(gas.sheet('Crew').find((c) => c[0] === 'RAVEN'), ['RAVEN', '77', 'u77']);
  const again = call(77, 'whoami');
  assert.equal(again.callsign, 'RAVEN');
  assert.equal(again.crew, undefined);
});

test('linking a taken callsign is refused', () => {
  const { call } = start();
  const r = call(77, 'link', { callsign: 'HAWK' });
  assert.equal(r.ok, false);
  assert.match(r.error, /already linked to someone else/);
});

test('addAdmin sends the new-admin message', () => {
  const { gas, call } = start();
  const r = call(3, 'addAdmin', { callsign: 'OSPREY' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.admins, ['MAMBA', 'OSPREY']);
  assert.deepEqual(gas.sheet('Admins'), [['Callsign'], ['MAMBA'], ['OSPREY']]);
  assert.deepEqual(gas.state.sent, [{ chat_id: '4', text: "You're now a BDO planner. Open BDO Picker to set the BDO days." }]);
  assert.equal(r.lastChange, 'MAMBA added OSPREY as admin · 1 Dec');
});

test('removeMe as last admin is refused', () => {
  const { gas, call } = start();
  const r = call(3, 'removeMe');
  assert.equal(r.ok, false);
  assert.match(r.error, /only admin/);
  assert.deepEqual(gas.sheet('Admins'), [['Callsign'], ['MAMBA']]);
});

test('removeMe with another admin works', () => {
  const { gas, call } = start({ tabs: { Admins: [['Callsign'], ['MAMBA'], ['OSPREY']] } });
  const r = call(3, 'removeMe');
  assert.equal(r.ok, true);
  assert.deepEqual(gas.sheet('Admins'), [['Callsign'], ['OSPREY']]);
  assert.equal(call(3, 'whoami').isAdmin, false);
});

test('setup creates the four tabs with headers', () => {
  const gas = makeGas({ botToken: TOKEN, now: NOW, tabs: {} });
  const ctx = loadGs(['Rules.gs', 'Auth.gs', 'Code.gs'], gas.globals);
  ctx.setup();
  assert.deepEqual(gas.sheet('Days')[0], ['Date', 'BDO', 'Queue']);
  assert.deepEqual(gas.sheet('Crew')[0], ['Callsign', 'Telegram ID', 'Telegram username']);
  assert.deepEqual(gas.sheet('Admins')[0], ['Callsign']);
  assert.deepEqual(gas.sheet('Log')[0], ['When', 'Who', 'What']);
  ctx.setup();
  assert.equal(gas.sheet('Days').length, 1, 'running setup twice changes nothing');
});

test('every write is logged', () => {
  const { gas, call } = start();
  call(1, 'pick', { date: '2026-12-05' });
  const log = gas.sheet('Log');
  assert.deepEqual(log[log.length - 1], ['2026-12-01 10:00', 'HAWK', 'picked Saturday 5 Dec (BDO)']);
});

test('admins lists linked callsigns for the add-admin choice', () => {
  const { call } = start();
  const r = call(3, 'admins');
  assert.equal(r.ok, true);
  assert.deepEqual(r.linked, ['HAWK', 'VIPER', 'MAMBA', 'OSPREY']);
});
