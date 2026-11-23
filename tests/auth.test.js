const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGs } = require('./load_gs');
const { nodeHmac, initDataFor } = require('./tg_sign');

const A = loadGs(['Rules.gs', 'Auth.gs']);
const TOKEN = '123456:TEST-token';
const NOW = 1796000000;
const user = { id: 5123, first_name: 'M', username: 'mamba_ops' };
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 'NO ERROR'; };

test('valid initData returns the user', () => {
  const u = A.verifyInitData(initDataFor(user, TOKEN, NOW - 60), TOKEN, nodeHmac, NOW);
  assert.equal(u.id, '5123');
  assert.equal(u.username, 'mamba_ops');
});

test('tampered user is rejected', () => {
  const good = initDataFor(user, TOKEN, NOW - 60);
  const bad = good.replace(encodeURIComponent('5123'), encodeURIComponent('9999'));
  assert.notEqual(bad, good);
  assert.equal(code(() => A.verifyInitData(bad, TOKEN, nodeHmac, NOW)), 'AUTH');
});

test('wrong bot token is rejected', () => {
  assert.equal(code(() => A.verifyInitData(initDataFor(user, 'other:token', NOW), TOKEN, nodeHmac, NOW)), 'AUTH');
});

test('missing hash is rejected', () => {
  const noHash = initDataFor(user, TOKEN, NOW).replace(/&hash=[0-9a-f]+$/, '');
  assert.equal(code(() => A.verifyInitData(noHash, TOKEN, nodeHmac, NOW)), 'AUTH');
});

test('empty string is rejected', () => {
  assert.equal(code(() => A.verifyInitData('', TOKEN, nodeHmac, NOW)), 'AUTH');
  assert.equal(code(() => A.verifyInitData(undefined, TOKEN, nodeHmac, NOW)), 'AUTH');
});

test('initData older than 24 hours is rejected', () => {
  assert.equal(code(() => A.verifyInitData(initDataFor(user, TOKEN, NOW - 86401), TOKEN, nodeHmac, NOW)), 'AUTH');
  assert.equal(A.verifyInitData(initDataFor(user, TOKEN, NOW - 86000), TOKEN, nodeHmac, NOW).id, '5123');
});

test('auth error message tells the user what to do', () => {
  try { A.verifyInitData('', TOKEN, nodeHmac, NOW); } catch (e) { assert.equal(e.message, 'Open BDO Picker from the Telegram link.'); }
});
