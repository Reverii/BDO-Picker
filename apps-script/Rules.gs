// BDO Picker rules. Plain JavaScript: no Apps Script services here, so Node tests and the
// page's test fake can run it as-is. Every function returns new objects; inputs are never changed.

class RuleError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function normCall(s) {
  return String(s == null ? '' : s).trim().toUpperCase();
}

function copyDay(day) {
  return { date: day.date, bdo: normCall(day.bdo), queue: (day.queue || []).map(normCall) };
}

function checkDate(date, today) {
  if (!DATE_RE.test(String(date))) throw new RuleError('BAD_DATE', 'That date is not valid.');
  if (date < today) throw new RuleError('PAST', 'That day has already passed.');
}

// 'YYYY-MM-DD' -> 'Saturday 5 Dec'
function fmtDay(date) {
  var p = String(date).split('-').map(Number);
  var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return WEEKDAYS[d.getUTCDay()] + ' ' + p[2] + ' ' + MONTHS[p[1] - 1];
}

// First picker becomes BDO; everyone after joins the queue in pick order.
function pickDay(day, me, today) {
  checkDate(day.date, today);
  me = normCall(me);
  var d = copyDay(day);
  if (d.bdo === me || d.queue.indexOf(me) >= 0) throw new RuleError('ALREADY_ON', "You're already on this day.");
  if (!d.bdo) {
    d.bdo = me;
    return { day: d, result: 'bdo', position: 0 };
  }
  d.queue.push(me);
  return { day: d, result: 'queued', position: d.queue.length };
}

// BDO drops: queue head moves up (or the day opens). Queue member leaves: people behind move up.
function dropDay(day, me, today) {
  checkDate(day.date, today);
  me = normCall(me);
  var d = copyDay(day);
  if (d.bdo === me) {
    var promoted = d.queue.length ? d.queue.shift() : '';
    d.bdo = promoted;
    return { day: d, promoted: promoted, result: 'dropped' };
  }
  var at = d.queue.indexOf(me);
  if (at < 0) throw new RuleError('NOT_ON', "You're not on this day.");
  d.queue.splice(at, 1);
  return { day: d, promoted: '', result: 'left' };
}

// Planner turns a date on (adds an open day) or off (removes it, returning what it held).
function setDay(days, date, on, today) {
  checkDate(date, today);
  var list = days.map(copyDay);
  var at = -1;
  for (var i = 0; i < list.length; i++) if (list[i].date === date) at = i;
  var removed = null;
  if (on && at < 0) list.push({ date: date, bdo: '', queue: [] });
  if (!on && at >= 0) removed = list.splice(at, 1)[0];
  list.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  return { days: list, removed: removed };
}

// crew rows: { callsign, telegramId, username }
function linkCallsign(crew, telegramId, username, callsign) {
  telegramId = String(telegramId);
  callsign = normCall(callsign);
  var rows = crew.map(function (c) {
    return { callsign: normCall(c.callsign), telegramId: String(c.telegramId || ''), username: c.username || '' };
  });
  if (rows.some(function (c) { return c.telegramId === telegramId; })) {
    throw new RuleError('ALREADY_LINKED', 'Your Telegram account is already linked to a callsign. Ask the BDO planner to change it.');
  }
  var row = rows.filter(function (c) { return c.callsign === callsign; })[0];
  if (!row) throw new RuleError('UNKNOWN', 'That callsign is not on the crew list. Ask the BDO planner to add it.');
  if (row.telegramId) throw new RuleError('TAKEN', 'That callsign is already linked to someone else. Ask the BDO planner to fix it.');
  row.telegramId = telegramId;
  row.username = username || '';
  return rows;
}

function addAdmin(admins, crew, callsign) {
  callsign = normCall(callsign);
  var list = admins.map(normCall);
  if (list.indexOf(callsign) >= 0) throw new RuleError('ALREADY_ADMIN', callsign + ' is already an admin.');
  var linked = crew.some(function (c) { return normCall(c.callsign) === callsign && String(c.telegramId || ''); });
  if (!linked) throw new RuleError('NOT_LINKED', callsign + " hasn't opened BDO Picker yet, so they can't be made an admin.");
  list.push(callsign);
  return list;
}

function removeSelf(admins, me) {
  me = normCall(me);
  var list = admins.map(normCall);
  if (list.indexOf(me) < 0) throw new RuleError('NOT_ADMIN', "You're not an admin.");
  if (list.length < 2) throw new RuleError('LAST_ADMIN', "You're the only admin. Add someone before you remove yourself.");
  return list.filter(function (a) { return a !== me; });
}

// Planner puts someone on a day. as = 'bdo': they become BDO and the current BDO moves to the
// front of the queue. as = 'queue': they join the end of the queue (or become BDO on an open day).
function assignDay(day, callsign, as, today) {
  checkDate(day.date, today);
  var cs = normCall(callsign);
  var d = copyDay(day);
  var at = d.queue.indexOf(cs);
  if (d.bdo === cs || (as !== 'bdo' && at >= 0)) throw new RuleError('ALREADY_THERE', cs + ' is already on this day.');
  if (as === 'bdo' || !d.bdo) {
    if (at >= 0) d.queue.splice(at, 1);
    var displaced = d.bdo;
    if (displaced) d.queue.unshift(displaced);
    d.bdo = cs;
    return { day: d, displaced: displaced, position: 0 };
  }
  d.queue.push(cs);
  return { day: d, displaced: '', position: d.queue.length };
}

// Planner takes someone off a day. Taking off the BDO moves the queue up, like a drop.
function removeFromDay(day, callsign, today) {
  checkDate(day.date, today);
  var cs = normCall(callsign);
  if (cs !== normCall(day.bdo) && (day.queue || []).map(normCall).indexOf(cs) < 0) {
    throw new RuleError('NOT_THERE', cs + " isn't on this day.");
  }
  var r = dropDay(day, cs, today);
  return { day: r.day, promoted: r.promoted };
}

var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Planner adds a callsign to the crew list. Commas are refused: the Queue column uses them.
function addCrew(crew, callsign) {
  var cs = normCall(callsign);
  if (!cs || cs.length > 20 || cs.indexOf(',') >= 0) {
    throw new RuleError('BAD_CALLSIGN', 'A callsign needs 1 to 20 characters and no commas.');
  }
  if (crew.some(function (c) { return normCall(c.callsign) === cs; })) {
    throw new RuleError('DUPLICATE', cs + ' is already on the crew list.');
  }
  return crew.map(function (c) { return { callsign: normCall(c.callsign), telegramId: String(c.telegramId || ''), username: c.username || '' }; })
    .concat([{ callsign: cs, telegramId: '', username: '' }]);
}

// Planner removes a callsign: out of the crew and admins, and off every day from today on
// (taking off a BDO moves their queue up). Past days keep their history.
function removeCrewMember(crew, admins, days, callsign, me, today) {
  var cs = normCall(callsign);
  if (cs === normCall(me)) throw new RuleError('SELF', "You can't remove your own callsign. Use Remove me under Admins to step down.");
  if (!crew.some(function (c) { return normCall(c.callsign) === cs; })) throw new RuleError('UNKNOWN', cs + ' is not on the crew list.');
  var promoted = [];
  var upcoming = 0;
  var newDays = days.map(function (day) {
    var d = copyDay(day);
    if (d.date < today || (d.bdo !== cs && d.queue.indexOf(cs) < 0)) return d;
    upcoming++;
    var r = dropDay(d, cs, today);
    if (r.promoted) promoted.push({ date: d.date, callsign: r.promoted });
    return r.day;
  });
  return {
    crew: crew.filter(function (c) { return normCall(c.callsign) !== cs; }),
    admins: admins.map(normCall).filter(function (a) { return a !== cs; }),
    days: newDays,
    promoted: promoted,
    upcoming: upcoming,
  };
}

// The group message for one month ('YYYY-MM'); `days` are that month's BDO days.
function announceText(month, days, note) {
  var p = String(month).split('-').map(Number);
  var title = MONTH_NAMES[p[1] - 1] + ' ' + p[0];
  if (!days.length) throw new RuleError('NO_DAYS', 'There are no BDO days in ' + title + ' yet.');
  var open = days.filter(function (d) { return !d.bdo; }).length;
  var lines = days.map(function (d) {
    var parts = fmtDay(d.date).split(' ');
    return '• ' + parts[0].slice(0, 3) + ' ' + parts[1] + ' ' + parts[2] + ': ' + (d.bdo || 'open');
  });
  var text = 'BDO dates for ' + title + ' are up.\n\n' +
    days.length + (days.length === 1 ? ' day needs' : ' days need') + ' a BDO, ' + open + ' still open:\n' +
    lines.join('\n') + '\n\nFirst come, first served. Pick yours in BDO Picker.';
  if (note && String(note).trim()) text += '\n\n' + String(note).trim();
  return text;
}
