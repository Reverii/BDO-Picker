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

async function open({ initData = 'test', linked = true, admin = true, delay = 0, width = 390 } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '', contentType: 'text/javascript' }));
  await page.addInitScript(({ initData, linked, admin, delay }) => {
    window.BDO_TODAY = '2026-12-01';
    window.FAKE_OPTS = { linked, admin, delay };
    window.Telegram = { WebApp: { initData, themeParams: {}, ready() {}, expand() {}, requestWriteAccess(cb) { cb(true); }, showConfirm(msg, cb) { window.LAST_CONFIRM = msg; cb(true); } } };
  }, { initData, linked, admin, delay });
  // Rules.gs and the fake API load before app.js runs (app.js waits for DOMContentLoaded).
  await page.addInitScript({ content: fs.readFileSync(path.join(ROOT, 'apps-script/Rules.gs'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, 'fake_api.js'), 'utf8') });
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
