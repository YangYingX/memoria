import { createHash } from 'node:crypto';
import { assertPublicUrl, fetchPublicResource } from './public-fetch.js';

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_CHARS = 1000000;

function fileKey(event, file) {
  const identity = file.id ? ['id', file.id] : file.url ? ['url', file.url]
    : ['event', String(event.message_id ?? event.time ?? ''), file.name];
  return createHash('sha256').update(JSON.stringify([String(event.self_id || ''), String(event.user_id || ''), ...identity])).digest('hex');
}

export function parseQQBookFile(event) {
  if (!event || typeof event !== 'object') return null;
  let data, type = 'file';
  if (event.post_type === 'message' && event.message_type === 'private') {
    const files = (Array.isArray(event.message) ? event.message : []).filter(item => ['file', 'onlinefile', 'flashtransfer'].includes(item?.type));
    if (!files.length) return null;
    if (files.length !== 1) return { name: '', fileKey: fileKey(event, { name: 'multiple' }), unsupported: true, reason: '请每次单独发送一本 TXT 文件。' };
    type = files[0].type; data = files[0].data;
  } else if (event.post_type === 'notice' && event.notice_type === 'private_file' && !event.group_id) data = event.file;
  else return null;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { name: '', fileKey: fileKey(event, { name: 'invalid' }), unsupported: true, reason: '文件信息不完整，请重新发送 TXT 文件。' };
  const rawName = data.name ?? data.file_name ?? data.fileName ?? data.file;
  const name = typeof rawName === 'string' && rawName.length <= 512 ? rawName.trim() : '';
  const rawId = data.id ?? data.file_id;
  const id = typeof rawId === 'string' && rawId.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(rawId) ? rawId.trim() : '';
  const rawUrl = data.url;
  const url = typeof rawUrl === 'string' && rawUrl.length <= 8192 && !/[\u0000-\u001f\u007f]/.test(rawUrl) ? rawUrl.trim() : '';
  const rawSize = data.size ?? data.file_size ?? data.fileSize;
  const size = typeof rawSize === 'string' && /^\d+$/.test(rawSize) ? Number(rawSize) : rawSize;
  const file = { name, ...(id ? { id } : {}), ...(url ? { url } : {}), ...(Number.isSafeInteger(size) && size >= 0 ? { size } : {}) };
  file.fileKey = fileKey(event, file);
  let reason = '';
  if (type !== 'file') reason = '请用普通文件方式发送 TXT；暂不支持在线传输或文件夹。';
  else if (!name || /[\\/\u0000-\u001f\u007f]/.test(name)) reason = '文件名无效，请使用普通名称重新发送 TXT 文件。';
  else if (!/\.txt$/i.test(name)) reason = '目前只能收录 TXT 文本书籍，请转换为 UTF-8 编码的 TXT 后发送。';
  else if (rawSize !== undefined && (!Number.isSafeInteger(size) || size < 0)) reason = '文件大小信息无效，请重新发送 TXT 文件。';
  else if (size > MAX_BYTES) reason = '这本 TXT 超过 3 MiB，请分章后单独发送。';
  else if (!id && !url) reason = '没有收到文件下载信息，请重新发送 TXT 文件。';
  return reason ? { ...file, unsupported: true, reason } : file;
}

export async function loadQQBookFile({ file, resolveUrl, signal } = {}) {
  if (!file || typeof file !== 'object' || file.unsupported) throw new Error(file?.reason || '文件信息无效，请重新发送 TXT 文件。');
  if (typeof file.name !== 'string' || file.name.length > 512 || !/\.txt$/i.test(file.name)
    || /[\\/\u0000-\u001f\u007f]/.test(file.name)) throw new Error('只支持名称有效的 TXT 文件。');
  if (file.size !== undefined && (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_BYTES)) throw new Error('TXT 文件不能超过 3 MiB。');
  const timeout = AbortSignal.timeout(20000), active = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    active.throwIfAborted();
    let url = file.url;
    if (!url) {
      if (typeof file.id !== 'string' || !file.id.trim() || file.id.length > 2048 || typeof resolveUrl !== 'function') throw new Error('文件缺少公开下载地址，请重新发送 TXT 文件。');
      try { url = await resolveUrl(file.id, { signal: active }); }
      catch { throw new Error('未取得 TXT 文件下载地址，请重新发送文件。'); }
    }
    active.throwIfAborted();
    let address;
    try { address = assertPublicUrl(url).href; }
    catch { throw new Error('文件没有可用的公开下载地址，不会读取本机路径。'); }
    const { bytes, headers } = await fetchPublicResource(address, {
      signal: active, maxBytes: MAX_BYTES, timeoutMs: 20000, maxRedirects: 3,
      headers: { Accept: 'text/plain, application/octet-stream;q=0.8' },
    });
    active.throwIfAborted();
    if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('TXT 文件为空或超过 3 MiB。');
    const type = String(headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
    const head = bytes.subarray(0, 8).toString('latin1');
    if (/^(?:image\/|audio\/|video\/|application\/(?:pdf|zip|gzip)|text\/html)/.test(type)
      || /^(?:\x89PNG\r\n\x1a\n|\xff\xd8\xff|GIF8[79]a|RIFF|%PDF-|PK\x03\x04|\x1f\x8b)/.test(head) || bytes.includes(0)) {
      throw new Error('文件不是可读的 TXT 文本，请转换为 UTF-8 编码的 TXT 后发送。');
    }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('暂只支持 UTF-8 编码，请将 TXT 转为 UTF-8 后重新发送。'); }
    if (!text.trim() || /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text)) throw new Error('TXT 正文为空或含有二进制控制字符，请检查后重新发送。');
    if (text.length > MAX_CHARS) throw new Error('TXT 正文超过 1000000 字，请分章后单独发送。');
    const title = file.name.replace(/\.txt$/i, '').trim().slice(0, 200);
    if (!title) throw new Error('请为 TXT 文件填写书名后重新发送。');
    return { title, text };
  } catch (error) {
    if (active.aborted) throw new Error('文件接收已取消或超时，请稍后重新发送。');
    throw error;
  }
}
