import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const failure = () => new Error('小黑盒专用账号凭据无效，请在本机登录窗口重新确认。');
const accountIdPattern = /^[1-9]\d{0,19}$/;
const cookieNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/;

export function normalizeHeyboxCredentials(value, { expectedAccountId } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => !['accountId', 'cookie'].includes(key))
    || !Object.hasOwn(value, 'accountId') || !Object.hasOwn(value, 'cookie')
    || typeof value.accountId !== 'string' || !accountIdPattern.test(value.accountId)
    || (expectedAccountId !== undefined && (typeof expectedAccountId !== 'string'
      || !accountIdPattern.test(expectedAccountId) || value.accountId !== expectedAccountId))
    || typeof value.cookie !== 'string' || !value.cookie.length || Buffer.byteLength(value.cookie, 'utf8') > 16384
    || /[\x00-\x1f\x7f]/.test(value.cookie)) throw failure();
  const entries = value.cookie.split(';');
  if (entries.length > 128) throw failure();
  const cookies = new Map();
  for (const entry of entries) {
    const pair = entry.trim(), separator = pair.indexOf('=');
    if (separator <= 0) throw failure();
    const name = pair.slice(0, separator), content = pair.slice(separator + 1);
    if (!cookieNamePattern.test(name) || cookies.has(name) || !/^[\x21-\x7e]*$/.test(content)
      || /[",;\\]/.test(content)) throw failure();
    cookies.set(name, content);
  }
  if (cookies.get('heybox_id') !== value.accountId || !(cookies.get('x_xhh_tokenid') || cookies.get('user_pkey'))) throw failure();
  return { accountId: value.accountId, cookie: [...cookies].map(([name, content]) => `${name}=${content}`).join('; ') };
}

export function readHeyboxCredentials({ dataDir, expectedAccountId } = {}) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) throw failure();
  const path = join(resolve(dataDir), 'heybox-credentials.json');
  try {
    const file = lstatSync(path, { throwIfNoEntry: false });
    if (!file) return null;
    if (!file.isFile() || file.isSymbolicLink() || file.size > 32768
      || (process.platform !== 'win32' && (file.mode & 0o077) !== 0)) throw failure();
    const raw = readFileSync(path);
    if (raw.length > 32768) throw failure();
    return normalizeHeyboxCredentials(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)), { expectedAccountId });
  } catch { throw failure(); }
}
