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
