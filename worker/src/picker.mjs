// BDO Picker server: receives requests from the Mini App page, checks who sent them, applies the
// rules in rules.js and keeps everything in the D1 database (tables in migrations/0001_init.sql).
//
// One Picker lives in one Durable Object, so every request goes through the same Picker and
// changes run one at a time (withLock). Reads don't wait for the lock.

import R from './rules.js';
import { verifyInitData } from './auth.mjs';

const {
  RuleError, normCall, fmtDay, pickDay, dropDay, setDay, linkCallsign, addAdmin, removeSelf,
  assignDay, removeFromDay, addCrew, removeCrewMember, announceText, MONTH_NAMES,
} = R;

export const TZ = 'Asia/Singapore';
const LOCK_WAIT_MS = 10000;
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ADMIN_ACTIONS = ['setDay', 'admins', 'addAdmin', 'removeMe', 'assign', 'unassign', 'addCrew', 'removeCrew', 'findGroup', 'announce'];

function clock(date) {
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(date).forEach((x) => { p[x.type] = x.value; });
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

export class Picker {
  // db: a D1 database. env: { BOT_TOKEN, APP_NAME? }. fetch and now can be swapped in tests.
  constructor({ db, env, fetch: fetchFn, now, lockWaitMs }) {
    this.db = db;
    this.lockWaitMs = lockWaitMs || LOCK_WAIT_MS;
    this.env = env || {};
    this.fetch = fetchFn || ((url, opts) => fetch(url, opts));
    this.now = now || (() => new Date());
    this.tail = Promise.resolve();
  }

  // Takes the request body (JSON text) and returns the answer object.
  async post(text) {
    const job = new Job(this);
    let out;
    try {
      const req = JSON.parse(text || '{}');
      const token = this.env.BOT_TOKEN;
      if (!token) throw new Error('BOT_TOKEN is not set: run `npx wrangler secret put BOT_TOKEN`');
      const user = await verifyInitData(req.initData, token, Math.floor(this.now().getTime() / 1000));
      out = await job.handle(req, user);
      out.ok = true;
    } catch (err) {
      if (err instanceof RuleError) {
        out = { ok: false, error: err.message };
      } else {
        console.error(err && err.stack ? err.stack : err);
        out = { ok: false, error: 'Something went wrong. Try again in a moment.' };
      }
    }
    try { await job.flush(); } catch (e) { console.error(e); } // log lines written after the change
    return out;
  }

  // Runs fn once every earlier change has finished. Gives up after 10 seconds of waiting.
  async withLock(fn) {
    const before = this.tail;
    let release;
    const mine = new Promise((r) => { release = r; });
    this.tail = before.then(() => mine);
    let timer;
    const gotIt = await Promise.race([
      before.then(() => true),
      new Promise((r) => { timer = setTimeout(() => r(false), this.lockWaitMs); }),
    ]);
    clearTimeout(timer);
    if (!gotIt) {
      release();
      throw new RuleError('BUSY', 'BDO Picker is busy. Try again in a moment.');
    }
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

// One request.
class Job {
  constructor(app) {
    this.app = app;
    this.db = app.db;
    this.memo = {};    // tables already read in this request
    this.stored = {};  // what the database holds (as read or last written): writes compare with it
    this.raw = {};     // the keys exactly as stored, for rows typed in by hand
    this.writes = [];  // statements waiting for flush()
    this.newLog = [];  // log lines in this.writes
    this.outbox = [];  // Telegram messages waiting until the change is saved
  }

  // ---------- request handling ----------

  async handle(req, user) {
    const action = String(req.action || '');
    if (action === 'init') return this.initData(user);
    if (action === 'whoami') return this.whoami(user);
    if (action === 'link') {
      return this.write(async () => {
        const crew = linkCallsign(await this.readCrew(), user.id, user.username, req.callsign);
        this.writeCrew(crew);
        this.log(normCall(req.callsign), 'linked Telegram account' + (user.username ? ' @' + user.username : ''));
        return this.initData(user);
      });
    }

    const me = callsignOf(await this.readCrew(), user.id);
    if (!me) throw new RuleError('NOT_LINKED_ME', 'Pick your callsign first.');

    if (action === 'month') return { days: daysInMonth(await this.readDays(), req.month) };
    if (action === 'pick') return this.write(() => this.pick(me, req.date));
    if (action === 'drop') return this.write(() => this.drop(me, req.date));

    if (ADMIN_ACTIONS.indexOf(action) < 0) throw new RuleError('BAD_ACTION', 'Unknown request.');
    if ((await this.readAdmins()).indexOf(me) < 0) throw new RuleError('NOT_ADMIN', 'Only the BDO planner can do that.');

    if (action === 'admins') return this.adminsData();
    if (action === 'setDay') return this.write(() => this.changeDay(me, req.date, !!req.on));
    if (action === 'assign') return this.write(() => this.assign(me, req.date, req.callsign, req.as === 'bdo' ? 'bdo' : 'queue'));
    if (action === 'unassign') return this.write(() => this.unassign(me, req.date, req.callsign));
    if (action === 'addCrew') {
      return this.write(async () => {
        const crew = addCrew(await this.readCrew(), req.callsign);
        this.writeCrew(crew);
        this.log(me, 'added ' + normCall(req.callsign) + ' to the crew');
        return { crewList: await this.crewList(), message: normCall(req.callsign) + ' added to the crew.' };
      });
    }
    if (action === 'removeCrew') return this.write(() => this.removeCrew(me, req.callsign));
    if (action === 'findGroup') return this.findGroup();
    if (action === 'announce') return this.announce(me, String(req.month || ''), req.note, !!req.preview);
    if (action === 'addAdmin') {
      return this.write(async () => {
        const admins = addAdmin(await this.readAdmins(), await this.readCrew(), req.callsign);
        const added = normCall(req.callsign);
        this.writeAdmins(admins);
        this.log(me, 'added ' + added + ' as admin');
        await this.notify(added, "You're now a BDO planner. Open BDO Picker to set the BDO days.");
        return this.adminsData();
      });
    }
    return this.write(async () => {
      this.writeAdmins(removeSelf(await this.readAdmins(), me));
      this.log(me, 'removed themselves as admin');
      return this.adminsData();
    });
  }

  async whoami(user) {
    const crew = await this.readCrew();
    const me = callsignOf(crew, user.id);
    const data = { linked: !!me, callsign: me, isAdmin: !!me && (await this.readAdmins()).indexOf(me) >= 0 };
    if (!me) data.crew = crew.map((c) => ({ callsign: c.callsign, taken: !!c.telegramId }));
    return data;
  }

  // Everything the page needs when it opens: who you are, every BDO day from the start of this
  // month on, and (for admins) the admin list.
  async initData(user) {
    const data = await this.whoami(user);
    if (!data.linked) return data;
    data.days = this.upcoming(await this.readDays());
    if (data.isAdmin) {
      const a = await this.adminsData();
      data.admins = a.admins;
      data.linkedCallsigns = a.linked;
      data.lastChange = a.lastChange;
      data.crewCallsigns = (await this.readCrew()).map((c) => c.callsign);
      data.crewList = await this.crewList();
      data.groupTitle = await this.prop('GROUP_TITLE');
    }
    return data;
  }

  upcoming(days) {
    const start = this.today().slice(0, 7) + '-01';
    return days.filter((d) => d.date >= start);
  }

  async pick(me, date) {
    const days = await this.readDays();
    const i = findDay(days, date);
    const r = pickDay(days[i], me, this.today());
    days[i] = r.day;
    this.writeDays(days);
    const name = fmtDay(date);
    this.log(me, 'picked ' + name + (r.result === 'bdo' ? ' (BDO)' : ' (queue ' + r.position + ')'));
    const message = r.result === 'bdo'
      ? 'You are BDO on ' + name + '. Anyone who picks it after you joins the queue.'
      : r.day.bdo + ' got there first. You are number ' + r.position + ' in the queue for ' + name + '.';
    return { day: r.day, message };
  }

  async drop(me, date) {
    const days = await this.readDays();
    const i = findDay(days, date);
    const before = days[i];
    const r = dropDay(before, me, this.today());
    days[i] = r.day;
    this.writeDays(days);
    const name = fmtDay(date);
    if (r.result === 'dropped') {
      this.log(me, 'dropped ' + name + (r.promoted ? ', ' + r.promoted + ' moved up' : ''));
      if (r.promoted) {
        await this.notify(r.promoted, "You're now BDO on " + name + '. ' + me + ' dropped the day, so you moved up from first in the queue.');
        const rest = r.day.queue.length;
        return {
          day: r.day,
          finish: (told) => r.promoted + ' moved up to BDO.' + (told[r.promoted] ? ' They got a Telegram message.' : '') +
            (rest ? ' Everyone else in the queue moved up one place.' : ''),
        };
      }
      return { day: r.day, message: 'You dropped ' + name + '. It is open again.' };
    }
    this.log(me, 'left the queue for ' + name);
    const wasAt = before.queue.map(normCall).indexOf(me);
    return { day: r.day, message: 'You left the queue for ' + name + '.' + (wasAt < r.day.queue.length ? ' Everyone behind you moved up one place.' : '') };
  }

  // Planner puts a crew member on a day as BDO (current BDO moves to queue 1) or into the queue.
  async assign(me, date, callsign, as) {
    const cs = normCall(callsign);
    if (!(await this.readCrew()).some((c) => c.callsign === cs)) {
      throw new RuleError('UNKNOWN', cs + ' is not on the crew list. Add them under Crew first.');
    }
    const days = await this.readDays();
    const i = findDay(days, date);
    const r = assignDay(days[i], cs, as, this.today());
    days[i] = r.day;
    this.writeDays(days);
    const name = fmtDay(date);
    if (r.position === 0) {
      this.log(me, 'put ' + cs + ' on ' + name + ' as BDO');
      await this.notify(cs, 'The BDO planner has put you on ' + name + ' as BDO.');
      if (r.displaced) {
        await this.notify(r.displaced, 'The BDO planner has made ' + cs + ' BDO on ' + name + '. You are now number 1 in the queue.');
        return { day: r.day, message: cs + ' is now BDO on ' + name + '. ' + r.displaced + ' moved to number 1 in the queue.' };
      }
      return { day: r.day, message: cs + ' is now BDO on ' + name + '.' };
    }
    this.log(me, 'put ' + cs + ' in the queue for ' + name + ' (number ' + r.position + ')');
    await this.notify(cs, 'The BDO planner has put you in the queue for ' + name + '. You are number ' + r.position + '.');
    return { day: r.day, message: cs + ' is number ' + r.position + ' in the queue for ' + name + '.' };
  }

  // Planner takes someone off a day; taking off the BDO moves the queue up.
  async unassign(me, date, callsign) {
    const cs = normCall(callsign);
    const days = await this.readDays();
    const i = findDay(days, date);
    const r = removeFromDay(days[i], cs, this.today());
    days[i] = r.day;
    this.writeDays(days);
    const name = fmtDay(date);
    this.log(me, 'took ' + cs + ' off ' + name + (r.promoted ? ', ' + r.promoted + ' moved up' : ''));
    await this.notify(cs, 'The BDO planner has taken you off ' + name + '.');
    if (r.promoted) {
      await this.notify(r.promoted, "You're now BDO on " + name + '. ' + cs + ' was taken off the day, so you moved up from first in the queue.');
      return { day: r.day, message: cs + ' is off ' + name + '. ' + r.promoted + ' moved up to BDO.' };
    }
    return { day: r.day, message: cs + ' is off ' + name + '.' };
  }

  async crewList() {
    return (await this.readCrew()).map((c) => ({ callsign: c.callsign, linked: !!c.telegramId }));
  }

  async removeCrew(me, callsign) {
    const cs = normCall(callsign);
    const r = removeCrewMember(await this.readCrew(), await this.readAdmins(), await this.readDays(), cs, me, this.today());
    // Promoted people are still crew: look up their chats before the list changes.
    for (const p of r.promoted) {
      await this.notify(p.callsign, "You're now BDO on " + fmtDay(p.date) + '. ' + cs + ' was taken off the crew list, so you moved up from first in the queue.');
    }
    this.writeCrew(r.crew);
    this.writeAdmins(r.admins);
    this.writeDays(r.days);
    const plural = r.upcoming === 1 ? '' : 's';
    this.log(me, 'removed ' + cs + ' from the crew' + (r.upcoming ? ' (was on ' + r.upcoming + ' upcoming day' + plural + ')' : ''));
    return {
      crewList: await this.crewList(),
      admins: r.admins,
      days: this.upcoming(r.days),
      message: cs + ' removed from the crew' + (r.upcoming ? ' and taken off ' + r.upcoming + ' upcoming day' + plural + '.' : '.'),
    };
  }

  async changeDay(me, date, on) {
    const r = setDay(await this.readDays(), date, on, this.today());
    this.writeDays(r.days);
    const name = fmtDay(date);
    this.log(me, (on ? 'set ' : 'removed ') + name + ' as a BDO day');
    if (r.removed) {
      for (const cs of [r.removed.bdo].concat(r.removed.queue).filter(Boolean)) {
        await this.notify(cs, name + ' is no longer needed as a BDO day, so it has been taken off your days.');
      }
    }
    return { days: this.upcoming(r.days) };
  }

  async adminsData() {
    let last = this.newLog.filter((l) => / as admin$/.test(l.what)).pop();
    if (!last) last = await this.db.prepare("SELECT at, who, what FROM log WHERE what LIKE '% as admin' ORDER BY id DESC LIMIT 1").first();
    let lastChange = '';
    if (last) {
      const ymd = String(last.at).slice(0, 10).split('-');
      lastChange = last.who + ' ' + last.what + ' · ' + Number(ymd[2]) + ' ' + SHORT_MONTHS[Number(ymd[1]) - 1];
    }
    const linked = (await this.readCrew()).filter((c) => c.telegramId).map((c) => c.callsign);
    return { admins: await this.readAdmins(), linked, lastChange };
  }

  // ---------- the Telegram group ----------

  async telegram(method, payload) {
    const url = 'https://api.telegram.org/bot' + this.app.env.BOT_TOKEN + '/' + method;
    const opts = payload
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }
      : { method: 'GET' };
    try {
      const res = await this.app.fetch(url, opts);
      let body = {};
      try { body = await res.json(); } catch (e) { body = {}; }
      return { ok: res.status === 200 && body.ok !== false, result: body.result };
    } catch (e) {
      return { ok: false };
    }
  }

  // Looks through what the bot has recently seen for a group chat (someone sends /bdo there).
  async findGroup() {
    const r = await this.telegram('getUpdates');
    const updates = (r.ok && r.result) || [];
    for (let i = updates.length - 1; i >= 0; i--) {
      const u = updates[i];
      const msg = u.message || u.channel_post || u.my_chat_member || {};
      const chat = msg.chat;
      if (chat && (chat.type === 'group' || chat.type === 'supergroup')) {
        this.setProp('GROUP_CHAT_ID', String(chat.id));
        this.setProp('GROUP_TITLE', chat.title || 'the group');
        this.log('BDO Picker', 'connected to group ' + (chat.title || chat.id));
        return { groupTitle: chat.title || 'the group' };
      }
    }
    throw new RuleError('NO_GROUP', "I couldn't find the group. Add the bot to the group, send /bdo there, then tap Find group again.");
  }

  async appLink() {
    let name = await this.prop('BOT_USERNAME');
    if (!name) {
      const me = await this.telegram('getMe');
      name = (me.ok && me.result && me.result.username) || '';
      if (name) this.setProp('BOT_USERNAME', name);
    }
    return 'https://t.me/' + name + '/' + (this.app.env.APP_NAME || 'pick');
  }

  async announce(me, month, note, preview) {
    const groupId = await this.prop('GROUP_CHAT_ID');
    if (!groupId) throw new RuleError('NO_GROUP', 'Connect the group first: tap Find group.');
    const text = announceText(month, daysInMonth(await this.readDays(), month), note);
    if (preview) return { text };
    const sent = await this.telegram('sendMessage', {
      chat_id: groupId,
      text,
      reply_markup: { inline_keyboard: [[{ text: 'Open BDO Picker', url: await this.appLink() }]] },
    });
    if (!sent.ok) throw new RuleError('POST_FAILED', "Telegram didn't accept the message. Check the bot is still in the group, then tap Find group again.");
    const p = month.split('-').map(Number);
    this.log(me, 'posted ' + MONTH_NAMES[p[1] - 1] + ' ' + p[0] + ' to the group');
    return { message: 'Posted to ' + ((await this.prop('GROUP_TITLE')) || 'the group') + '.' };
  }

  // ---------- reading ----------

  async remember(name, read) {
    if (!(name in this.memo)) {
      this.memo[name] = await read();
      this.stored[name] = JSON.parse(JSON.stringify(this.memo[name]));
    }
    return this.memo[name];
  }

  async rows(sql) {
    return (await this.db.prepare(sql).all()).results || [];
  }

  readDays() {
    return this.remember('days', async () => {
      const raw = (this.raw.days = {});
      return (await this.rows('SELECT date, bdo, queue FROM days ORDER BY date'))
        .filter((r) => String(r.date == null ? '' : r.date).trim() !== '')
        .map((r) => {
          const date = String(r.date).trim();
          raw[date] = r.date;
          return { date, bdo: normCall(r.bdo), queue: String(r.queue || '').split(',').map(normCall).filter(Boolean) };
        });
    });
  }

  readCrew() {
    return this.remember('crew', async () => {
      const raw = (this.raw.crew = {});
      return (await this.rows('SELECT callsign, telegram_id, username FROM crew ORDER BY rowid'))
        .filter((r) => normCall(r.callsign))
        .map((r) => {
          raw[normCall(r.callsign)] = r.callsign;
          return { callsign: normCall(r.callsign), telegramId: String(r.telegram_id || '').trim(), username: String(r.username || '') };
        });
    });
  }

  readAdmins() {
    return this.remember('admins', async () => {
      const raw = (this.raw.admins = {});
      return (await this.rows('SELECT callsign FROM admins ORDER BY rowid'))
        .filter((r) => normCall(r.callsign))
        .map((r) => { raw[normCall(r.callsign)] = r.callsign; return normCall(r.callsign); });
    });
  }

  readSettings() {
    return this.remember('settings', async () => {
      const out = {};
      (await this.rows('SELECT key, value FROM settings')).forEach((r) => { out[r.key] = String(r.value); });
      return out;
    });
  }

  async prop(key) {
    return (await this.readSettings())[key] || '';
  }

  today() {
    return clock(this.app.now()).day;
  }

  // ---------- writing ----------
  // The write* functions compare the new list with what was read in this request and queue only
  // the rows that changed. flush() saves them all in one go (all or nothing).

  sql(query, ...args) {
    this.writes.push(this.db.prepare(query).bind(...args));
  }

  writeDays(days) {
    const before = new Map((this.stored.days || []).map((d) => [d.date, d]));
    const raw = this.raw.days || {};
    const kept = new Set();
    for (const d of days) {
      kept.add(d.date);
      const o = before.get(d.date);
      const queue = d.queue.join(', ');
      if (!o) {
        this.sql('INSERT INTO days (date, bdo, queue) VALUES (?, ?, ?) ON CONFLICT (date) DO UPDATE SET bdo = excluded.bdo, queue = excluded.queue', d.date, d.bdo, queue);
        raw[d.date] = d.date;
      } else if (o.bdo !== d.bdo || o.queue.join(', ') !== queue) {
        this.sql('UPDATE days SET bdo = ?, queue = ? WHERE date = ?', d.bdo, queue, raw[d.date]);
      }
    }
    for (const date of before.keys()) if (!kept.has(date)) this.sql('DELETE FROM days WHERE date = ?', raw[date]);
    this.memo.days = days;
    this.stored.days = JSON.parse(JSON.stringify(days));
  }

  writeCrew(crew) {
    const before = new Map((this.stored.crew || []).map((c) => [c.callsign, c]));
    const raw = this.raw.crew || {};
    const kept = new Set();
    for (const c of crew) {
      kept.add(c.callsign);
      const o = before.get(c.callsign);
      if (!o) {
        this.sql('INSERT INTO crew (callsign, telegram_id, username) VALUES (?, ?, ?)', c.callsign, c.telegramId, c.username);
        raw[c.callsign] = c.callsign;
      } else if (o.telegramId !== c.telegramId || o.username !== c.username) {
        this.sql('UPDATE crew SET telegram_id = ?, username = ? WHERE callsign = ?', c.telegramId, c.username, raw[c.callsign]);
      }
    }
    for (const cs of before.keys()) if (!kept.has(cs)) this.sql('DELETE FROM crew WHERE callsign = ?', raw[cs]);
    this.memo.crew = crew;
    this.stored.crew = JSON.parse(JSON.stringify(crew));
  }

  writeAdmins(admins) {
    const before = new Set(this.stored.admins || []);
    const raw = this.raw.admins || {};
    for (const a of admins) if (!before.has(a)) { this.sql('INSERT INTO admins (callsign) VALUES (?)', a); raw[a] = a; }
    for (const a of before) if (admins.indexOf(a) < 0) this.sql('DELETE FROM admins WHERE callsign = ?', raw[a]);
    this.memo.admins = admins;
    this.stored.admins = admins.slice();
  }

  setProp(key, value) {
    this.sql('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
    if (this.memo.settings) this.memo.settings[key] = value;
  }

  log(who, what) {
    const c = clock(this.app.now());
    const at = c.day + ' ' + c.time;
    this.newLog.push({ at, who, what });
    this.sql('INSERT INTO log (at, who, what) VALUES (?, ?, ?)', at, who, what);
  }

  async flush() {
    const list = this.writes.splice(0);
    this.newLog = [];
    if (list.length) await this.db.batch(list);
  }

  // A change: read fresh and save under the lock; Telegram messages go out once it is saved.
  async write(fn) {
    const data = await this.app.withLock(async () => {
      this.memo = {};
      this.stored = {};
      this.raw = {};
      try {
        const result = await fn();
        await this.flush();
        return result;
      } catch (e) {
        this.writes = [];
        this.newLog = [];
        this.outbox = [];
        throw e;
      }
    });
    const told = await this.sendQueued();
    if (data && data.finish) {
      data.message = data.finish(told);
      delete data.finish;
    }
    return data;
  }

  // Queues a Telegram message to a callsign; write() sends it once the change is saved.
  async notify(callsign, text) {
    const cs = normCall(callsign);
    const row = (await this.readCrew()).filter((c) => c.callsign === cs)[0];
    this.outbox.push({ callsign: cs, chatId: row ? row.telegramId : '', text });
  }

  // Sends the queued messages (all at once). Returns { CALLSIGN: true/false } (true = Telegram
  // accepted it). Delivery only works once that person has allowed the bot to message them.
  async sendQueued() {
    const list = this.outbox.splice(0);
    const results = await Promise.all(list.map((m) => (m.chatId
      ? this.telegram('sendMessage', { chat_id: m.chatId, text: m.text }).then((r) => r.ok)
      : Promise.resolve(false))));
    const told = {};
    list.forEach((m, i) => {
      if (!results[i]) this.log('BDO Picker', 'message to ' + m.callsign + ' not delivered');
      told[m.callsign] = results[i];
    });
    return told;
  }
}

function findDay(days, date) {
  for (let i = 0; i < days.length; i++) if (days[i].date === date) return i;
  throw new RuleError('NOT_SET', "The planner hasn't set that day as a BDO day.");
}

function daysInMonth(days, month) {
  return days.filter((d) => d.date.slice(0, 7) === String(month));
}

function callsignOf(crew, telegramId) {
  const row = crew.filter((c) => c.telegramId === String(telegramId))[0];
  return row ? row.callsign : '';
}
