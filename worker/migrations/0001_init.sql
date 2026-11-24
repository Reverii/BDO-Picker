-- BDO Picker tables. Same columns as the old Google Sheet tabs.
-- Rows keep the order they were added in (crew and admins are listed by rowid).

-- One row per BDO date. queue = callsigns separated by commas, in order.
CREATE TABLE IF NOT EXISTS days (
  date  TEXT PRIMARY KEY,           -- YYYY-MM-DD
  bdo   TEXT NOT NULL DEFAULT '',
  queue TEXT NOT NULL DEFAULT ''
);

-- Everyone who can pick. telegram_id and username fill in when they link their account.
CREATE TABLE IF NOT EXISTS crew (
  callsign    TEXT PRIMARY KEY,
  telegram_id TEXT NOT NULL DEFAULT '',
  username    TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS admins (
  callsign TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS log (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  at   TEXT NOT NULL,                -- YYYY-MM-DD HH:MM, Singapore time
  who  TEXT NOT NULL,
  what TEXT NOT NULL
);

-- GROUP_CHAT_ID, GROUP_TITLE, BOT_USERNAME (filled in by the app).
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
