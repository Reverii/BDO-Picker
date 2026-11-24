// One-off: turns the old Google Sheet's tabs (downloaded as CSV) into SQL for D1.
//
//   node scripts/import-sheet.mjs <folder with the CSV files>  > import.sql
//   npx wrangler d1 execute bdo-picker --remote --file=import.sql
//
// In the Sheet, for each tab: File > Download > Comma-separated values (.csv). Any file whose name
// ends in "Days.csv", "Crew.csv", "Admins.csv" or "Log.csv" is picked up. Missing tabs are skipped.
// It replaces what is in those tables, so run it once, before people start using the new app.

import fs from 'node:fs';
import path from 'node:path';

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const q = (s) => "'" + String(s == null ? '' : s).trim().replace(/'/g, "''") + "'";
const up = (s) => String(s == null ? '' : s).trim().toUpperCase();

const dir = process.argv[2];
if (!dir) { console.error('Usage: node scripts/import-sheet.mjs <folder with the CSV files>'); process.exit(1); }
const files = fs.readdirSync(dir);
const tab = (name) => {
  const f = files.find((x) => x.toLowerCase().endsWith(name.toLowerCase() + '.csv'));
  if (!f) { console.error('No ' + name + '.csv found, skipping ' + name + '.'); return null; }
  return parseCsv(fs.readFileSync(path.join(dir, f), 'utf8')).slice(1); // row 1 = headers
};

const out = [];
const days = tab('Days');
if (days) {
  out.push('DELETE FROM days;');
  days.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test((r[0] || '').trim())).forEach((r) => {
    const queue = String(r[2] || '').split(',').map(up).filter(Boolean).join(', ');
    out.push(`INSERT OR REPLACE INTO days (date, bdo, queue) VALUES (${q(r[0])}, ${q(up(r[1]))}, ${q(queue)});`);
  });
}
const crew = tab('Crew');
if (crew) {
  out.push('DELETE FROM crew;');
  crew.filter((r) => up(r[0])).forEach((r) => out.push(`INSERT OR IGNORE INTO crew (callsign, telegram_id, username) VALUES (${q(up(r[0]))}, ${q(r[1])}, ${q(r[2])});`));
}
const admins = tab('Admins');
if (admins) {
  out.push('DELETE FROM admins;');
  admins.filter((r) => up(r[0])).forEach((r) => out.push(`INSERT OR IGNORE INTO admins (callsign) VALUES (${q(up(r[0]))});`));
}
const log = tab('Log');
if (log) {
  out.push('DELETE FROM log;');
  log.filter((r) => (r[2] || '').trim()).forEach((r) => out.push(`INSERT INTO log (at, who, what) VALUES (${q(r[0])}, ${q(r[1])}, ${q(r[2])});`));
}
process.stdout.write(out.join('\n') + '\n');
console.error('Wrote ' + out.length + ' statements.');
