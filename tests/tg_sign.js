// Test helper: signs Telegram Mini App initData exactly the way Telegram does.
const crypto = require('crypto');

function nodeHmac(key, msg) {
  const k = typeof key === 'string' ? Buffer.from(key, 'utf8') : Buffer.from(key);
  return [...crypto.createHmac('sha256', k).update(msg, 'utf8').digest()];
}

function signInitData(fields, botToken) {
  const dcs = Object.keys(fields).sort().map((k) => k + '=' + fields[k]).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  return Object.keys(fields).map((k) => k + '=' + encodeURIComponent(fields[k])).join('&') + '&hash=' + hash;
}

function initDataFor(user, botToken, authDate) {
  return signInitData({ query_id: 'AAH' + user.id, user: JSON.stringify(user), auth_date: String(authDate) }, botToken);
}

module.exports = { nodeHmac, signInitData, initDataFor };
