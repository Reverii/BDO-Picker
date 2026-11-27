// Checks that a request really comes from the Telegram user it names.
// Telegram signs the Mini App's initData with a key derived from the bot token; see
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

import R from './rules.js';

const enc = new TextEncoder();

function authFail() {
  return new R.RuleError('AUTH', 'Open BDO Picker from the Telegram link.');
}

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Returns { id, username } or throws a RuleError with code AUTH.
export async function verifyInitData(initData, botToken, nowSec, maxAgeSec = 86400) {
  if (!initData || typeof initData !== 'string') throw authFail();
  const fields = {};
  let hash = '';
  for (const part of initData.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq);
    let value;
    try { value = decodeURIComponent(part.slice(eq + 1)); } catch (e) { throw authFail(); }
    if (key === 'hash') hash = value; else fields[key] = value;
  }
  if (!hash) throw authFail();
  const dataCheckString = Object.keys(fields).sort().map((k) => k + '=' + fields[k]).join('\n');
  const secret = await hmac('WebAppData', botToken);
  if (!sameText(toHex(await hmac(secret, dataCheckString)), hash.toLowerCase())) throw authFail();
  const authDate = Number(fields.auth_date);
  if (!authDate) throw authFail();
  // Signed by Telegram but too old: the app was left open. Reopening it gets a fresh sign-in.
  if (nowSec - authDate > maxAgeSec) {
    throw new R.RuleError('EXPIRED', 'BDO Picker has been open for more than a day. Close it and open it again from Telegram.');
  }
  let user;
  try { user = JSON.parse(fields.user); } catch (e) { throw authFail(); }
  if (!user || !user.id) throw authFail();
  return { id: String(user.id), username: user.username || '' };
}
