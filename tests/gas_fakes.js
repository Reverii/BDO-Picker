// In-memory stand-ins for the Apps Script services Code.gs uses. Only what Code.gs needs.
const crypto = require('crypto');

function toSigned(buf) { return [...buf].map((b) => (b > 127 ? b - 256 : b)); }
function checkJavaBytes(arr) {
  if (!Array.isArray(arr)) throw new Error('expected a byte array');
  arr.forEach((b) => { if (!Number.isInteger(b) || b < -128 || b > 127) throw new Error('byte out of Java range: ' + b); });
  return Buffer.from(arr.map((b) => (b + 256) % 256));
}

function makeSheet(name, rows) {
  const data = rows.map((r) => r.slice());
  const width = () => Math.max(1, ...data.map((r) => r.length));
  const trim = () => { while (data.length && data[data.length - 1].every((v) => v === '' || v == null)) data.pop(); };
  const cell = (r, c) => (data[r] && data[r][c] !== undefined ? data[r][c] : '');
  function range(r, c, nr, nc) {
    return {
      getValues() { const out = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push(cell(r - 1 + i, c - 1 + j)); out.push(row); } return out; },
      setValues(vals) {
        if (vals.length !== nr || vals.some((v) => v.length !== nc)) throw new Error('setValues size mismatch');
        for (let i = 0; i < nr; i++) { data[r - 1 + i] = data[r - 1 + i] || []; for (let j = 0; j < nc; j++) data[r - 1 + i][c - 1 + j] = vals[i][j]; }
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
    getName() { return name; },
    getDataRange() { trim(); return range(1, 1, Math.max(1, data.length), width()); },
    getLastRow() { trim(); return data.length; },
    getRange(a, c, nr, nc) { if (typeof a === 'string') return range(1, 1, 1, 1); return range(a, c, nr || 1, nc || 1); },
    appendRow(row) { trim(); data.push(Array.from(row)); return this; },
    setFrozenRows() { return this; },
  };
}

function makeGas({ botToken = '123456:TEST-token', now = new Date('2026-12-01T02:00:00Z'), tabs = {}, telegramStatus = 200 } = {}) {
  const sheets = {};
  Object.keys(tabs).forEach((n) => { sheets[n] = makeSheet(n, tabs[n]); });
  const state = { sent: [], lockCalls: 0, released: 0, telegramStatus, fetchUrls: [] };
  const ss = {
    getSheetByName(n) { return sheets[n] || null; },
    insertSheet(n) { sheets[n] = makeSheet(n, []); return sheets[n]; },
  };
  const fmtParts = (d, tz) => {
    const p = {};
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d).forEach((x) => { p[x.type] = x.value; });
    return p;
  };
  const globals = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, getActive: () => ss },
    LockService: { getScriptLock: () => ({ waitLock() { state.lockCalls++; }, releaseLock() { state.released++; } }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === 'BOT_TOKEN' ? botToken : null) }) },
    ContentService: {
      MimeType: { JSON: 'JSON', TEXT: 'TEXT' },
      createTextOutput(text) { return { text, mime: null, setMimeType(m) { this.mime = m; return this; }, getContent() { return text; } }; },
    },
    UrlFetchApp: {
      fetch(url, opts) {
        state.fetchUrls.push(url);
        const body = JSON.parse(opts.payload);
        if (state.telegramStatus === 200) state.sent.push({ chat_id: String(body.chat_id), text: body.text });
        return { getResponseCode: () => state.telegramStatus, getContentText: () => '{}' };
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
  return { globals, state, now, sheet: (n) => (sheets[n] ? sheets[n].data : null) };
}

module.exports = { makeGas };
