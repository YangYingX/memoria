import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';

export function isPublicAddress(address) {
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
    const [first, second = '0'] = address.toLowerCase().split(':');
    const a = Number.parseInt(first, 16), b = Number.parseInt(second || '0', 16);
    return a >= 0x2000 && a <= 0x3fff
      && !(a === 0x2001 && (b < 0x0200 || b === 0x0db8))
      && a !== 0x2002 && !(a === 0x3fff && b <= 0x0fff);
  }
  return false;
}

export function assertPublicUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('公开地址无效。');
  let url;
  try { url = new URL(value); } catch { throw new Error('公开地址无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('仅允许不含登录凭据的 HTTP 或 HTTPS 地址。');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('仅允许 80 和 443 端口。');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && !isPublicAddress(host))) throw new Error('不能访问本机、内网或保留地址。');
  url.hash = '';
  return url;
}

const proxyDnsHosts = new Set(['www.xiaoheihe.cn', 'api.xiaoheihe.cn', 'static.max-c.com', 'static.portal101.cn']);
const proxyDnsCache = new Map();

async function proxyPublicAddresses(host, signal) {
  const cached = proxyDnsCache.get(host);
  signal.throwIfAborted();
  if (cached?.expiresAt > Date.now()) return cached.addresses;
  try {
    const active = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
    const url = new URL('https://dns.google/resolve');
    url.searchParams.set('name', host);
    url.searchParams.set('type', 'A');
    url.searchParams.set('edns_client_subnet', '0.0.0.0/0');
    const response = await fetch(url, { method: 'GET', redirect: 'error', signal: active,
      headers: { Accept: 'application/dns-json' } });
    if (!response.ok || response.redirected) { await response.body?.cancel(); throw new Error(); }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      active.throwIfAborted();
      size += chunk.length;
      if (size > 16384) throw new Error();
      chunks.push(chunk);
    }
    active.throwIfAborted();
    const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    const name = value => {
      if (typeof value !== 'string') throw new Error();
      const normalized = value.toLowerCase().replace(/\.$/, '');
      if (normalized.length > 253 || !normalized.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error();
      return normalized;
    };
    if (result?.Status !== 0 || result.TC !== false || result.CD === true || !Array.isArray(result.Question)
      || result.Question.length !== 1 || result.Question[0].type !== 1 || name(result.Question[0].name) !== host
      || !Array.isArray(result.Answer) || !result.Answer.length || result.Answer.length > 64) throw new Error();
    const records = result.Answer.filter(record => record && [1, 5].includes(record.type));
    for (const record of records) {
      name(record.name);
      if (!Number.isSafeInteger(record.TTL) || record.TTL < 0 || record.TTL > 2147483647
        || (record.type === 1 && (isIP(record.data) !== 4 || !isPublicAddress(record.data)))) throw new Error();
    }
    const visited = new Set(), ttls = [];
    let current = host;
    for (let depth = 0; depth < 8; depth++) {
      if (visited.has(current)) throw new Error();
      visited.add(current);
      const entries = records.filter(record => name(record.name) === current);
      const aliases = entries.filter(record => record.type === 5), addresses = entries.filter(record => record.type === 1);
      if (addresses.length && !aliases.length) {
        const values = [...new Set(addresses.map(record => record.data))].map(address => ({ address, family: 4 }));
        const ttl = Math.min(60, ...ttls, ...addresses.map(record => record.TTL));
        if (ttl > 0) proxyDnsCache.set(host, { expiresAt: Date.now() + ttl * 1000, addresses: values });
        return values;
      }
      if (aliases.length !== 1 || addresses.length) throw new Error();
      ttls.push(aliases[0].TTL);
      current = name(aliases[0].data);
    }
    throw new Error();
  } catch {
    throw new Error('域名无法取得经过核验的公网地址。');
  }
}

// DNS is resolved once per hop and pinned to the actual connection, including browser subresources.
export async function fetchPublicResource(value, { signal, maxBytes = 2 * 1024 * 1024, timeoutMs = 20000, maxRedirects = 3, allowUrl, headers = {}, proxyDns = false } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 20 * 1024 * 1024) throw new Error('下载大小限制无效。');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('下载时限无效。');
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 3) throw new Error('跳转次数限制无效。');
  if (typeof proxyDns !== 'boolean') throw new Error('代理 DNS 选项无效。');
  const initialOrigin = assertPublicUrl(value).origin;
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('下载超时，已停止。')); }, timeoutMs);
  });
  let onAbort;
  const canceled = new Promise((_, reject) => {
    onAbort = () => reject(new Error('下载已取消或超时。'));
    if (combined.aborted) onAbort();
    else combined.addEventListener('abort', onAbort, { once: true });
  });
  async function request(input, redirects) {
    combined.throwIfAborted();
    const url = assertPublicUrl(input);
    if (allowUrl && allowUrl(url) !== true) throw new Error('地址超出允许访问的范围。');
    const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
    let addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true });
    combined.throwIfAborted();
    if (proxyDns && proxyDnsHosts.has(host) && addresses.length
      && addresses.every(item => isIP(item.address) === 4 && /^198\.(?:18|19)\./.test(item.address))) {
      addresses = await proxyPublicAddresses(host, combined);
      combined.throwIfAborted();
    }
    if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error('域名指向本机、内网或保留地址。');
    const target = addresses.find(item => item.family === 4) || addresses[0];
    const safeHeaders = Object.fromEntries(Object.entries(headers).filter(([key]) => !/^(host|connection|content-length|transfer-encoding|authorization|proxy-authorization|cookie|accept-encoding)$/i.test(key) && !(key.toLowerCase() === 'referer' && url.origin !== initialOrigin)));
    const connect = () => new Promise((resolve, reject) => {
      const req = (url.protocol === 'https:' ? https : http).request({
        protocol: url.protocol, hostname: host, port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search, method: 'GET', agent: false, family: target.family,
        autoSelectFamily: false, signal: combined, maxHeaderSize: 16384,
        lookup: (_name, options, callback) => options.all ? callback(null, [target]) : callback(null, target.address, target.family),
        headers: { 'User-Agent': 'Memoria/0.3 (public content reader)', Accept: '*/*', ...safeHeaders, 'Accept-Encoding': 'identity' },
      }, resolve);
      req.once('error', reject);
      req.end();
    });
    let response;
    try { response = await connect(); }
    catch (error) {
      // A reset before response headers carries no body and is safe to retry once.
      if (!proxyDns || !proxyDnsHosts.has(host) || error.code !== 'ECONNRESET' || combined.aborted) throw error;
      response = await connect();
    }
    try {
      const status = response.statusCode;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.destroy();
        if (redirects >= maxRedirects || !response.headers.location) throw new Error('跳转过多或目标无效。');
        let next;
        try { next = new URL(response.headers.location, url).href; } catch { throw new Error('跳转目标无效。'); }
        return request(next, redirects + 1);
      }
      if (status < 200 || status >= 300) throw new Error(`下载失败（HTTP ${status}）。`);
      if (Number(response.headers['content-length']) > maxBytes) throw new Error('下载内容超过大小限制。');
      const chunks = []; let size = 0;
      for await (const chunk of response) {
        size += chunk.length;
        if (size > maxBytes) throw new Error('下载内容超过大小限制。');
        chunks.push(chunk);
      }
      let bytes = Buffer.concat(chunks);
      const encoding = String(response.headers['content-encoding'] || 'identity').toLowerCase();
      if (encoding !== 'identity') {
        const decode = { gzip: gunzipSync, deflate: inflateSync, br: brotliDecompressSync }[encoding];
        if (!decode) throw new Error('下载内容编码不受支持。');
        try { bytes = decode(bytes, { maxOutputLength: maxBytes }); } catch { throw new Error('下载内容解压失败或超过大小限制。'); }
      }
      const resultHeaders = Object.fromEntries(Object.entries(response.headers).filter(([key]) => !['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie'].includes(key)));
      return { url: url.href, status, headers: resultHeaders, bytes };
    } finally { response.destroy(); }
  }
  try { return await Promise.race([request(value, 0), deadline, canceled]); }
  catch (error) {
    // Never put signed image URLs, cookies or network diagnostics into durable error events.
    if (signal?.aborted || combined.aborted) throw new Error('下载已取消或超时。');
    if (/^(公开地址|仅允许|不能访问|地址超出|域名指向|跳转|下载)/.test(error.message)) throw error;
    throw new Error('无法连接到公开内容服务器。');
  } finally { clearTimeout(timer); combined.removeEventListener('abort', onAbort); }
}
