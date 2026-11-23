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
  // Start the way the owner does: setup() makes the tabs, then rows are typed in (Sheets may convert them).
  const gas = makeGas({ botToken: TOKEN, now: NOW, tabs: {}, telegramStatus: opts.telegramStatus || 200, lockBusy: !!opts.lockBusy, updates: opts.updates || [] });
  const ctx = loadGs(['Rules.gs', 'Auth.gs', 'Code.gs'], gas.globals);
  ctx.nowDate = () => new Date(NOW.getTime());
  ctx.setup();
  Object.keys(tabs).forEach((name) => tabs[name].slice(1).forEach((r) => gas.sheetObj(name).appendRow(r)));
  gas.state.events.length = 0;
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

test('callsigns that look like numbers stay as typed', () => {
  const { gas, call } = start({ tabs: {
    Crew: [['Callsign', 'Telegram ID', 'Telegram username'], ['HAWK', '1', 'hawk'], ['007', '9', 'bond'], ['0800', '', '']],
    Admins: [['Callsign'], ['007']],
  } });
  const who = call(9, 'whoami');
  assert.equal(who.callsign, '007');
  assert.equal(who.isAdmin, true);
  call(1, 'pick', { date: '2026-12-05' });
  call(9, 'pick', { date: '2026-12-05' });
  assert.deepEqual(row(gas, '2026-12-05'), ['2026-12-05', 'HAWK', '007']);
  assert.equal(call(77, 'link', { callsign: '0800' }).callsign, '0800');
  assert.deepEqual(gas.sheet('Crew').find((c) => c[0] === '0800'), ['0800', '77', 'u77']);
});

test('Sheet changes are saved before the lock opens', () => {
  const { gas, call } = start();
  call(1, 'pick', { date: '2026-12-05' });
  const ev = gas.state.events;
  const lastWrite = ev.lastIndexOf('write');
  const flush = ev.lastIndexOf('flush');
  const release = ev.lastIndexOf('release');
  assert.ok(lastWrite < flush && flush < release, ev.join(' '));
});

test('Telegram messages go out after the lock opens', () => {
  const { gas, call } = start();
  call(1, 'pick', { date: '2026-12-05' });
  call(2, 'pick', { date: '2026-12-05' });
  gas.state.events.length = 0;
  const r = call(1, 'drop', { date: '2026-12-05' });
  assert.match(r.message, /They got a Telegram message/);
  const ev = gas.state.events;
  assert.ok(ev.indexOf('release') >= 0 && ev.indexOf('release') < ev.indexOf('send'), ev.join(' '));
});

test('a busy lock gives a clear message', () => {
  const { call } = start({ lockBusy: true });
  const r = call(1, 'pick', { date: '2026-12-05' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'BDO Picker is busy. Try again in a moment.');
});

const reads = (gas, name) => gas.state.events.filter((e) => e === 'read:' + name).length;

test('init gives an admin everything in one call', () => {
  const { call } = start({ tabs: { Days: [['Date', 'BDO', 'Queue'], ['2026-11-28', 'HAWK', ''], ['2026-12-05', 'HAWK', 'VIPER'], ['2027-01-02', '', '']] } });
  const r = call(3, 'init');
  assert.equal(r.ok, true);
  assert.equal(r.linked, true);
  assert.equal(r.callsign, 'MAMBA');
  assert.equal(r.isAdmin, true);
  assert.deepEqual(r.days.map((d) => d.date), ['2026-12-05', '2027-01-02'], 'from the start of this month onwards');
  assert.deepEqual(r.admins, ['MAMBA']);
  assert.deepEqual(r.linkedCallsigns, ['HAWK', 'VIPER', 'MAMBA', 'OSPREY']);
  assert.equal(typeof r.lastChange, 'string');
});

test('init for a non-admin has no admin data', () => {
  const { call } = start();
  const r = call(1, 'init');
  assert.equal(r.isAdmin, false);
  assert.equal(r.days.length, 2);
  assert.equal(r.admins, undefined);
});

test('init for an unlinked user lists the crew and no days', () => {
  const { call } = start();
  const r = call(77, 'init');
  assert.equal(r.linked, false);
  assert.ok(r.crew.length > 0);
  assert.equal(r.days, undefined);
});

test('link answers with the same data as init', () => {
  const { call } = start();
  const r = call(77, 'link', { callsign: 'RAVEN' });
  assert.equal(r.linked, true);
  assert.equal(r.days.length, 2);
});

test('setDay answers with all upcoming days', () => {
  const { call } = start({ tabs: { Days: [['Date', 'BDO', 'Queue'], ['2026-12-05', '', ''], ['2027-01-02', '', '']] } });
  const r = call(3, 'setDay', { date: '2026-12-08', on: true });
  assert.deepEqual(r.days.map((d) => d.date), ['2026-12-05', '2026-12-08', '2027-01-02']);
});

test('a request reads each tab only once', () => {
  const { gas, call } = start();
  call(1, 'pick', { date: '2026-12-05' });
  call(2, 'pick', { date: '2026-12-05' });
  gas.state.events.length = 0;
  call(1, 'drop', { date: '2026-12-05' }); // promotes VIPER and messages them
  assert.equal(reads(gas, 'Crew'), 1);
  assert.equal(reads(gas, 'Days'), 1);
  gas.state.events.length = 0;
  call(3, 'init');
  assert.equal(reads(gas, 'Crew'), 1);
  assert.equal(reads(gas, 'Admins'), 1);
  assert.equal(reads(gas, 'Days'), 1);
});

test('admin makes someone BDO: old BDO goes to queue 1, both are told', () => {
  const { gas, call } = start();
  call(1, 'pick', { date: '2026-12-05' });
  call(2, 'pick', { date: '2026-12-05' });
  gas.state.sent.length = 0;
  const r = call(3, 'assign', { date: '2026-12-05', callsign: 'osprey', as: 'bdo' });
  assert.equal(r.ok, true);
  assert.deepEqual(row(gas, '2026-12-05'), ['2026-12-05', 'OSPREY', 'HAWK, VIPER']);
  assert.deepEqual(gas.state.sent, [
    { chat_id: '4', text: 'The BDO planner has put you on Saturday 5 Dec as BDO.' },
    { chat_id: '1', text: 'The BDO planner has made OSPREY BDO on Saturday 5 Dec. You are now number 1 in the queue.' },
  ]);
  assert.equal(r.message, 'OSPREY is now BDO on Saturday 5 Dec. HAWK moved to number 1 in the queue.');
  const log = gas.sheet('Log');
  assert.equal(log[log.length - 1][2], 'put OSPREY on Saturday 5 Dec as BDO');
});

test('admin adds someone to the queue', () => {
  const { gas, call } = start();
  call(1, 'pick', { date: '2026-12-05' });
  gas.state.sent.length = 0;
  const r = call(3, 'assign', { date: '2026-12-05', callsign: 'RAVEN', as: 'queue' });
  assert.equal(r.ok, true);
  assert.deepEqual(row(gas, '2026-12-05'), ['2026-12-05', 'HAWK', 'RAVEN']);
  assert.equal(r.message, 'RAVEN is number 1 in the queue for Saturday 5 Dec.');
  assert.deepEqual(gas.state.sent, [], 'RAVEN has no Telegram linked yet, so nothing is sent');
  assert.ok(gas.sheet('Log').some((l) => l[2] === 'message to RAVEN not delivered'));
});

test('admin takes someone off a day', () => {
  const { gas, call } = start();
  call(1, 'pick', { date: '2026-12-05' });
  call(2, 'pick', { date: '2026-12-05' });
  gas.state.sent.length = 0;
  const r = call(3, 'unassign', { date: '2026-12-05', callsign: 'HAWK' });
  assert.equal(r.ok, true);
  assert.deepEqual(row(gas, '2026-12-05'), ['2026-12-05', 'VIPER', '']);
  assert.deepEqual(gas.state.sent, [
    { chat_id: '1', text: 'The BDO planner has taken you off Saturday 5 Dec.' },
    { chat_id: '2', text: "You're now BDO on Saturday 5 Dec. HAWK was taken off the day, so you moved up from first in the queue." },
  ]);
  assert.equal(r.message, 'HAWK is off Saturday 5 Dec. VIPER moved up to BDO.');
});

test('only admins can put people on days, and only crew callsigns', () => {
  const { call } = start();
  assert.equal(call(1, 'assign', { date: '2026-12-05', callsign: 'VIPER', as: 'bdo' }).error, 'Only the BDO planner can do that.');
  assert.equal(call(1, 'unassign', { date: '2026-12-05', callsign: 'VIPER' }).error, 'Only the BDO planner can do that.');
  assert.match(call(3, 'assign', { date: '2026-12-05', callsign: 'NOBODY', as: 'bdo' }).error, /not on the crew list/);
  assert.equal(call(3, 'assign', { date: '2026-12-06', callsign: 'VIPER', as: 'bdo' }).error, "The planner hasn't set that day as a BDO day.");
});

test('init gives admins the whole crew list for putting people on days', () => {
  const { call } = start();
  assert.deepEqual(call(3, 'init').crewCallsigns, ['HAWK', 'VIPER', 'MAMBA', 'OSPREY', 'RAVEN', 'KESTREL']);
  assert.equal(call(1, 'init').crewCallsigns, undefined);
});

test('admin adds crew', () => {
  const { gas, call } = start();
  const r = call(3, 'addCrew', { callsign: ' falcon ' });
  assert.equal(r.ok, true);
  assert.ok(gas.sheet('Crew').some((c) => c[0] === 'FALCON' && c[1] === ''));
  assert.deepEqual(r.crewList.find((c) => c.callsign === 'FALCON'), { callsign: 'FALCON', linked: false });
  assert.equal(call(3, 'addCrew', { callsign: 'hawk' }).error, 'HAWK is already on the crew list.');
  assert.equal(call(1, 'addCrew', { callsign: 'X1' }).error, 'Only the BDO planner can do that.');
});

test('admin removes crew: off upcoming days, queue moves up, promoted person told', () => {
  const { gas, call } = start({ tabs: {
    Days: [['Date', 'BDO', 'Queue'], ['2026-11-28', 'VIPER', ''], ['2026-12-05', 'HAWK', 'VIPER'], ['2026-12-12', 'VIPER', 'OSPREY']],
    Admins: [['Callsign'], ['MAMBA'], ['VIPER']],
  } });
  const r = call(3, 'removeCrew', { callsign: 'VIPER' });
  assert.equal(r.ok, true);
  assert.ok(!gas.sheet('Crew').some((c) => c[0] === 'VIPER'));
  assert.deepEqual(gas.sheet('Admins'), [['Callsign'], ['MAMBA']]);
  assert.deepEqual(gas.sheet('Days').slice(1), [['2026-11-28', 'VIPER', ''], ['2026-12-05', 'HAWK', ''], ['2026-12-12', 'OSPREY', '']]);
  assert.deepEqual(gas.state.sent, [{ chat_id: '4', text: "You're now BDO on Saturday 12 Dec. VIPER was taken off the crew list, so you moved up from first in the queue." }]);
  assert.equal(r.message, 'VIPER removed from the crew and taken off 2 upcoming days.');
  assert.deepEqual(r.days.map((d) => d.date), ['2026-12-05', '2026-12-12']);
  assert.equal(call(3, 'removeCrew', { callsign: 'MAMBA' }).ok, false);
});

test('find group saves the group the bot last heard /bdo in', () => {
  const updates = [
    { update_id: 1, message: { chat: { id: 555, type: 'private', first_name: 'M' }, text: '/start' } },
    { update_id: 2, message: { chat: { id: -100123, type: 'supergroup', title: '121 SQN BDO' }, text: '/bdo@bdo_test_bot' } },
  ];
  const { gas, call } = start({ updates });
  const r = call(3, 'findGroup');
  assert.equal(r.ok, true);
  assert.equal(r.groupTitle, '121 SQN BDO');
  assert.equal(gas.state.props.GROUP_CHAT_ID, '-100123');
  assert.equal(call(3, 'init').groupTitle, '121 SQN BDO');
});

test('find group explains what to do when it finds nothing', () => {
  const { call } = start({ updates: [] });
  assert.equal(call(3, 'findGroup').error, "I couldn't find the group. Add the bot to the group, send /bdo there, then tap Find group again.");
});

test('announce: preview sends nothing, post goes to the group with an app button', () => {
  const { gas, call } = start({ updates: [{ update_id: 2, message: { chat: { id: -100123, type: 'group', title: 'BDO' }, text: '/bdo' } }] });
  call(3, 'findGroup');
  const p = call(3, 'announce', { month: '2026-12', note: '', preview: true });
  assert.equal(p.ok, true);
  assert.match(p.text, /^BDO dates for December 2026 are up\./);
  assert.equal(gas.state.sent.length, 0);
  const r = call(3, 'announce', { month: '2026-12', note: 'Thanks all.' });
  assert.equal(r.ok, true);
  assert.equal(r.message, 'Posted to BDO.');
  assert.equal(gas.state.sent.length, 1);
  assert.equal(gas.state.sent[0].chat_id, '-100123');
  assert.match(gas.state.sent[0].text, /Thanks all\.$/);
  assert.deepEqual(gas.state.sent[0].reply_markup, { inline_keyboard: [[{ text: 'Open BDO Picker', url: 'https://t.me/bdo_test_bot/pick' }]] });
  assert.ok(gas.sheet('Log').some((l) => l[2] === 'posted December 2026 to the group'));
});

test('announce without a group, or by a non-admin, is refused', () => {
  const { call } = start();
  assert.equal(call(3, 'announce', { month: '2026-12' }).error, 'Connect the group first: tap Find group.');
  assert.equal(call(1, 'announce', { month: '2026-12' }).error, 'Only the BDO planner can do that.');
});
