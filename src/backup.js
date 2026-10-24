import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

const FORMAT = 'persona-agent-backup';
const MAX_BYTES = 30 * 1024 * 1024;
const MAX_LOGICAL_BYTES = 128 * 1024 * 1024;
const MAX_V1_BYTES = Math.floor(MAX_BYTES * 0.7);
const V1_FIELDS = ['format', 'version', 'salt', 'iv', 'tag', 'ciphertext'];
const V2_FIELDS = [...V1_FIELDS, 'compression', 'uncompressedBytes'];

function additionalData(version, uncompressedBytes) {
  return Buffer.from(version === 1 ? `${FORMAT}:1` : `${FORMAT}:2:gzip:${uncompressedBytes}`, 'utf8');
}

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
  if (plaintext.length > MAX_LOGICAL_BYTES) throw new Error('备份原始内容超过 128 MiB 上限，未删减数据。');
  const compressed = gzipSync(plaintext);
  if (compressed.length > MAX_BYTES) throw new Error('压缩后的备份超过 30 MiB 上限，未生成备份。');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(additionalData(2, plaintext.length));
    const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
    const archive = Buffer.from(JSON.stringify({
      format: FORMAT,
      version: 2,
      compression: 'gzip',
      uncompressedBytes: plaintext.length,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    }), 'utf8');
    if (archive.length > MAX_BYTES) throw new Error('加密备份超过 30 MiB 上限，未生成备份。');
    return archive;
  } finally { key.fill(0); }
}

export function decryptBackup(bufferOrString, passphrase) {
  checkPassphrase(passphrase);
  try {
    if ((!Buffer.isBuffer(bufferOrString) && typeof bufferOrString !== 'string')
      || Buffer.byteLength(bufferOrString) > MAX_BYTES) throw new Error('invalid size');
    const envelope = JSON.parse(bufferOrString.toString('utf8'));
    if (!envelope || Array.isArray(envelope) || typeof envelope !== 'object'
      || envelope.format !== FORMAT || ![1, 2].includes(envelope.version)) throw new Error('invalid format');
    const fields = envelope.version === 1 ? V1_FIELDS : V2_FIELDS;
    if (Object.keys(envelope).length !== fields.length || !fields.every(key => Object.hasOwn(envelope, key))
      || envelope.version === 2 && (envelope.compression !== 'gzip' || !Number.isSafeInteger(envelope.uncompressedBytes)
        || envelope.uncompressedBytes < 1 || envelope.uncompressedBytes > MAX_LOGICAL_BYTES)) throw new Error('invalid format');
    const salt = decodeBase64(envelope.salt, 16);
    const iv = decodeBase64(envelope.iv, 12);
    const tag = decodeBase64(envelope.tag, 16);
    const ciphertext = decodeBase64(envelope.ciphertext);
    if (!ciphertext.length || (envelope.version === 1 && ciphertext.length > MAX_V1_BYTES)) throw new Error('invalid payload size');
    const key = scryptSync(passphrase, salt, 32);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(additionalData(envelope.version, envelope.uncompressedBytes));
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const plaintext = envelope.version === 1 ? decrypted : gunzipSync(decrypted, { maxOutputLength: envelope.uncompressedBytes });
      if (envelope.version === 2 && plaintext.length !== envelope.uncompressedBytes) throw new Error('invalid output size');
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
    } finally { key.fill(0); }
  } catch {
    throw new Error('无法解密备份：口令不正确、文件已损坏或格式不受支持。');
  }
}
