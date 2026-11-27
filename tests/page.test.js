const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.gs': 'text/javascript' };
let server, base, browser;

test.before(async () => {
  server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port + '/';
  browser = await chromium.launch();
});
test.after(async () => { await browser.close(); server.close(); });

async function open({ initData = 'test', linked = true, admin = true, delay = 0, width = 390, refreshMs = 0 } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '', contentType: 'text/javascript' }));
  await page.addInitScript(({ initData, linked, admin, delay, refreshMs }) => {
    window.BDO_TODAY = '2026-12-01';
    window.FAKE_OPTS = { linked, admin, delay };
    window.Telegram = { WebApp: { initData, themeParams: {}, ready() {}, expand() {}, requestWriteAccess(cb) { cb(true); }, showConfirm(msg, cb) { window.LAST_CONFIRM = msg; cb(true); }, openLink(url) { window.OPENED = url; } } };
    if (refreshMs) window.BDO_REFRESH_MS = refreshMs;
  }, { initData, linked, admin, delay, refreshMs });
  // rules.js and the fake API load before app.js runs (app.js waits for DOMContentLoaded).
  await page.addInitScript({ content: fs.readFileSync(path.join(ROOT, 'worker/src/rules.js'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, 'fake_api.js'), 'utf8') });
  await page.goto(base);
  page.errors = errors;
  return page;
}
const calls = (page, action) => page.evaluate((a) => window.FAKE.calls.filter((c) => !a || c.action === a).length, action);

test('outside Telegram shows the link message and makes no requests', async () => {
  const page = await open({ initData: '' });
  await page.getByText('Open BDO Picker from the Telegram link.').waitFor();
  assert.equal(await calls(page), 0);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('first time: link callsign then calendar appears', async () => {
  const page = await open({ linked: false });
  await page.getByText('First time here').waitFor();
  assert.equal(await page.locator('input[value="VIPER"]').isDisabled(), true);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390), 'no sideways scroll');
  const box = await page.locator('fieldset').boundingBox();
  const hawk = await page.locator('label', { hasText: 'HAWK' }).boundingBox();
  assert.ok(hawk.x >= box.x && hawk.x + hawk.width <= box.x + box.width + 1, 'callsign rows stay inside the card');
  await page.locator('input[value="MAMBA"]').check();
  await page.getByRole('button', { name: "I'm MAMBA" }).click();
  await page.getByText('December 2026').waitFor();
  assert.equal(await calls(page, 'link'), 1);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('pick an open day then a taken day', async () => {
  const page = await open();
  await page.locator('#cal [data-date="2026-12-12"]').click();
  await page.locator('#action', { hasText: 'Take this day' }).click();
  await page.locator('#mine', { hasText: 'Sat 12 Dec · BDO' }).waitFor();
  await page.locator('#cal [data-date="2026-12-05"]').click();
  await page.locator('#action', { hasText: 'Join the queue' }).click();
  await page.locator('#status', { hasText: 'number 2 in the queue' }).waitFor();
  assert.match(await page.locator('#panel').innerText(), /2\s*MAMBA \(you\)/);
  await page.locator('#action', { hasText: 'Leave the queue' }).waitFor();
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('days the planner has not set cannot be tapped', async () => {
  const page = await open();
  assert.equal(await page.locator('#cal [data-date="2026-12-06"]').isDisabled(), true);
  await page.close();
});

test('double tap sends one pick', async () => {
  const page = await open({ delay: 300 });
  await page.locator('#cal [data-date="2026-12-12"]').click();
  await page.locator('#action').click();
  await page.locator('#action').click({ force: true, timeout: 1000 }).catch(() => {});
  await page.locator('#mine', { hasText: 'Sat 12 Dec · BDO' }).waitFor();
  assert.equal(await calls(page, 'pick'), 1);
  await page.close();
});

test('planner tab only for admins', async () => {
  const notAdmin = await open({ admin: false });
  await notAdmin.getByText('December 2026').waitFor();
  assert.equal(await notAdmin.locator('#tab-planner').count(), 0);
  await notAdmin.close();
  const admin = await open();
  await admin.getByText('December 2026').waitFor();
  assert.equal(await admin.locator('#tab-planner').count(), 1);
  await admin.close();
});

test('set a day as planner', async () => {
  const page = await open();
  await page.locator('#tab-planner').click();
  await page.locator('#cal [data-date="2026-12-19"]').click();
  await page.locator('#cal [data-date="2026-12-19"]', { hasText: 'OPEN' }).waitFor();
  await page.locator('#tab-pick').click();
  await page.locator('#cal [data-date="2026-12-19"]', { hasText: 'OPEN' }).waitFor();
  assert.equal(await page.locator('#cal [data-date="2026-12-19"]').isDisabled(), false);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('planner removing a held day asks first', async () => {
  const page = await open();
  await page.locator('#tab-planner').click();
  await page.locator('#cal [data-date="2026-12-05"]').click();
  await page.locator('#day-panel', { hasText: 'Saturday 5 Dec' }).waitFor();
  assert.match(await page.locator('#cal [data-date="2026-12-05"]').innerText(), /BDO/, 'tapping a set day only selects it');
  await page.getByRole('button', { name: 'Remove this BDO day' }).click();
  await page.locator('#cal [data-date="2026-12-05"]', { hasText: /^\s*5\s*$/ }).waitFor();
  assert.equal(await page.evaluate(() => window.LAST_CONFIRM), 'Remove Sat 5 Dec? HAWK, VIPER will be told.');
  await page.close();
});

test('admins: add one, then remove yourself', async () => {
  const page = await open();
  await page.locator('#tab-planner').click();
  const removeMe = page.getByRole('button', { name: 'Remove me' });
  await removeMe.waitFor();
  assert.equal(await removeMe.isDisabled(), true);
  await page.locator('#add-admin').selectOption('HAWK');
  await page.getByRole('button', { name: 'Add admin' }).click();
  await page.locator('#admins', { hasText: 'HAWK' }).waitFor();
  assert.equal(await removeMe.isDisabled(), false);
  assert.equal(await page.locator('#admins button').count(), 1, 'only your own row has a remove button');
  await page.close();
});

test('fits at 360 px', async () => {
  const page = await open({ width: 360 });
  await page.getByText('December 2026').waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 360));
  await page.locator('#tab-planner').click();
  await page.getByRole('button', { name: 'Remove me' }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 360));
  await page.close();
});

test('opening the app makes one request', async () => {
  const page = await open();
  await page.getByText('December 2026').waitFor();
  await page.locator('#cal [data-date="2026-12-12"]', { hasText: 'OPEN' }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.FAKE.calls.map((c) => c.action)), ['init']);
  await page.close();
});

test('changing month needs no request', async () => {
  const page = await open();
  await page.getByText('December 2026').waitFor();
  await page.getByRole('button', { name: 'Next month' }).click();
  await page.getByText('January 2027').waitFor();
  await page.locator('#cal [data-date="2027-01-09"]', { hasText: 'BDO' }).waitFor();
  await page.getByRole('button', { name: 'Previous month' }).click();
  await page.getByText('December 2026').waitFor();
  assert.equal(await calls(page), 1);
  await page.close();
});

test('my days lists every upcoming day, not just this month', async () => {
  const page = await open();
  await page.locator('#mine', { hasText: 'Sat 9 Jan · BDO' }).waitFor();
  await page.close();
});

test('saving shows straight away while waiting for the answer', async () => {
  const page = await open({ delay: 600 });
  await page.locator('#cal [data-date="2026-12-12"]', { hasText: 'OPEN' }).waitFor();
  await page.locator('#cal [data-date="2026-12-12"]').click();
  await page.locator('#action').click();
  assert.equal((await page.locator('#action').innerText()).trim(), 'Saving…');
  assert.match(await page.locator('#cal [data-date="2026-12-12"]').innerText(), /SAVING/);
  await page.locator('#mine', { hasText: 'Sat 12 Dec · BDO' }).waitFor();
  await page.close();
});

test('the planner tab opens without a request', async () => {
  const page = await open();
  await page.getByText('December 2026').waitFor();
  await page.locator('#tab-planner').click();
  await page.getByRole('button', { name: 'Remove me' }).waitFor();
  assert.match(await page.locator('#admins').innerText(), /MAMBA/);
  assert.equal(await calls(page), 1);
  await page.close();
});

test('guide page has a crew part and a planner part and fits a phone', async () => {
  const page = await browser.newPage({ viewport: { width: 360, height: 740 } });
  await page.goto(base + 'guide.html');
  await page.getByRole('heading', { name: 'For everyone' }).waitFor({ timeout: 5000 });
  await page.getByRole('heading', { name: 'For planners' }).waitFor({ timeout: 5000 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 360));
  await page.getByRole('link', { name: 'Planner guide' }).click();
  assert.equal(await page.evaluate(() => location.hash), '#planner');
  await page.close();
});

test('planner makes someone BDO and the old BDO moves to queue 1', async () => {
  const page = await open();
  await page.locator('#tab-planner').click();
  await page.locator('#cal [data-date="2026-12-05"]').click();
  await page.locator('#assign-who').selectOption('OSPREY');
  await page.getByRole('button', { name: 'Make BDO' }).click();
  await page.locator('#status', { hasText: 'OSPREY is now BDO' }).waitFor();
  const panel = await page.locator('#day-panel').innerText();
  assert.match(panel, /BDO\s*OSPREY/);
  assert.match(panel, /1\s*HAWK[\s\S]*2\s*VIPER/);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('planner adds someone to the queue and takes someone off', async () => {
  const page = await open();
  await page.locator('#tab-planner').click();
  await page.locator('#cal [data-date="2026-12-05"]').click();
  await page.locator('#assign-who').selectOption('RAVEN');
  await page.getByRole('button', { name: 'Add to queue' }).click();
  await page.locator('#status', { hasText: 'RAVEN is number 2 in the queue' }).waitFor();
  assert.match(await page.locator('#day-panel').innerText(), /2\s*RAVEN/);
  await page.getByRole('button', { name: 'Take VIPER off this day' }).click();
  await page.locator('#status', { hasText: 'VIPER is off' }).waitFor();
  const queue = await page.locator('#day-panel .queue').innerText(); // the dropdown lists VIPER again, so check the queue only
  assert.doesNotMatch(queue, /VIPER/);
  assert.match(queue, /1\s*RAVEN/);
  await page.close();
});

test('the planner day panel fits a phone', async () => {
  const page = await open({ width: 360 });
  await page.locator('#tab-planner').click();
  await page.locator('#cal [data-date="2026-12-05"]').click();
  await page.getByRole('button', { name: 'Make BDO' }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 360));
  await page.close();
});

test('planner adds and removes crew', async () => {
  const page = await open();
  await page.locator('#tab-planner').click();
  await page.locator('#crew', { hasText: 'VIPER' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Remove MAMBA from the crew' }).count(), 0, 'no remove button on your own callsign');
  await page.locator('#new-crew').fill('falcon');
  await page.getByRole('button', { name: 'Add crew' }).click();
  await page.locator('#crew', { hasText: 'FALCON' }).waitFor();
  await page.getByRole('button', { name: 'Remove VIPER from the crew' }).click();
  await page.locator('#status', { hasText: 'VIPER removed from the crew' }).waitFor();
  assert.equal(await page.evaluate(() => window.LAST_CONFIRM), 'Remove VIPER from the crew? VIPER is on 1 upcoming day and will be taken off it.');
  assert.doesNotMatch(await page.locator('#crew').innerText(), /VIPER/);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('planner reads the activity log, newest first, and loads older lines', async () => {
  const page = await open();
  await page.locator('#tab-planner').click();
  assert.equal(await calls(page, 'log'), 0, 'nothing is loaded until asked');
  await page.getByRole('button', { name: 'Show log' }).click();
  await page.locator('#log .logrow').first().waitFor();
  assert.equal(await page.locator('#log .logrow').count(), 50);
  assert.match(await page.locator('#log .logrow').first().innerText(), /RAVEN not delivered/);
  assert.equal(await page.locator('#log .logrow.failed').count(), 1);
  assert.deepEqual(await page.locator('#log .logday').allInnerTexts(), ['Today', 'Monday 30 Nov']);
  await page.getByRole('button', { name: 'Show older' }).click();
  await page.locator('#log .logrow').nth(54).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Show older' }).count(), 0, 'no more to load');
  assert.match(await page.locator('#log .logrow').last().innerText(), /picked line 1$/);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390), 'no sideways scroll');
  await page.getByRole('button', { name: 'Hide' }).click();
  assert.equal(await page.locator('#log').count(), 0);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('crew without admin rights see no log', async () => {
  const page = await open({ admin: false });
  await page.getByText('Signed in as MAMBA').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Show log' }).count(), 0);
  await page.close();
});

test('planner connects the group, previews and posts the month', async () => {
  const page = await open();
  await page.locator('#tab-planner').click();
  await page.getByRole('button', { name: 'Find group' }).click();
  await page.locator('#group', { hasText: 'Connected to 121 SQN' }).waitFor();
  await page.locator('#announce-note').fill('Thanks all.');
  await page.getByRole('button', { name: 'Preview message' }).click();
  await page.locator('#announce-preview', { hasText: 'BDO dates for December 2026 are up.' }).waitFor();
  assert.match(await page.locator('#announce-preview').innerText(), /Thanks all\.$/);
  await page.getByRole('button', { name: 'Post to group' }).click();
  await page.locator('#status', { hasText: 'Posted to 121 SQN.' }).waitFor();
  const posts = await page.evaluate(() => window.FAKE.calls.filter((c) => c.action === 'announce' && !c.args.preview).map((c) => c.args));
  assert.deepEqual(posts, [{ month: '2026-12', note: 'Thanks all.', preview: false }]);
  assert.match(await page.evaluate(() => window.LAST_CONFIRM), /Post December 2026 to 121 SQN\?/);
  await page.close();
});

const comeBack = (page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
const inits = (page) => page.evaluate(() => window.FAKE.calls.filter((c) => c.action === 'init').length);

test('coming back to the app shows other people\'s new picks', async () => {
  const page = await open();
  await page.locator('#cal [data-date="2026-12-12"]', { hasText: 'OPEN' }).waitFor();
  await page.locator('#cal [data-date="2026-12-12"]').click();
  await page.evaluate(() => { window.FAKE.state.days[1] = { date: '2026-12-12', bdo: 'HAWK', queue: [] }; });
  await comeBack(page);
  await page.locator('#cal [data-date="2026-12-12"]', { hasText: 'HAWK' }).waitFor();
  assert.match(await page.locator('#panel').innerText(), /BDO\s*HAWK/, 'the selected day stays selected');
  assert.equal(await inits(page), 2);
  await page.close();
});

test('the app refreshes by itself while open', async () => {
  const page = await open({ refreshMs: 150 });
  await page.locator('#cal [data-date="2026-12-12"]', { hasText: 'OPEN' }).waitFor();
  await page.evaluate(() => { window.FAKE.state.days[1] = { date: '2026-12-12', bdo: 'VIPER', queue: [] }; });
  await page.locator('#cal [data-date="2026-12-12"]', { hasText: 'VIPER' }).waitFor();
  await page.close();
});

test('no refresh while typing, and the planner keeps its place', async () => {
  const page = await open();
  await page.locator('#tab-planner').click();
  await page.getByRole('button', { name: 'Next month' }).click();
  await page.locator('#new-crew').fill('fal');
  await comeBack(page);
  await page.waitForTimeout(200);
  assert.equal(await inits(page), 1, 'skipped while a text box has focus');
  assert.equal(await page.locator('#new-crew').inputValue(), 'fal');
  await page.locator('#new-crew').blur();
  await comeBack(page);
  await page.waitForFunction(() => window.FAKE.calls.filter((c) => c.action === 'init').length === 2);
  await page.getByText('January 2027').waitFor();
  assert.equal(await page.locator('#tab-planner').getAttribute('aria-selected'), 'true');
  await page.close();
});

test('help opens the guide', async () => {
  const page = await open();
  await page.getByRole('link', { name: 'Help' }).click();
  assert.match(await page.evaluate(() => window.OPENED), /\/guide\.html$/);
  await page.close();
  const first = await open({ linked: false });
  await first.getByText('First time here').waitFor();
  assert.equal(await first.getByRole('link', { name: 'Help' }).count(), 1);
  await first.close();
});

test('a refresh that started before a pick does not undo it on screen', async () => {
  const page = await open({ admin: false });
  await page.locator('#action').waitFor();
  // The refresh answers with the days as they were when it asked, but arrives after the pick.
  await page.evaluate(() => {
    const real = window.BDO_FAKE_API;
    window.BDO_FAKE_API = (a, args) => {
      const p = real(a, args);
      return a === 'init' ? p.then((r) => new Promise((ok) => setTimeout(() => ok(r), 300))) : p;
    };
  });
  await page.locator('[data-date="2026-12-12"]').click();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.locator('#action').click();
  await page.locator('#panel').getByText('MAMBA').waitFor();
  await page.waitForTimeout(500); // the late refresh has landed by now
  assert.match(await page.locator('#panel').innerText(), /MAMBA/);
  assert.equal(await page.locator('#action').innerText(), 'Drop this day');
  assert.deepEqual(page.errors, []);
  await page.close();
});
