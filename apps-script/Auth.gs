// Checks that a request really comes from the Telegram user it names.
// Telegram signs the Mini App's initData with a key derived from the bot token; see
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// `hmac(key, msg)` returns HMAC-SHA256 bytes (0..255); key is a string or a byte array.

function authFail() {
  return new RuleError('AUTH', 'Open BDO Picker from the Telegram link.');
}

function toHex(bytes) {
  return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

function sameText(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function verifyInitData(initData, botToken, hmac, nowSec, maxAgeSec) {
  if (maxAgeSec === undefined) maxAgeSec = 86400;
  if (!initData || typeof initData !== 'string') throw authFail();
  var fields = {};
  var hash = '';
  initData.split('&').forEach(function (part) {
    var eq = part.indexOf('=');
    if (eq < 0) return;
    var key = part.slice(0, eq);
    var value;
    try { value = decodeURIComponent(part.slice(eq + 1)); } catch (e) { throw authFail(); }
    if (key === 'hash') hash = value; else fields[key] = value;
  });
  if (!hash) throw authFail();
  var dataCheckString = Object.keys(fields).sort().map(function (k) { return k + '=' + fields[k]; }).join('\n');
  var secret = hmac('WebAppData', botToken);
  if (!sameText(toHex(hmac(secret, dataCheckString)), hash.toLowerCase())) throw authFail();
  var authDate = Number(fields.auth_date);
  if (!authDate || nowSec - authDate > maxAgeSec) throw authFail();
  var user;
  try { user = JSON.parse(fields.user); } catch (e) { throw authFail(); }
  if (!user || !user.id) throw authFail();
  return { id: String(user.id), username: user.username || '' };
}
