const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyInitData } = require('../worker/src/auth.mjs');
const { initDataFor } = require('./tg_sign');

const TOKEN = '123456:TEST-token';
const NOW = 1796000000;
const user = { id: 5123, first_name: 'M', username: 'mamba_ops' };
const code = async (p) => { try { await p; } catch (e) { return e.code; } return 'NO ERROR'; };

test('valid initData returns the user', async () => {
  const u = await verifyInitData(initDataFor(user, TOKEN, NOW - 60), TOKEN, NOW);
  assert.equal(u.id, '5123');
  assert.equal(u.username, 'mamba_ops');
});

test('tampered user is rejected', async () => {
  const good = initDataFor(user, TOKEN, NOW - 60);
  const bad = good.replace(encodeURIComponent('5123'), encodeURIComponent('9999'));
  assert.notEqual(bad, good);
  assert.equal(await code(verifyInitData(bad, TOKEN, NOW)), 'AUTH');
});

test('wrong bot token is rejected', async () => {
  assert.equal(await code(verifyInitData(initDataFor(user, 'other:token', NOW), TOKEN, NOW)), 'AUTH');
});

test('missing hash is rejected', async () => {
  const noHash = initDataFor(user, TOKEN, NOW).replace(/&hash=[0-9a-f]+$/, '');
  assert.equal(await code(verifyInitData(noHash, TOKEN, NOW)), 'AUTH');
});

test('empty string is rejected', async () => {
  assert.equal(await code(verifyInitData('', TOKEN, NOW)), 'AUTH');
  assert.equal(await code(verifyInitData(undefined, TOKEN, NOW)), 'AUTH');
});

test('initData older than 24 hours is rejected', async () => {
  assert.equal(await code(verifyInitData(initDataFor(user, TOKEN, NOW - 86401), TOKEN, NOW)), 'AUTH');
  assert.equal((await verifyInitData(initDataFor(user, TOKEN, NOW - 86000), TOKEN, NOW)).id, '5123');
});

test('auth error message tells the user what to do', async () => {
  try { await verifyInitData('', TOKEN, NOW); } catch (e) { assert.equal(e.message, 'Open BDO Picker from the Telegram link.'); }
});
