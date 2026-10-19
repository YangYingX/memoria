import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const FORMAT = 'persona-agent-backup';
const MAX_BYTES = 30 * 1024 * 1024;
const FIELDS = ['format', 'version', 'salt', 'iv', 'tag', 'ciphertext'];

function checkPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || Array.from(passphrase).length < 12 || Buffer.byteLength(passphrase) > 4096) {
    throw new Error('备份口令须为至少 12 个字符，且不超过 4096 字节。');
  }
}

function decodeBase64(value, length) {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error('invalid encoding');
  }
  const bytes = Buffer.from(value, 'base64');
  if ((length !== undefined && bytes.length !== length) || bytes.toString('base64') !== value) {
    throw new Error('invalid length');
  }
  return bytes;
}

export function encryptBackup(payload, passphrase) {
  checkPassphrase(passphrase);
  let serialized;
  try { serialized = JSON.stringify(payload); } catch { throw new Error('备份内容必须能保存为 JSON。'); }
  if (serialized === undefined) throw new Error('备份内容必须能保存为 JSON。');
  const plaintext = Buffer.from(serialized, 'utf8');
  if (plaintext.length > Math.floor(MAX_BYTES * 0.7)) throw new Error('备份内容过大，请缩小备份范围。');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`${FORMAT}:1`, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.from(JSON.stringify({
      format: FORMAT,
      version: 1,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    }), 'utf8');
  } finally { key.fill(0); }
}

export function decryptBackup(bufferOrString, passphrase) {
  checkPassphrase(passphrase);
  try {
    if ((!Buffer.isBuffer(bufferOrString) && typeof bufferOrString !== 'string')
      || Buffer.byteLength(bufferOrString) > MAX_BYTES) throw new Error('invalid size');
    const envelope = JSON.parse(bufferOrString.toString('utf8'));
    if (!envelope || Array.isArray(envelope) || typeof envelope !== 'object'
      || Object.keys(envelope).length !== FIELDS.length
      || !FIELDS.every(key => Object.hasOwn(envelope, key))
      || envelope.format !== FORMAT || envelope.version !== 1) throw new Error('invalid format');
    const salt = decodeBase64(envelope.salt, 16);
    const iv = decodeBase64(envelope.iv, 12);
    const tag = decodeBase64(envelope.tag, 16);
    const ciphertext = decodeBase64(envelope.ciphertext);
    if (!ciphertext.length || ciphertext.length > Math.floor(MAX_BYTES * 0.7)) throw new Error('invalid payload size');
    const key = scryptSync(passphrase, salt, 32);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(Buffer.from(`${FORMAT}:1`, 'utf8'));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
    } finally { key.fill(0); }
  } catch {
    throw new Error('无法解密备份：口令不正确、文件已损坏或格式不受支持。');
  }
}
