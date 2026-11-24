// Browser-side stand-in for the Worker, for the page tests.
// Needs worker/src/rules.js loaded first. Options come from window.FAKE_OPTS: { linked, admin, delay }.
(function () {
  var o = window.FAKE_OPTS || {};
  var ME_ID = '3';
  var state = {
    crew: [
      { callsign: 'HAWK', telegramId: '1', username: 'hawk' },
      { callsign: 'VIPER', telegramId: '2', username: 'viper' },
      { callsign: 'MAMBA', telegramId: o.linked ? ME_ID : '', username: '' },
      { callsign: 'OSPREY', telegramId: '4', username: 'osprey' },
      { callsign: 'RAVEN', telegramId: '', username: '' },
    ],
    admins: o.admin === false ? ['OSPREY'] : ['MAMBA'],
    days: [
      { date: '2026-12-05', bdo: 'HAWK', queue: ['VIPER'] },
      { date: '2026-12-12', bdo: '', queue: [] },
      { date: '2026-12-20', bdo: 'OSPREY', queue: [] },
      { date: '2027-01-09', bdo: 'MAMBA', queue: [] },
    ],
    lastChange: 'OSPREY added MAMBA as admin · 20 Nov',
    log: [],
  };
  // 55 log lines over two days, oldest first (ids 1..55).
  for (var n = 1; n <= 55; n++) {
    state.log.push({ id: n, at: (n <= 30 ? '2026-11-30 ' : '2026-12-01 ') + (n % 24 < 10 ? '0' : '') + (n % 24) + ':00', who: n % 2 ? 'HAWK' : 'VIPER', what: n === 55 ? 'message to RAVEN not delivered' : 'picked line ' + n });
  }
  var today = window.BDO_TODAY || '2026-12-01';
  window.FAKE = { calls: [], state: state };

  function me() { var r = state.crew.filter(function (c) { return c.telegramId === ME_ID; })[0]; return r ? r.callsign : ''; }
  function whoami() {
    var m = me();
    var d = { linked: !!m, callsign: m, isAdmin: !!m && state.admins.indexOf(m) >= 0 };
    if (!m) d.crew = state.crew.map(function (c) { return { callsign: c.callsign, taken: !!c.telegramId }; });
    return d;
  }
  function upcoming() { var start = today.slice(0, 7) + '-01'; return state.days.filter(function (d) { return d.date >= start; }); }
  function linkedCallsigns() { return state.crew.filter(function (c) { return c.telegramId; }).map(function (c) { return c.callsign; }); }
  function init() {
    var d = whoami();
    if (!d.linked) return d;
    d.days = upcoming();
    if (d.isAdmin) { d.admins = state.admins; d.linkedCallsigns = linkedCallsigns(); d.lastChange = state.lastChange; d.crewCallsigns = state.crew.map(function (c) { return c.callsign; }); d.crewList = crewList(); d.groupTitle = state.groupTitle; }
    return d;
  }
  function crewList() { return state.crew.map(function (c) { return { callsign: c.callsign, linked: !!c.telegramId }; }); }
  function month(m) { return state.days.filter(function (d) { return d.date.slice(0, 7) === m; }); }
  function find(date) {
    for (var i = 0; i < state.days.length; i++) if (state.days[i].date === date) return i;
    throw new RuleError('NOT_SET', "The planner hasn't set that day as a BDO day.");
  }
  function run(action, args) {
    if (action === 'init') return init();
    if (action === 'whoami') return whoami();
    if (action === 'link') { state.crew = linkCallsign(state.crew, ME_ID, 'mamba_ops', args.callsign); return init(); }
    var m = me();
    if (!m) throw new RuleError('NOT_LINKED_ME', 'Pick your callsign first.');
    if (action === 'month') return { days: month(args.month) };
    if (action === 'pick') {
      var i = find(args.date); var r = pickDay(state.days[i], m, today); state.days[i] = r.day;
      return { day: r.day, message: r.result === 'bdo' ? 'You are BDO on ' + fmtDay(args.date) + '. Anyone who picks it after you joins the queue.' : r.day.bdo + ' got there first. You are number ' + r.position + ' in the queue for ' + fmtDay(args.date) + '.' };
    }
    if (action === 'drop') {
      var j = find(args.date); var d = dropDay(state.days[j], m, today); state.days[j] = d.day;
      return { day: d.day, message: d.result === 'left' ? 'You left the queue for ' + fmtDay(args.date) + '.' : d.promoted ? d.promoted + ' moved up to BDO.' : 'You dropped ' + fmtDay(args.date) + '. It is open again.' };
    }
    if (state.admins.indexOf(m) < 0) throw new RuleError('NOT_ADMIN', 'Only the BDO planner can do that.');
    if (action === 'setDay') { state.days = setDay(state.days, args.date, args.on, today).days; return { days: upcoming() }; }
    if (action === 'assign') {
      var k = find(args.date); var a = assignDay(state.days[k], args.callsign, args.as, today); state.days[k] = a.day; var cs = normCall(args.callsign);
      return { day: a.day, message: a.position === 0 ? cs + ' is now BDO on ' + fmtDay(args.date) + '.' + (a.displaced ? ' ' + a.displaced + ' moved to number 1 in the queue.' : '') : cs + ' is number ' + a.position + ' in the queue for ' + fmtDay(args.date) + '.' };
    }
    if (action === 'unassign') {
      var u = find(args.date); var x = removeFromDay(state.days[u], args.callsign, today); state.days[u] = x.day;
      return { day: x.day, message: normCall(args.callsign) + ' is off ' + fmtDay(args.date) + '.' + (x.promoted ? ' ' + x.promoted + ' moved up to BDO.' : '') };
    }
    if (action === 'addCrew') { state.crew = addCrew(state.crew, args.callsign); return { crewList: crewList(), message: normCall(args.callsign) + ' added to the crew.' }; }
    if (action === 'removeCrew') {
      var rc = removeCrewMember(state.crew, state.admins, state.days, args.callsign, m, today);
      state.crew = rc.crew; state.admins = rc.admins; state.days = rc.days;
      return { crewList: crewList(), admins: state.admins, days: upcoming(), message: normCall(args.callsign) + ' removed from the crew.' };
    }
    if (action === 'log') {
      var older = state.log.filter(function (e) { return !args.before || e.id < args.before; }).reverse();
      return { entries: older.slice(0, 50), more: older.length > 50 };
    }
    if (action === 'findGroup') { state.groupTitle = '121 SQN'; return { groupTitle: state.groupTitle }; }
    if (action === 'announce') {
      if (!state.groupTitle) throw new RuleError('NO_GROUP', 'Connect the group first: tap Find group.');
      var text = announceText(args.month, month(args.month), args.note);
      return args.preview ? { text: text } : { message: 'Posted to ' + state.groupTitle + '.' };
    }
    if (action === 'admins') return { admins: state.admins, linked: state.crew.filter(function (c) { return c.telegramId; }).map(function (c) { return c.callsign; }), lastChange: state.lastChange };
    if (action === 'addAdmin') { state.admins = addAdmin(state.admins, state.crew, args.callsign); state.lastChange = m + ' added ' + normCall(args.callsign) + ' as admin · 1 Dec'; return { admins: state.admins, lastChange: state.lastChange }; }
    if (action === 'removeMe') { state.admins = removeSelf(state.admins, m); state.lastChange = m + ' removed themselves as admin · 1 Dec'; return { admins: state.admins, lastChange: state.lastChange }; }
    throw new RuleError('BAD_ACTION', 'Unknown request.');
  }

  window.BDO_FAKE_API = function (action, args) {
    window.FAKE.calls.push({ action: action, args: args });
    return new Promise(function (resolve) {
      setTimeout(function () {
        try { var data = run(action, args || {}); data.ok = true; resolve(JSON.parse(JSON.stringify(data))); }
        catch (e) { resolve({ ok: false, error: e.message }); }
      }, o.delay || 0);
    });
  };
})();
