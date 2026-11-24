// A stand-in for Cloudflare D1 on Node's built-in SQLite, with the real schema. Only what the
// Worker uses: prepare().bind().all()/first()/run() and batch() (all or nothing, like D1).
// `delay` makes every call wait a little so overlapping requests really overlap.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'worker', 'migrations', '0001_init.sql'), 'utf8');

function makeD1({ delay = 0 } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const stats = { queries: 0, batches: 0, reads: [] };
  const wait = () => new Promise((r) => (delay ? setTimeout(r, delay) : setImmediate(r)));
  const plain = (rows) => rows.map((r) => ({ ...r }));
  function stmt(sql, args) {
    return {
      bind: (...a) => stmt(sql, a),
      async all() { await wait(); stats.queries++; stats.reads.push(sql); return { results: plain(db.prepare(sql).all(...args)) }; },
      async first() { await wait(); stats.queries++; stats.reads.push(sql); const r = db.prepare(sql).get(...args); return r ? { ...r } : null; },
      async run() { await wait(); stats.queries++; db.prepare(sql).run(...args); return { success: true }; },
      runNow() { db.prepare(sql).run(...args); },
    };
  }
  return {
    prepare: (sql) => stmt(sql, []),
    async batch(list) {
      await wait();
      if (this.onBatch) this.onBatch();
      stats.batches++;
      stats.queries += list.length;
      db.exec('BEGIN');
      try { list.forEach((s) => s.runNow()); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
      return list.map(() => ({ success: true }));
    },
    sql: db,   // for tests: run SQL directly
    stats,
  };
}

module.exports = { makeD1 };
