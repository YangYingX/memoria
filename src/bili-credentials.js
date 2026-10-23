import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const failure = () => new Error('B站专用账号凭据无效，请重新导入登录状态。');

export function normalizeBiliCredentials(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => !['sessdata', 'accountId', 'biliJct', 'buvid3'].includes(key))
    || !Object.hasOwn(value, 'sessdata') || !Object.hasOwn(value, 'accountId')
    || typeof value.sessdata !== 'string' || !value.sessdata.length || value.sessdata.length >= 4096
    || /[\s\u0000-\u001f\u007f;]/u.test(value.sessdata)
    || typeof value.accountId !== 'string' || !/^[1-9]\d{0,19}$/.test(value.accountId)
    || (Object.hasOwn(value, 'biliJct') && (typeof value.biliJct !== 'string' || !/^[0-9a-f]{32}$/i.test(value.biliJct)))
    || (Object.hasOwn(value, 'buvid3') && (typeof value.buvid3 !== 'string' || !value.buvid3.length || value.buvid3.length > 512
      || !/^[\x21-\x7e]+$/.test(value.buvid3) || /[;,"\\]/.test(value.buvid3)))) throw failure();
  return { sessdata: value.sessdata, accountId: value.accountId,
    ...(Object.hasOwn(value, 'biliJct') ? { biliJct: value.biliJct } : {}),
    ...(Object.hasOwn(value, 'buvid3') ? { buvid3: value.buvid3 } : {}) };
}

// Reading callers receive only the original two fields, never social credentials.
export function readBiliCredentials({ dataDir, social = false }) {
  if (typeof dataDir !== 'string' || !dataDir.trim() || typeof social !== 'boolean') throw failure();
  const path = join(resolve(dataDir), 'bili-credentials.json');
  try {
    const file = lstatSync(path, { throwIfNoEntry: false });
    if (!file) return null;
    if (!file.isFile() || file.isSymbolicLink() || file.size > 32768) throw failure();
    const raw = readFileSync(path);
    if (raw.length > 32768) throw failure();
    const value = normalizeBiliCredentials(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
    return social ? value.biliJct ? value : null : { sessdata: value.sessdata, accountId: value.accountId };
  } catch { throw failure(); }
}
