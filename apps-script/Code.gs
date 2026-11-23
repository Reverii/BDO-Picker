// BDO Picker web app: receives requests from the Mini App page, checks who sent them,
// applies the rules in Rules.gs and keeps everything in this spreadsheet.
//
// Tabs (row 1 = headers): Days (Date | BDO | Queue), Crew (Callsign | Telegram ID | Telegram username),
// Admins (Callsign), Log (When | Who | What). Run setup() once to create them.
// Script Properties: BOT_TOKEN = the token @BotFather gave you.

var TZ = 'Asia/Singapore';
var HEADERS = {
  Days: ['Date', 'BDO', 'Queue'],
  Crew: ['Callsign', 'Telegram ID', 'Telegram username'],
  Admins: ['Callsign'],
  Log: ['When', 'Who', 'What'],
};

// ---------- entry points ----------

function doGet() {
  return ContentService.createTextOutput('BDO Picker is running.').setMimeType(ContentService.MimeType.TEXT);
}

function doPost(e) {
  var out;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var token = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
    if (!token) throw new Error('BOT_TOKEN is not set in Script Properties');
    var user = verifyInitData(req.initData, token, gasHmac, Math.floor(nowDate().getTime() / 1000));
    out = handle(req, user);
    out.ok = true;
  } catch (err) {
    if (err instanceof RuleError) {
      out = { ok: false, error: err.message };
    } else {
      console.error(err && err.stack ? err.stack : err);
      out = { ok: false, error: 'Something went wrong. Try again in a moment.' };
    }
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// Run once from the Apps Script editor: creates any missing tab with its headers.
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(HEADERS).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (sh) return;
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
    // Keep dates and Telegram IDs as plain text so Sheets doesn't turn them into dates or numbers.
    if (name === 'Days') sh.getRange('A:A').setNumberFormat('@');
    if (name === 'Crew') sh.getRange('B:B').setNumberFormat('@');
  });
}

// ---------- request handling ----------

function handle(req, user) {
  var action = String(req.action || '');
  if (action === 'whoami') return whoami(user);
  if (action === 'link') {
    return withLock(function () {
      var crew = linkCallsign(readCrew(), user.id, user.username, req.callsign);
      writeCrew(crew);
      log(normCall(req.callsign), 'linked Telegram account' + (user.username ? ' @' + user.username : ''));
      return whoami(user);
    });
  }

  var me = callsignOf(readCrew(), user.id);
  if (!me) throw new RuleError('NOT_LINKED_ME', 'Pick your callsign first.');

  if (action === 'month') return { days: daysInMonth(readDays(), req.month) };
  if (action === 'pick') return withLock(function () { return pick(me, req.date); });
  if (action === 'drop') return withLock(function () { return drop(me, req.date); });

  var adminActions = ['setDay', 'admins', 'addAdmin', 'removeMe'];
  if (adminActions.indexOf(action) < 0) throw new RuleError('BAD_ACTION', 'Unknown request.');
  if (readAdmins().indexOf(me) < 0) throw new RuleError('NOT_ADMIN', 'Only the BDO planner can do that.');

  if (action === 'admins') return adminsData();
  if (action === 'setDay') return withLock(function () { return changeDay(me, req.date, !!req.on); });
  if (action === 'addAdmin') {
    return withLock(function () {
      var admins = addAdmin(readAdmins(), readCrew(), req.callsign);
      var added = normCall(req.callsign);
      writeAdmins(admins);
      log(me, 'added ' + added + ' as admin');
      notify(added, "You're now a BDO planner. Open BDO Picker to set the BDO days.");
      return adminsData();
    });
  }
  return withLock(function () {
    writeAdmins(removeSelf(readAdmins(), me));
    log(me, 'removed themselves as admin');
    return adminsData();
  });
}

function whoami(user) {
  var crew = readCrew();
  var me = callsignOf(crew, user.id);
  var data = { linked: !!me, callsign: me, isAdmin: !!me && readAdmins().indexOf(me) >= 0 };
  if (!me) data.crew = crew.map(function (c) { return { callsign: c.callsign, taken: !!c.telegramId }; });
  return data;
}

function findDay(days, date) {
  for (var i = 0; i < days.length; i++) if (days[i].date === date) return i;
  throw new RuleError('NOT_SET', "The planner hasn't set that day as a BDO day.");
}

function pick(me, date) {
  var days = readDays();
  var i = findDay(days, date);
  var r = pickDay(days[i], me, today());
  days[i] = r.day;
  writeDays(days);
  var name = fmtDay(date);
  log(me, 'picked ' + name + (r.result === 'bdo' ? ' (BDO)' : ' (queue ' + r.position + ')'));
  var message = r.result === 'bdo'
    ? 'You are BDO on ' + name + '. Anyone who picks it after you joins the queue.'
    : r.day.bdo + ' got there first. You are number ' + r.position + ' in the queue for ' + name + '.';
  return { day: r.day, message: message };
}

function drop(me, date) {
  var days = readDays();
  var i = findDay(days, date);
  var before = days[i];
  var r = dropDay(before, me, today());
  days[i] = r.day;
  writeDays(days);
  var name = fmtDay(date);
  var message;
  if (r.result === 'dropped') {
    log(me, 'dropped ' + name + (r.promoted ? ', ' + r.promoted + ' moved up' : ''));
    if (r.promoted) {
      var told = notify(r.promoted, "You're now BDO on " + name + '. ' + me + ' dropped the day, so you moved up from first in the queue.');
      message = r.promoted + ' moved up to BDO.' + (told ? ' They got a Telegram message.' : '') +
        (r.day.queue.length ? ' Everyone else in the queue moved up one place.' : '');
    } else {
      message = 'You dropped ' + name + '. It is open again.';
    }
  } else {
    log(me, 'left the queue for ' + name);
    var wasAt = before.queue.map(normCall).indexOf(me);
    message = 'You left the queue for ' + name + '.' + (wasAt < r.day.queue.length ? ' Everyone behind you moved up one place.' : '');
  }
  return { day: r.day, message: message };
}

function changeDay(me, date, on) {
  var r = setDay(readDays(), date, on, today());
  writeDays(r.days);
  var name = fmtDay(date);
  log(me, (on ? 'set ' : 'removed ') + name + ' as a BDO day');
  if (r.removed) {
    [r.removed.bdo].concat(r.removed.queue).filter(Boolean).forEach(function (cs) {
      notify(cs, name + ' is no longer needed as a BDO day, so it has been taken off your days.');
    });
  }
  return { days: daysInMonth(r.days, String(date).slice(0, 7)) };
}

function adminsData() {
  var rows = sheet('Log').getDataRange().getValues().slice(1);
  var lastChange = '';
  for (var i = rows.length - 1; i >= 0; i--) {
    if (/ as admin$/.test(String(rows[i][2]))) {
      var ymd = String(rows[i][0]).slice(0, 10).split('-');
      var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      lastChange = rows[i][1] + ' ' + rows[i][2] + ' · ' + Number(ymd[2]) + ' ' + months[Number(ymd[1]) - 1];
      break;
    }
  }
  return { admins: readAdmins(), lastChange: lastChange };
}

// ---------- Sheet access ----------

function sheet(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('Missing tab "' + name + '". Run setup() once.');
  return sh;
}

function rowsOf(name) {
  return sheet(name).getDataRange().getValues().slice(1);
}

function rewrite(name, rows) {
  var sh = sheet(name);
  var width = HEADERS[name].length;
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, width).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, width).setValues(rows);
}

function cellDate(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  return String(v).trim();
}

function readDays() {
  return rowsOf('Days').filter(function (r) { return String(r[0]).trim() !== ''; }).map(function (r) {
    return {
      date: cellDate(r[0]),
      bdo: normCall(r[1]),
      queue: String(r[2] || '').split(',').map(normCall).filter(Boolean),
    };
  });
}

function writeDays(days) {
  rewrite('Days', days.map(function (d) { return [d.date, d.bdo, d.queue.join(', ')]; }));
}

function daysInMonth(days, month) {
  return days.filter(function (d) { return d.date.slice(0, 7) === String(month); });
}

function readCrew() {
  return rowsOf('Crew').filter(function (r) { return normCall(r[0]); }).map(function (r) {
    return { callsign: normCall(r[0]), telegramId: String(r[1] || '').trim(), username: String(r[2] || '') };
  });
}

function writeCrew(crew) {
  rewrite('Crew', crew.map(function (c) { return [c.callsign, c.telegramId, c.username]; }));
}

function callsignOf(crew, telegramId) {
  var row = crew.filter(function (c) { return c.telegramId === String(telegramId); })[0];
  return row ? row.callsign : '';
}

function readAdmins() {
  return rowsOf('Admins').map(function (r) { return normCall(r[0]); }).filter(Boolean);
}

function writeAdmins(admins) {
  rewrite('Admins', admins.map(function (a) { return [a]; }));
}

function log(who, what) {
  sheet('Log').appendRow([Utilities.formatDate(nowDate(), TZ, 'yyyy-MM-dd HH:mm'), who, what]);
}

// ---------- helpers ----------

function nowDate() {
  return new Date();
}

function today() {
  return Utilities.formatDate(nowDate(), TZ, 'yyyy-MM-dd');
}

function withLock(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// HMAC-SHA256 for Auth.gs. Apps Script works in Java bytes (-128..127); Auth.gs uses 0..255.
function gasHmac(key, msg) {
  var keyBytes = typeof key === 'string'
    ? Utilities.newBlob(key).getBytes()
    : key.map(function (b) { return b > 127 ? b - 256 : b; });
  var sig = Utilities.computeHmacSha256Signature(Utilities.newBlob(msg).getBytes(), keyBytes);
  return sig.map(function (b) { return (b + 256) % 256; });
}

// Sends a Telegram message to a callsign. Returns true if Telegram accepted it.
// It only works once that person has allowed the bot to message them (the page asks on first use).
function notify(callsign, text) {
  var row = readCrew().filter(function (c) { return c.callsign === normCall(callsign); })[0];
  var ok = false;
  if (row && row.telegramId) {
    try {
      var token = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
      var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ chat_id: row.telegramId, text: text }),
        muteHttpExceptions: true,
      });
      ok = res.getResponseCode() === 200;
    } catch (e) {
      ok = false;
    }
  }
  if (!ok) log('BDO Picker', 'message to ' + normCall(callsign) + ' not delivered');
  return ok;
}
