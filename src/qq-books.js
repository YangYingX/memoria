import { createHash } from 'node:crypto';
import { assertPublicUrl, fetchPublicResource } from './public-fetch.js';
import { BOOK_FILE_MAX_BYTES, parseBookFile } from './book-files.js';

const MAX_BYTES = BOOK_FILE_MAX_BYTES;

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
    if (files.length !== 1) return { name: '', fileKey: fileKey(event, { name: 'multiple' }), unsupported: true, reason: '请每次单独发送一本 TXT 或 EPUB 文件。' };
    type = files[0].type; data = files[0].data;
  } else if (event.post_type === 'notice' && event.notice_type === 'private_file' && !event.group_id) data = event.file;
  else return null;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { name: '', fileKey: fileKey(event, { name: 'invalid' }), unsupported: true, reason: '文件信息不完整，请重新发送 TXT 或 EPUB 文件。' };
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
  if (type !== 'file') reason = '请用普通文件方式发送 TXT 或 EPUB；暂不支持在线传输或文件夹。';
  else if (!name || /[\\/\u0000-\u001f\u007f]/.test(name)) reason = '文件名无效，请使用普通名称重新发送 TXT 或 EPUB 文件。';
  else if (!/\.(?:txt|epub)$/i.test(name)) reason = '目前支持 TXT 和 EPUB 书籍，请转换格式后发送。';
  else if (rawSize !== undefined && (!Number.isSafeInteger(size) || size < 0)) reason = '文件大小信息无效，请重新发送 TXT 或 EPUB 文件。';
  else if (size > MAX_BYTES) reason = '这本书的文件超过 3 MiB，请分章后单独发送。';
  else if (!id && !url) reason = '没有收到文件下载信息，请重新发送 TXT 或 EPUB 文件。';
  return reason ? { ...file, unsupported: true, reason } : file;
}

export async function loadQQBookFile({ file, resolveUrl, signal } = {}) {
  if (!file || typeof file !== 'object' || file.unsupported) throw new Error(file?.reason || '文件信息无效，请重新发送 TXT 或 EPUB 文件。');
  if (typeof file.name !== 'string' || file.name.length > 512 || !/\.(?:txt|epub)$/i.test(file.name)
    || /[\\/\u0000-\u001f\u007f]/.test(file.name)) throw new Error('只支持名称有效的 TXT 或 EPUB 文件。');
  if (file.size !== undefined && (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_BYTES)) throw new Error('书籍文件不能超过 3 MiB。');
  const timeout = AbortSignal.timeout(20000), active = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    active.throwIfAborted();
    let url = file.url;
    if (!url) {
      if (typeof file.id !== 'string' || !file.id.trim() || file.id.length > 2048 || typeof resolveUrl !== 'function') throw new Error('文件缺少公开下载地址，请重新发送 TXT 或 EPUB 文件。');
      try { url = await resolveUrl(file.id, { signal: active }); }
      catch { throw new Error('未取得书籍文件下载地址，请重新发送文件。'); }
    }
    active.throwIfAborted();
    let address;
    try { address = assertPublicUrl(url).href; }
    catch { throw new Error('文件没有可用的公开下载地址，不会读取本机路径。'); }
    const { bytes, headers } = await fetchPublicResource(address, {
      signal: active, maxBytes: MAX_BYTES, timeoutMs: 20000, maxRedirects: 3,
      headers: { Accept: 'text/plain, application/epub+zip, application/zip;q=0.9, application/octet-stream;q=0.8' },
    });
    active.throwIfAborted();
    if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('书籍文件为空或超过 3 MiB。');
    const type = String(headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (/^(?:image\/|audio\/|video\/|application\/(?:pdf|gzip)|text\/html)/.test(type)
      || /\.txt$/i.test(file.name) && /^(?:application\/(?:zip|epub\+zip))/.test(type)) {
      throw new Error('下载地址没有返回对应的 TXT 或 EPUB 文件，请重新发送。');
    }
    return await parseBookFile({ name: file.name, bytes, signal: active });
  } catch (error) {
    if (active.aborted) throw new Error('文件接收已取消或超时，请稍后重新发送。');
    throw error;
  }
}
