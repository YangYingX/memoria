import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { isHeyboxPostUrl, readHeyboxPost } from './browser-reader.js';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 30000;
const TIMEOUT_MS = 20000;

function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) {
    // Only global unicast; this also excludes mapped IPv4, NAT64 and local scopes.
    const [first, second = '0'] = address.toLowerCase().split(':');
    const a = Number.parseInt(first, 16);
    const b = Number.parseInt(second || '0', 16);
    return a >= 0x2000 && a <= 0x3fff
      && !(a === 0x2001 && (b < 0x0200 || b === 0x0db8))
      && a !== 0x2002
      && !(a === 0x3fff && b <= 0x0fff);
  }
  return false;
}

function checkedUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('请输入有效的公开网页地址。');
  let url;
  try { url = new URL(value); } catch { throw new Error('请输入有效的公开网页地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('仅支持不含登录凭据的 HTTP 或 HTTPS 网页。');
  }
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('网页阅读仅支持 80 和 443 端口。');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && !publicAddress(host))) {
    throw new Error('不能读取本机、内网或保留地址。');
  }
  url.hash = '';
  return { url, host };
}

export function extractArticle(html, url, { maxText = MAX_TEXT } = {}) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > MAX_BYTES) throw new Error('网页正文过大。');
  const { document } = parseHTML(html);
  Object.defineProperty(document, 'documentURI', { value: url, configurable: true });
  document.querySelectorAll('script, style, noscript, iframe, form, template, svg, canvas').forEach(node => node.remove());
  const article = new Readability(document, { charThreshold: 120, maxElemsToParse: 50000 }).parse();
  const text = article?.textContent?.replace(/\s+/g, ' ').trim() || '';
  if (text.length < 120) {
    throw new Error('未提取到足够的可读正文；此版本不支持登录、验证码或必须执行脚本的网页。');
  }
  return {
    title: (article.title || new URL(url).hostname).trim().slice(0, 500),
    text: text.slice(0, maxText),
    truncated: text.length > maxText,
    excerpt: (article.excerpt || text).replace(/\s+/g, ' ').trim().slice(0, 300),
  };
}

async function requestPage(value, signal, redirects = 0, maxText = MAX_TEXT) {
  const { url, host } = checkedUrl(value);
  signal.throwIfAborted();
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true, verbatim: true });
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) {
    throw new Error('网页域名指向本机、内网或保留地址，无法读取。');
  }
  const target = addresses.find(item => item.family === 4) || addresses[0];
  const response = await new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request({
      protocol: url.protocol,
      hostname: host,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      agent: false,
      family: target.family,
      autoSelectFamily: false,
      signal,
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [target]);
        else callback(null, target.address, target.family);
      },
      headers: {
        'User-Agent': 'PersonaAgent/0.1 (public-page reader)',
        Accept: 'text/html, application/xhtml+xml, text/plain;q=0.9',
        'Accept-Encoding': 'identity',
      },
      maxHeaderSize: 16384,
    }, resolve);
    req.once('error', reject);
    req.end();
  });

  const status = response.statusCode;
  if ([301, 302, 303, 307, 308].includes(status)) {
    response.destroy();
    if (redirects >= 3 || !response.headers.location) throw new Error('网页跳转过多或目标无效。');
    return requestPage(new URL(response.headers.location, url).href, signal, redirects + 1, maxText);
  }
  if (status < 200 || status >= 300) {
    response.destroy();
    if ([401, 403].includes(status)) throw new Error('网页拒绝公开访问；此版本不支持登录或绕过访问验证。');
    throw new Error(`网页读取失败（HTTP ${status}）。`);
  }
  const type = String(response.headers['content-type'] || '').toLowerCase();
  const mediaType = type.split(';')[0].trim();
  if (!['text/html', 'application/xhtml+xml', 'text/plain'].includes(mediaType)) {
    response.destroy();
    throw new Error('仅支持 HTML 网页和纯文本，不能读取下载文件或音视频。');
  }
  const encoding = response.headers['content-encoding'];
  if (encoding && encoding.toLowerCase() !== 'identity') {
    response.destroy();
    throw new Error('网站未提供本阅读器支持的正文编码。');
  }
  if (Number(response.headers['content-length']) > MAX_BYTES) {
    response.destroy();
    throw new Error('网页正文超过 2 MB，已停止读取。');
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response) {
    total += chunk.length;
    if (total > MAX_BYTES) {
      response.destroy();
      throw new Error('网页正文超过 2 MB，已停止读取。');
    }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const declaredCharset = type.match(/charset\s*=\s*["']?([^;\s"']+)/)?.[1];
  const metaCharset = mediaType !== 'text/plain'
    ? bytes.subarray(0, 2048).toString('latin1').match(/<meta\b[^>]*charset\s*=\s*["']?([\w-]+)/i)?.[1]
    : null;
  let body;
  try { body = new TextDecoder(declaredCharset || metaCharset || 'utf-8').decode(bytes); }
  catch { throw new Error('网站使用了本阅读器不支持的字符编码。'); }
  let article;
  if (mediaType === 'text/plain') {
    const fullText = body.trim();
    const text = fullText.slice(0, maxText);
    if (!text) throw new Error('网页正文为空，未记录阅读经历。');
    article = { title: url.hostname, text, excerpt: text.slice(0, 300), truncated: fullText.length > maxText };
  } else {
    article = extractArticle(body, url.href, { maxText });
  }
  return { url: url.href, ...article, readAt: new Date().toISOString() };
}

export async function readPage(url, { maxText = MAX_TEXT } = {}) {
  if (!Number.isSafeInteger(maxText) || maxText < 1 || maxText > 1000000) throw new Error('正文长度限制无效。');
  checkedUrl(url);
  if (isHeyboxPostUrl(url)) return readHeyboxPost(url, { maxText });
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('网页读取超过 20 秒，已停止。');
      controller.abort(error);
      reject(error);
    }, TIMEOUT_MS);
  });
  try { return await Promise.race([requestPage(url, controller.signal, 0, maxText), deadline]); }
  finally { clearTimeout(timer); }
}
