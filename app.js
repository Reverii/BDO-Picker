// BDO Picker Mini App page. Talks only to the Apps Script web app in config.js.
(function () {
  'use strict';

  var tg = window.Telegram && window.Telegram.WebApp;
  var app = document.getElementById('app');
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  var S = {
    screen: 'loading', fatal: '',
    me: '', isAdmin: false, crew: [], pickCs: '',
    tab: 'pick', month: '', days: [], sel: '',
    msg: '', msgKind: 'ok', busy: false, pending: '',
    admins: [], linked: [], lastChange: '', addCs: ''
  };

  // ---------- small helpers ----------

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function todayStr() {
    if (window.BDO_TODAY) return window.BDO_TODAY;
    var p = {};
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date()).forEach(function (x) { p[x.type] = x.value; });
    return p.year + '-' + p.month + '-' + p.day;
  }
  function parts(date) { return date.split('-').map(Number); }
  function weekday(date) { var p = parts(date); return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay(); }
  function longDay(date) { var p = parts(date); return WEEKDAYS[weekday(date)] + ' ' + p[2] + ' ' + MON[p[1] - 1]; }
  function shortDay(date) { var p = parts(date); return WEEKDAYS[weekday(date)].slice(0, 3) + ' ' + p[2] + ' ' + MON[p[1] - 1]; }
  function monthTitle(m) { var p = parts(m + '-01'); return MONTHS[p[1] - 1] + ' ' + p[0]; }
  function shiftMonth(m, n) {
    var p = parts(m + '-01');
    var d = new Date(Date.UTC(p[0], p[1] - 1 + n, 1));
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1);
  }
  function monthDays() { return S.days.filter(function (d) { return d.date.slice(0, 7) === S.month; }); }
  function defaultSel() {
    var t = todayStr();
    var next = monthDays().filter(function (d) { return d.date >= t; })[0];
    return next ? next.date : '';
  }
  function dayOf(date) { return S.days.filter(function (d) { return d.date === date; })[0] || null; }
  function onDay(day) { return !!day && (day.bdo === S.me || day.queue.indexOf(S.me) >= 0); }

  var ICON_PREV = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>';
  var ICON_NEXT = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';

  // ---------- talking to the server ----------

  function api(action, args) {
    args = args || {};
    var request;
    if (window.BDO_FAKE_API) {
      request = window.BDO_FAKE_API(action, args);
    } else {
      // No custom headers: keeps this a "simple" request that Apps Script accepts from another site.
      request = fetch(window.BDO_CONFIG.apiUrl, {
        method: 'POST',
        body: JSON.stringify(Object.assign({ initData: tg.initData, action: action }, args))
      }).then(function (r) { return r.json(); });
    }
    return request.then(function (res) {
      if (!res || !res.ok) throw new Error((res && res.error) || 'Something went wrong. Try again in a moment.');
      return res;
    }, function () {
      throw new Error("Can't reach BDO Picker. Check your connection and try again.");
    });
  }

  function ask(message) {
    return new Promise(function (resolve) {
      if (tg && tg.showConfirm) {
        try { tg.showConfirm(message, function (ok) { resolve(!!ok); }); return; } catch (e) { /* older Telegram */ }
      }
      resolve(window.confirm(message));
    });
  }

  function askWriteAccess() {
    return new Promise(function (resolve) {
      if (tg && tg.requestWriteAccess) {
        try { tg.requestWriteAccess(function () { resolve(); }); return; } catch (e) { /* older Telegram */ }
      }
      resolve();
    });
  }

  function say(kind, text) { S.msgKind = kind; S.msg = text; }

  // Runs one request at a time; the buttons are disabled while it is in flight.
  function busy(work) {
    if (S.busy) return Promise.resolve();
    S.busy = true;
    render();
    return work().catch(function (e) { say('err', e.message); }).then(function () { S.busy = false; render(); });
  }

  // ---------- loading ----------

  function start() {
    if (!tg || !tg.initData) { S.screen = 'outside'; return render(); }
    try { tg.ready(); tg.expand(); } catch (e) { /* not fatal */ }
    applyTheme();
    if (!window.BDO_FAKE_API && (!window.BDO_CONFIG || /PASTE_/.test(window.BDO_CONFIG.apiUrl))) {
      S.screen = 'fatal';
      S.fatal = "BDO Picker isn't set up yet: the web app address is missing from config.js.";
      return render();
    }
    S.month = todayStr().slice(0, 7);
    // One request gets everything: who you are, all BDO days from this month on, and the admin list.
    api('init').then(applyInit).catch(function (e) { S.screen = 'fatal'; S.fatal = e.message; render(); });
  }

  function applyInit(d) {
    S.me = d.callsign || '';
    S.isAdmin = !!d.isAdmin;
    if (!d.linked) {
      S.crew = d.crew || [];
      S.screen = 'welcome';
      return render();
    }
    S.screen = 'main';
    S.days = d.days || [];
    S.admins = d.admins || [];
    S.linked = d.linkedCallsigns || [];
    S.lastChange = d.lastChange || '';
    if (!dayOf(S.sel)) S.sel = defaultSel();
    render();
  }

  function applyTheme() {
    var t = (tg && tg.themeParams) || {};
    var root = document.documentElement;
    var map = { bg: t.secondary_bg_color, card: t.bg_color, text: t.text_color, hint: t.hint_color, accent: t.button_color, 'accent-text': t.button_text_color };
    Object.keys(map).forEach(function (k) { if (map[k]) root.style.setProperty('--' + k, map[k]); });
    root.classList.toggle('dark', tg && tg.colorScheme === 'dark');
  }

  // ---------- actions ----------

  var actions = {
    sel: function (el) { S.sel = el.getAttribute('data-date'); S.msg = ''; render(); },
    month: function (el) { S.month = shiftMonth(S.month, Number(el.getAttribute('data-v'))); S.sel = defaultSel(); S.msg = ''; render(); },
    tab: function (el) { S.tab = el.getAttribute('data-v'); S.msg = ''; render(); },
    action: function () {
      var day = dayOf(S.sel);
      if (!day) return;
      var what = onDay(day) ? 'drop' : 'pick';
      S.pending = day.date; // shows "Saving…" straight away
      busy(function () {
        return api(what, { date: day.date }).then(function (res) {
          S.days = S.days.map(function (d) { return d.date === res.day.date ? res.day : d; });
          say('ok', res.message);
        });
      }).then(function () { S.pending = ''; render(); });
    },
    toggle: function (el) {
      var date = el.getAttribute('data-date');
      var day = dayOf(date);
      var holders = day ? [day.bdo].concat(day.queue).filter(Boolean) : [];
      var go = holders.length ? ask('Remove ' + shortDay(date) + '? ' + holders.join(', ') + ' will be told.') : Promise.resolve(true);
      go.then(function (ok) {
        if (!ok) return;
        busy(function () {
          return api('setDay', { date: date, on: !day }).then(function (res) {
            S.days = res.days;
            say('ok', day ? shortDay(date) + ' removed.' : shortDay(date) + ' added as a BDO day. It shows as open to everyone.');
          });
        });
      });
    },
    link: function () {
      if (!S.pickCs) return;
      busy(function () {
        return askWriteAccess().then(function () { return api('link', { callsign: S.pickCs }); }).then(function (who) {
          S.msg = '';
          return applyInit(who);
        });
      });
    },
    addAdmin: function () {
      if (!S.addCs) return;
      var cs = S.addCs;
      busy(function () {
        return api('addAdmin', { callsign: cs }).then(function (res) {
          S.admins = res.admins; S.lastChange = res.lastChange; S.addCs = '';
          say('ok', cs + ' is now an admin.');
        });
      });
    },
    removeMe: function () {
      ask("Remove yourself as admin? You won't see the Planner tab any more.").then(function (ok) {
        if (!ok) return;
        busy(function () {
          return api('removeMe').then(function (res) {
            S.admins = res.admins; S.lastChange = res.lastChange;
            S.isAdmin = res.admins.indexOf(S.me) >= 0;
            if (!S.isAdmin) S.tab = 'pick';
            say('ok', 'You are no longer an admin.');
          });
        });
      });
    }
  };

  app.addEventListener('click', function (ev) {
    var el = ev.target.closest('[data-act]');
    if (!el || el.disabled || !actions[el.getAttribute('data-act')]) return;
    actions[el.getAttribute('data-act')](el);
  });
  app.addEventListener('change', function (ev) {
    if (ev.target.name === 'callsign') { S.pickCs = ev.target.value; render(); }
    if (ev.target.id === 'add-admin') { S.addCs = ev.target.value; render(); }
  });

  // ---------- drawing ----------

  function render() {
    var html;
    if (S.screen === 'outside') html = '<p class="center">Open BDO Picker from the Telegram link.</p>';
    else if (S.screen === 'fatal') html = '<p class="center">' + esc(S.fatal) + '</p>';
    else if (S.screen === 'welcome') html = welcome();
    else if (S.screen === 'main') html = main();
    else html = '<p class="center hint">Loading…</p>';
    var scroll = window.scrollY;
    app.innerHTML = html;
    window.scrollTo(0, scroll);
  }

  function status() {
    if (!S.msg) return '';
    return '<div id="status" role="status" class="status ' + S.msgKind + '">' + esc(S.msg) + '</div>';
  }

  function welcome() {
    var rows = S.crew.map(function (c) {
      return '<label class="pickrow' + (c.taken ? ' taken' : '') + '">' +
        '<input type="radio" name="callsign" value="' + esc(c.callsign) + '"' + (c.taken ? ' disabled' : '') + (S.pickCs === c.callsign ? ' checked' : '') + '>' +
        '<span class="cs">' + esc(c.callsign) + '</span>' +
        (c.taken ? '<span class="hint">already linked</span>' : '') + '</label>';
    }).join('');
    var user = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
    return '<div class="content welcome">' +
      '<div><h1>First time here</h1><p>Pick your callsign once. From then on, opening BDO Picker from Telegram knows it\'s you.</p></div>' +
      (user && user.username ? '<div class="card">Your Telegram account: <b>@' + esc(user.username) + '</b></div>' : '') +
      '<fieldset><legend class="label">Which callsign is yours?</legend>' + (rows || '<p class="hint">The crew list is empty. Ask the BDO planner to add callsigns.</p>') + '</fieldset>' +
      '<p class="hint">Callsign missing or already linked to someone else? Message the BDO planner to fix it.</p>' +
      status() + '</div>' +
      '<div class="footer"><button type="button" class="main" data-act="link"' + (!S.pickCs || S.busy ? ' disabled' : '') + '>' +
      (S.pickCs ? "I'm " + esc(S.pickCs) : 'Pick your callsign') + '</button></div>';
  }

  function header() {
    var tabs = S.isAdmin
      ? '<div class="tabs" role="tablist">' +
        '<button type="button" role="tab" id="tab-pick" data-act="tab" data-v="pick" aria-selected="' + (S.tab === 'pick') + '">Pick days</button>' +
        '<button type="button" role="tab" id="tab-planner" data-act="tab" data-v="planner" aria-selected="' + (S.tab === 'planner') + '">Planner</button></div>'
      : '';
    var sub = S.tab === 'planner' ? 'Tap a day to turn BDO on or off' : 'Signed in as ' + esc(S.me);
    return tabs + '<div class="monthbar"><div><div class="sub">' + sub + '</div><h1>' + monthTitle(S.month) + '</h1></div>' +
      '<div class="nav"><button type="button" class="round" data-act="month" data-v="-1" aria-label="Previous month">' + ICON_PREV + '</button>' +
      '<button type="button" class="round" data-act="month" data-v="1" aria-label="Next month">' + ICON_NEXT + '</button></div></div>';
  }

  function calendar(cell) {
    var p = parts(S.month + '-01');
    var count = new Date(Date.UTC(p[0], p[1], 0)).getUTCDate();
    var lead = (weekday(S.month + '-01') + 6) % 7; // Monday first
    var html = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(function (w) { return '<div class="wd" aria-hidden="true">' + w + '</div>'; }).join('');
    for (var i = 0; i < lead; i++) html += '<div></div>';
    for (var d = 1; d <= count; d++) html += cell(S.month + '-' + pad(d), d);
    return '<div id="cal" class="cal">' + html + '</div>';
  }

  function main() {
    var body = S.tab === 'planner' && S.isAdmin ? planner() : picker();
    return '<div class="content">' + header() + body + '</div>' + (S.tab === 'planner' && S.isAdmin ? '' : footer());
  }

  function picker() {
    var t = todayStr();
    var cal = calendar(function (date, n) {
      var day = dayOf(date);
      var cls = 'day', tag = '', label = longDay(date), disabled = false;
      if (!day) { cls += ' unset'; disabled = true; label += ', not set by the planner'; }
      else {
        var at = day.queue.indexOf(S.me);
        if (day.bdo === S.me) { cls += ' mine'; tag = 'BDO'; label += ', you are BDO'; }
        else if (at >= 0) { cls += ' mine'; tag = 'QUEUE ' + (at + 1); label += ', you are number ' + (at + 1) + ' in the queue'; }
        else if (!day.bdo) { cls += ' open'; tag = 'OPEN'; label += ', open'; }
        else { cls += ' taken'; tag = day.bdo; label += ', BDO ' + day.bdo + ', ' + day.queue.length + ' in queue'; }
        if (date < t) cls += ' past';
        if (date === S.sel) cls += ' sel';
        if (date === S.pending) tag = 'SAVING…';
      }
      return '<button type="button" class="' + cls + '" data-act="sel" data-date="' + date + '" aria-label="' + esc(label) + '"' +
        (date === S.sel ? ' aria-pressed="true"' : '') + (disabled ? ' disabled' : '') + '><span class="n">' + n + '</span><span class="t">' + esc(tag) + '</span></button>';
    });
    var legend = '<div class="legend"><span><i class="sw" style="background:var(--card);box-shadow:inset 0 0 0 1.5px var(--accent)"></i>Open</span>' +
      '<span><i class="sw" style="background:var(--taken-bg)"></i>Taken, join the queue</span>' +
      '<span><i class="sw" style="background:var(--accent)"></i>Mine</span>' +
      '<span>Plain number: not a BDO day</span></div>';
    return legend + cal + panel() + status() + myDays();
  }

  function panel() {
    var day = dayOf(S.sel);
    if (!day) {
      var none = monthDays().length ? 'Tap a highlighted day to see who has it.' : 'The planner hasn\'t set any BDO days this month yet.';
      return '<section id="panel" class="card"><span class="hint">' + none + '</span></section>';
    }
    var queue = day.queue.length
      ? day.queue.map(function (cs, i) {
        return '<div class="qi' + (cs === S.me ? ' me' : '') + '"><span class="qn">' + (i + 1) + '</span><b>' + esc(cs) + (cs === S.me ? ' (you)' : '') + '</b></div>';
      }).join('')
      : '<span class="hint">Nobody in the queue yet</span>';
    return '<section id="panel" class="card" style="display:flex;flex-direction:column;gap:10px">' +
      '<h2 style="font-size:17px">' + longDay(day.date) + '</h2>' +
      '<div class="row"><span class="hint">BDO</span><b>' + esc(day.bdo || 'Open') + '</b></div>' +
      '<div class="queue"><span class="hint">Queue</span>' + queue + '</div>' +
      '<span style="font-size:13px">' + esc(hintFor(day)) + '</span></section>';
  }

  function hintFor(day) {
    var at = day.queue.indexOf(S.me);
    if (day.date < todayStr()) return 'This day has passed.';
    if (day.bdo === S.me) return day.queue.length ? 'If you drop it, ' + day.queue[0] + ' moves up to BDO and gets a Telegram message.' : 'If you drop it, the day opens up again.';
    if (at >= 0) return 'You are number ' + (at + 1) + ' in the queue. You move up when someone ahead of you drops out.';
    if (day.bdo) return day.bdo + ' picked this day first. Join the queue and you would be number ' + (day.queue.length + 1) + '.';
    return 'Nobody has picked this day yet. Tap below and you are BDO.';
  }

  function myDays() {
    var t = todayStr();
    var mine = S.days.filter(function (d) { return d.date >= t && onDay(d); }).map(function (d) {
      var at = d.queue.indexOf(S.me);
      return '<span class="chip">' + shortDay(d.date) + ' · ' + (d.bdo === S.me ? 'BDO' : 'queue ' + (at + 1)) + '</span>';
    });
    return '<div style="display:flex;flex-direction:column;gap:6px"><span class="label">My days</span>' +
      '<div id="mine" class="chips">' + (mine.join('') || '<span class="hint">No days yet</span>') + '</div></div>';
  }

  function footer() {
    var day = dayOf(S.sel);
    var label = 'Pick a day', cls = 'main', disabled = !day || S.busy;
    if (S.pending) { label = 'Saving…'; disabled = true; }
    else if (day) {
      if (day.date < todayStr()) { label = 'This day has passed'; disabled = true; }
      else if (day.bdo === S.me) { label = 'Drop this day'; cls += ' danger'; }
      else if (day.queue.indexOf(S.me) >= 0) { label = 'Leave the queue'; cls += ' danger'; }
      else if (day.bdo) label = 'Join the queue';
      else label = 'Take this day';
    }
    return '<div class="footer"><button type="button" id="action" class="' + cls + '" data-act="action"' + (disabled ? ' disabled' : '') + '>' + label + '</button></div>';
  }

  function planner() {
    var t = todayStr();
    var days = monthDays();
    var filled = days.filter(function (d) { return d.bdo; }).length;
    var counts = '<div class="counts"><div><b>' + days.length + '</b><span>BDO days</span></div>' +
      '<div><b>' + filled + '</b><span>have a BDO</span></div>' +
      '<div><b class="warn">' + (days.length - filled) + '</b><span>still open</span></div></div>';
    var cal = calendar(function (date, n) {
      var day = dayOf(date);
      var past = date < t;
      var tag = !day ? '' : !day.bdo ? 'OPEN' : day.queue.length ? 'BDO +' + day.queue.length : 'BDO';
      var label = longDay(date) + (day ? ', BDO day, ' + (day.bdo ? 'BDO ' + day.bdo + ', ' + day.queue.length + ' in queue' : 'open') : ', not a BDO day');
      return '<button type="button" class="day ' + (day ? 'set' : 'planner-unset') + (past ? ' past' : '') + '" data-act="toggle" data-date="' + date + '"' +
        ' aria-pressed="' + !!day + '" aria-label="' + esc(label) + '"' + (past || S.busy ? ' disabled' : '') + '>' +
        '<span class="n">' + n + '</span><span class="t">' + tag + '</span></button>';
    });
    var who = days.map(function (d) {
      var w = !d.bdo ? 'Open' : d.bdo + (d.queue.length ? ' · queue: ' + d.queue.join(', ') : ' · queue empty');
      return '<div><span class="d">' + shortDay(d.date) + '</span><span class="w' + (d.bdo ? '' : ' open') + '">' + esc(w) + '</span></div>';
    }).join('');
    return counts + cal + status() +
      '<section class="card list"><span class="label">Who has what</span>' + (who || '<div class="hint">No BDO days this month yet.</div>') + '</section>' +
      admins();
  }

  function admins() {
    var last = S.admins.length < 2;
    var rows = S.admins.map(function (a) {
      var mine = a === S.me;
      return '<div class="admin"><span class="avatar" aria-hidden="true">' + esc(a.charAt(0)) + '</span><span class="name">' + esc(a) + (mine ? ' (you)' : '') + '</span>' +
        (mine ? '<button type="button" class="pill" data-act="removeMe"' + (last || S.busy ? ' disabled' : '') + '>Remove me</button>' : '') + '</div>';
    }).join('');
    var options = S.linked.filter(function (c) { return S.admins.indexOf(c) < 0; }).map(function (c) {
      return '<option value="' + esc(c) + '"' + (S.addCs === c ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
    return '<section class="card"><span class="label">Admins</span><div id="admins">' + rows + '</div>' +
      (last ? '<p class="hint" style="font-size:13px;margin:6px 0 0">You\'re the only admin. Add someone before you can remove yourself.</p>' : '') +
      '<div class="addrow"><label for="add-admin" class="sr">Callsign to make admin</label>' +
      '<select id="add-admin"><option value="">Pick a callsign…</option>' + options + '</select>' +
      '<button type="button" class="btn" data-act="addAdmin"' + (!S.addCs || S.busy ? ' disabled' : '') + '>Add admin</button></div>' +
      (S.lastChange ? '<p class="hint" style="font-size:12px;margin:10px 0 0">Last change: ' + esc(S.lastChange) + '</p>' : '') +
      '</section>';
  }

  start();
})();
