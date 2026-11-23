// In-memory stand-ins for the Apps Script services Code.gs uses. Only what Code.gs needs.
const crypto = require('crypto');

function toSigned(buf) { return [...buf].map((b) => (b > 127 ? b - 256 : b)); }
function checkJavaBytes(arr) {
  if (!Array.isArray(arr)) throw new Error('expected a byte array');
  arr.forEach((b) => { if (!Number.isInteger(b) || b < -128 || b > 127) throw new Error('byte out of Java range: ' + b); });
  return Buffer.from(arr.map((b) => (b + 256) % 256));
}

// Like real Sheets, a written string in a column that isn't plain text ('@') is turned into a date,
// a number or a boolean when it looks like one. Values seeded with `rows` are kept as given.
function coerce(v, isText) {
  if (isText || typeof v !== 'string') return v;
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?: (\d{1,2}):(\d{2}))?$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], (+m[4] || 0) - 8, +m[5] || 0)); // Singapore time
  if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v.trim())) return Number(v);
  if (/^(true|false)$/i.test(v.trim())) return v.trim().toLowerCase() === 'true';
  return v;
}

function makeSheet(name, rows, events) {
  const data = rows.map((r) => r.slice());
  const textCols = new Set();
  const width = () => Math.max(1, ...data.map((r) => r.length));
  const trim = () => { while (data.length && data[data.length - 1].every((v) => v === '' || v == null)) data.pop(); };
  const cell = (r, c) => (data[r] && data[r][c] !== undefined ? data[r][c] : '');
  const put = (r, c, v) => { data[r] = data[r] || []; data[r][c] = coerce(v, textCols.has(c)); };
  function range(r, c, nr, nc) {
    return {
      getValues() { const out = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push(cell(r - 1 + i, c - 1 + j)); out.push(row); } return out; },
      setValues(vals) {
        if (vals.length !== nr || vals.some((v) => v.length !== nc)) throw new Error('setValues size mismatch');
        events.push('write');
        for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) put(r - 1 + i, c - 1 + j, vals[i][j]);
        return this;
      },
      clearContent() { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (data[r - 1 + i]) data[r - 1 + i][c - 1 + j] = ''; trim(); return this; },
      setNumberFormat() { return this; },
      setFontWeight() { return this; },
    };
  }
  return {
    name,
    data,
    textCols,
    getName() { return name; },
    getDataRange() { trim(); events.push('read:' + name); return range(1, 1, Math.max(1, data.length), width()); },
    getLastRow() { trim(); return data.length; },
    getRange(a, c, nr, nc) {
      if (typeof a === 'string') {
        const m = a.match(/^([A-Z]):\1$/);
        if (!m) throw new Error('fake getRange: only whole columns like "A:A" are supported');
        const col = m[1].charCodeAt(0) - 65;
        return { setNumberFormat(f) { if (f === '@') textCols.add(col); else textCols.delete(col); return this; } };
      }
      return range(a, c, nr || 1, nc || 1);
    },
    appendRow(row) { trim(); events.push('write'); const r = data.length; Array.from(row).forEach((v, c) => put(r, c, v)); return this; },
    setFrozenRows() { return this; },
  };
}

function makeGas({ botToken = '123456:TEST-token', now = new Date('2026-12-01T02:00:00Z'), tabs = {}, telegramStatus = 200, lockBusy = false, updates = [], botUsername = 'bdo_test_bot' } = {}) {
  const sheets = {};
  const state = { sent: [], lockCalls: 0, released: 0, telegramStatus, fetchUrls: [], events: [], updates, props: { BOT_TOKEN: botToken } };
  Object.keys(tabs).forEach((n) => { sheets[n] = makeSheet(n, tabs[n], state.events); });
  const ss = {
    getSheetByName(n) { return sheets[n] || null; },
    insertSheet(n) { sheets[n] = makeSheet(n, [], state.events); return sheets[n]; },
  };
  const fmtParts = (d, tz) => {
    const p = {};
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d).forEach((x) => { p[x.type] = x.value; });
    return p;
  };
  const globals = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, getActive: () => ss, flush() { state.events.push('flush'); } },
    LockService: { getScriptLock: () => ({ waitLock() { state.lockCalls++; if (lockBusy) throw new Error('Lock timeout: another process was holding the lock for too long.'); state.events.push('lock'); }, releaseLock() { state.released++; state.events.push('release'); } }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in state.props ? state.props[k] : null), setProperty(k, v) { state.props[k] = String(v); return this; } }) },
    ContentService: {
      MimeType: { JSON: 'JSON', TEXT: 'TEXT' },
      createTextOutput(text) { return { text, mime: null, setMimeType(m) { this.mime = m; return this; }, getContent() { return text; } }; },
    },
    UrlFetchApp: {
      fetch(url, opts) {
        state.fetchUrls.push(url);
        const reply = (code, obj) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(obj) });
        if (/\/getUpdates/.test(url)) return reply(200, { ok: true, result: state.updates });
        if (/\/getMe/.test(url)) return reply(200, { ok: true, result: { username: botUsername } });
        state.events.push('send');
        const body = JSON.parse(opts.payload);
        if (state.telegramStatus === 200) {
          const m = { chat_id: String(body.chat_id), text: body.text };
          if (body.reply_markup) m.reply_markup = body.reply_markup;
          state.sent.push(m);
        }
        return reply(state.telegramStatus, { ok: state.telegramStatus === 200 });
      },
    },
    Utilities: {
      newBlob: (s) => ({ getBytes: () => toSigned(Buffer.from(String(s), 'utf8')) }),
      computeHmacSha256Signature(value, key) {
        return toSigned(crypto.createHmac('sha256', checkJavaBytes(key)).update(checkJavaBytes(value)).digest());
      },
      formatDate(d, tz, pattern) {
        const p = fmtParts(d, tz);
        if (pattern === 'yyyy-MM-dd') return `${p.year}-${p.month}-${p.day}`;
        if (pattern === 'yyyy-MM-dd HH:mm') return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
        throw new Error('fake formatDate: unsupported pattern ' + pattern);
      },
    },
  };
  return { globals, state, now, sheet: (n) => (sheets[n] ? sheets[n].data : null), sheetObj: (n) => sheets[n] };
}

module.exports = { makeGas };
