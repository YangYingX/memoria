import { assertPublicUrl, fetchPublicResource } from './public-fetch.js';

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export function imageMimeType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  throw new Error('图片格式不受支持；请发送 JPEG、PNG、WebP 或 GIF 图片。');
}

function checkCount(images) {
  if (!Array.isArray(images) || images.length > MAX_IMAGES) throw new Error('每条消息最多支持 4 张图片。');
}

export function validateQQImageUrls(urls) {
  checkCount(urls);
  return urls.map(value => {
    if (typeof value !== 'string' || !value) throw new Error('QQ 图片缺少公开下载地址，请重新发送原图。');
    return assertPublicUrl(value).href;
  });
}

export async function loadQQImages(urls, options = {}) {
  options.signal?.throwIfAborted();
  const addresses = validateQQImageUrls(urls);
  if (!addresses.length) return [];
  const timeout = AbortSignal.timeout(20000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const images = [];
  let total = 0;
  for (const url of addresses) {
    signal.throwIfAborted();
    const remaining = MAX_TOTAL_BYTES - total;
    if (!remaining) throw new Error('每条消息的图片合计不能超过 20 MiB。');
    const { bytes } = await fetchPublicResource(url, {
      signal, maxBytes: Math.min(MAX_IMAGE_BYTES, remaining), timeoutMs: 20000, maxRedirects: 3,
      headers: { Accept: 'image/jpeg, image/png, image/webp, image/gif' },
    });
    signal.throwIfAborted();
    const mimeType = imageMimeType(bytes);
    total += bytes.length;
    images.push({ mimeType, dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}` });
  }
  return images;
}

// The agent accepts bytes encoded by the downloader, never a remote URL or a local file path.
export function validateConversationImages(images) {
  checkCount(images);
  let total = 0;
  return images.map(image => {
    if (!image || typeof image.dataUrl !== 'string' || image.dataUrl.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 40) throw new Error('图片数据无效或超过单张 8 MiB 限制。');
    const match = image.dataUrl.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match) throw new Error('图片须为已验证的 JPEG、PNG、WebP 或 GIF 数据。');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== match[2]) throw new Error('图片数据无效或超过单张 8 MiB 限制。');
    const mimeType = imageMimeType(bytes);
    if (mimeType !== match[1] || mimeType !== image.mimeType) throw new Error('图片实际格式与声明不一致。');
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('每条消息的图片合计不能超过 20 MiB。');
    return { mimeType, dataUrl: image.dataUrl };
  });
}

export function omitImagePayload(text, images) {
  if (typeof text !== 'string') return text;
  let result = text;
  for (const image of images) {
    result = result.replaceAll(image.dataUrl, '[图片数据已省略]')
      .replaceAll(image.dataUrl.slice(image.dataUrl.indexOf(',') + 1), '[图片数据已省略]');
  }
  return result;
}
