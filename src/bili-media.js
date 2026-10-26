import { createHash } from 'node:crypto';
import { lookup as lookupAddress } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import { biliVideoUrl } from './bili-reading.js';
import { normalizeBiliCredentials } from './bili-credentials.js';
import { isPublicAddress, proxyPublicAddresses } from './public-fetch.js';
import { normalizeBiliVideoSettings } from './bili-video-settings.js';

const MiB = 1024 * 1024, trackLimit = 64 * MiB, sourceLimit = 96 * MiB;
const object = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const messages = {
  INVALID: 'B站视频任务参数无效。', DISABLED: 'B站视频理解尚未启用。', BUSY: '已有 B站媒体读取任务运行。',
  CANCELLED: 'B站媒体读取已取消。', SOURCE_CHANGED: 'B站视频来源或本机配置已变化。', INVALID_SOURCE: 'B站视频来源无法核验。',
  CREDENTIAL_INVALID: 'B站只读登录状态无效。', NETWORK_FAILED: 'B站媒体读取失败，未自动重试。',
  ADDRESS_DENIED: 'B站媒体地址未通过安全核验。', SOURCE_TOO_LARGE: 'B站媒体超过本次大小限制。',
  BUDGET_EXHAUSTED: '今日 B站媒体读取额度不足。', INVALID_BUDGET: 'B站媒体额度记录无法核验。',
  TRACK_UNAVAILABLE: '本视频没有可用的受支持媒体轨。', ALREADY_ATTEMPTED: '本媒体轨已经尝试读取，未自动重试。',
  VERIFICATION_REQUIRED: 'B站要求人工核验或限制了访问，请在官方页面核对后再试。',
  PERSISTENT_PAUSE: 'B站媒体读取仍处于暂停状态，请先在官网完成核验，再由创建人恢复。',
};
function failure(code) { return Object.assign(new Error(messages[code] || messages.NETWORK_FAILED), { code }); }
function text(value, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || !value.isWellFormed()
    || /[\x00-\x1f\x7f]/.test(value)) throw failure('INVALID_SOURCE');
  return value;
}
function duration(value) {
  if (!Number.isFinite(value) || value <= 0 || value > 12 * 60 * 60) throw failure('INVALID_SOURCE');
  return value;
}
function mediaUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 8192) throw failure('ADDRESS_DENIED');
  let url;
  try { url = new URL(value); } catch { throw failure('ADDRESS_DENIED'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
    || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*bilivideo\.(?:com|cn)$/.test(url.hostname)
    || url.hostname === 'bilivideo.cn' || url.hostname.endsWith('.bilivideo.cn') && !url.hostname.endsWith('.mcdn.bilivideo.cn')) {
    throw failure('ADDRESS_DENIED');
  }
  return url.href;
}

function trackUrl(track) {
  const backups = track.backupUrl ?? track.backup_url;
  const candidates = [track.baseUrl ?? track.base_url, ...(Array.isArray(backups) ? backups.slice(0, 16) : [])];
  for (const candidate of candidates) {
    try { return mediaUrl(candidate); }
    catch (error) { if (error.code !== 'ADDRESS_DENIED') throw error; }
  }
  throw failure('ADDRESS_DENIED');
}

// The default connection uses the already verified address. A second DNS lookup cannot change its target.
function nativeFetch(url, { headers, signal, address }) {
  return new Promise((accept, reject) => {
    let response, settled = false;
    const req = https.request(url, { method: 'GET', headers, signal, agent: false,
      family: address.family, autoSelectFamily: false, maxHeaderSize: 16384,
      lookup: (_host, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family) }, value => {
      response = value;
      value.on('error', () => {});
      settled = true;
      accept({ status: value.statusCode, headers: new Headers(Object.entries(value.headers)
        .flatMap(([key, item]) => item === undefined ? [] : [[key, Array.isArray(item) ? item.join(', ') : String(item)]])),
      redirected: false, body: value, dispose: async () => { value.destroy(); req.destroy(); await closed; } });
    });
    const closed = new Promise(resolve => req.once('close', resolve));
    req.once('error', error => {
      if (!settled) { settled = true; void closed.then(() => reject(error)); }
      else response?.destroy(error);
    });
    req.end();
  });
}

export function createBiliMedia({ store, dataDir, getCredentials, fetchImpl = nativeFetch, lookup = lookupAddress, resolveProxy = proxyPublicAddresses }) {
  if (!store || typeof store.getSetting !== 'function' || typeof store.setSetting !== 'function'
    || typeof dataDir !== 'string' || !dataDir.trim() || typeof getCredentials !== 'function'
    || typeof fetchImpl !== 'function' || typeof lookup !== 'function' || typeof resolveProxy !== 'function') throw failure('INVALID');
  let busy = false, current;
  const sources = new Map();
  const settings = () => normalizeBiliVideoSettings({}, store.getSetting('biliVideo', {}));
  function statusPause() {
    const value = store.getSetting('biliVideoPause', null);
    if (value === null) return null;
    if (!object(value) || Reflect.ownKeys(value).length !== 2 || !Object.hasOwn(value, 'code') || !Object.hasOwn(value, 'at') || value.code !== 'VERIFICATION_REQUIRED'
      || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at)) || new Date(value.at).toISOString() !== value.at) {
      return { code: 'INVALID_PAUSE', at: null };
    }
    return { code: value.code, at: value.at };
  }
  function checkPause() { if (statusPause()) throw failure('PERSISTENT_PAUSE'); }
  function verificationRequired() {
    store.setSetting('biliVideoPause', { code: 'VERIFICATION_REQUIRED', at: new Date().toISOString() });
    throw failure('VERIFICATION_REQUIRED');
  }
  function credentials() {
    try {
      const raw = getCredentials();
      if (raw === null || raw === undefined) return null;
      const { sessdata, accountId } = normalizeBiliCredentials(raw); return { sessdata, accountId };
    }
    catch { throw failure('CREDENTIAL_INVALID'); }
  }
  function reserve(kind, amount, config) {
    if (!Number.isSafeInteger(amount) || amount < 0) throw failure('INVALID_BUDGET');
    const day = new Date().toISOString().slice(0, 10), saved = store.getSetting('biliVideoStatus', {});
    const usage = saved?.day === day ? saved : { day, downloadBytes: 0, audioSeconds: 0 };
    if (!object(usage) || !Number.isSafeInteger(usage.downloadBytes) || usage.downloadBytes < 0
      || !Number.isSafeInteger(usage.audioSeconds) || usage.audioSeconds < 0) throw failure('INVALID_BUDGET');
    const limit = kind === 'downloadBytes' ? config.dailyDownloadMiB * MiB : config.dailyAudioSeconds;
    if (usage[kind] + amount > limit) throw failure('BUDGET_EXHAUSTED');
    const next = { day, downloadBytes: usage.downloadBytes, audioSeconds: usage.audioSeconds, [kind]: usage[kind] + amount };
    if (amount) store.setSetting('biliVideoStatus', next);
    return { ...next };
  }
  function options(input = {}) {
    if (!object(input) || Reflect.ownKeys(input).some(key => !['signal', 'assertActive'].includes(key))
      || input.signal !== undefined && !(input.signal instanceof AbortSignal)
      || input.assertActive !== undefined && typeof input.assertActive !== 'function') throw failure('INVALID');
    return input;
  }
  function active(entry, input) {
    if (input.signal?.aborted) throw failure('CANCELLED');
    try { input.assertActive?.(); } catch { throw failure('SOURCE_CHANGED'); }
    checkPause();
    if (!settings().enabled) throw failure('DISABLED');
    if (JSON.stringify(settings()) !== entry.settings || JSON.stringify(credentials()) !== entry.credentials) throw failure('SOURCE_CHANGED');
  }
  async function request(url, entry, input, maxBytes, api = false) {
    active(entry, input);
    const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(api ? 20000 : 90000)])
      : AbortSignal.timeout(api ? 20000 : 90000);
    const check = () => { if (signal.aborted) throw failure('CANCELLED'); active(entry, input); };
    let response;
    try {
      let abortLookup;
      const cancelled = new Promise((_, reject) => { abortLookup = () => reject(failure('CANCELLED')); signal.addEventListener('abort', abortLookup, { once: true }); });
      let addresses;
      try { addresses = await Promise.race([lookup(url.hostname, { all: true, verbatim: true }), cancelled]); }
      finally { signal.removeEventListener('abort', abortLookup); }
      check();
      // Transparent proxies can answer with benchmark-range fake IPs. Resolve only this
      // fixed API or the selected manifest target through the same audited public DNS path.
      if (Array.isArray(addresses) && addresses.length && addresses.every(item => object(item)
        && item.family === 4 && isIP(item.address) === 4 && /^198\.(?:18|19)\./.test(item.address))) {
        if (api ? url.hostname !== 'api.bilibili.com' : mediaUrl(url.href) !== url.href) throw failure('ADDRESS_DENIED');
        addresses = await resolveProxy(url.hostname, signal);
        check();
      }
      if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => !object(item)
        || ![4, 6].includes(item.family) || isIP(item.address) !== item.family || !isPublicAddress(item.address))) throw failure('ADDRESS_DENIED');
      const address = addresses.find(item => item.family === 4) || addresses[0];
      const headers = { 'User-Agent': 'Memoria/0.3 (Bilibili media reader)', Referer: 'https://www.bilibili.com/', 'Accept-Encoding': 'identity' };
      if (api && entry.secret) headers.Cookie = `SESSDATA=${entry.secret.sessdata}`;
      response = await fetchImpl(url.href, { method: 'GET', redirect: 'error', credentials: 'omit', headers, signal, address });
      check();
      if (!response || response.redirected || response.status >= 300 && response.status < 400) throw failure('ADDRESS_DENIED');
      if ([401, 403, 412, 429, 567].includes(response.status)) verificationRequired();
      if (response.status !== 200 || !response.headers || typeof response.headers.get !== 'function' || !response.body) throw failure('NETWORK_FAILED');
      const encoding = response.headers.get('content-encoding');
      if (encoding && encoding !== 'identity') throw failure('NETWORK_FAILED');
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maxBytes)) throw failure('SOURCE_TOO_LARGE');
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        check();
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > maxBytes) throw failure('SOURCE_TOO_LARGE');
        chunks.push(bytes);
      }
      check();
      if (declared !== null && Number(declared) !== size) throw failure('NETWORK_FAILED');
      return Buffer.concat(chunks);
    } catch (error) {
      if (signal.aborted || input.signal?.aborted) throw failure('CANCELLED');
      if (Object.hasOwn(messages, error?.code)) throw failure(error.code);
      throw failure('NETWORK_FAILED');
    } finally {
      try {
        if (response?.dispose) await response.dispose();
        else if (response?.body?.cancel) await response.body.cancel().catch(() => {});
        else response?.body?.destroy?.();
      } catch { throw failure('NETWORK_FAILED'); }
    }
  }
  async function api(path, params, entry, input) {
    const url = new URL(path, 'https://api.bilibili.com');
    url.search = new URLSearchParams(params).toString();
    const bytes = await request(url, entry, input, 4 * MiB, true);
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw failure('INVALID_SOURCE'); }
    if (!object(value) || value.code !== 0 || !object(value.data)) {
      if ([-101, -111, -352, -412, -509, -403].includes(value?.code) || /captcha|验证码|风控/i.test(String(value?.message || ''))) verificationRequired();
      throw failure('INVALID_SOURCE');
    }
    if (value.data.v_voucher) verificationRequired();
    return value.data;
  }
  return {
    async inspect(canonicalUrl, input = {}) {
      options(input);
      if (typeof canonicalUrl !== 'string' || biliVideoUrl(canonicalUrl) !== canonicalUrl) throw failure('INVALID');
      if (busy) throw failure('BUSY');
      checkPause();
      busy = true; current = undefined; sources.clear();
      try {
        const config = settings(), secret = credentials();
        const entry = { settings: JSON.stringify(config), credentials: JSON.stringify(secret), secret, tracks: {}, downloaded: new Map(), attempted: new Set(), bytes: 0 };
        active(entry, input);
        const target = new URL(canonicalUrl), bvid = target.pathname.split('/')[2], page = Number(target.searchParams.get('p'));
        const metadata = await api('/x/web-interface/view', { bvid }, entry, input);
        if (metadata.bvid !== bvid || !Array.isArray(metadata.pages) || !metadata.pages.length || metadata.pages.length > 1000) throw failure('INVALID_SOURCE');
        const matches = metadata.pages.filter(part => part?.page === page);
        if (matches.length !== 1 || !Number.isSafeInteger(matches[0].cid) || matches[0].cid <= 0) throw failure('INVALID_SOURCE');
        const part = matches[0], durationSeconds = duration(part.duration);
        const title = text(metadata.title, 500), author = text(metadata.owner?.name, 200);
        const play = await api('/x/player/playurl', { bvid, cid: String(part.cid), qn: '32', fnval: '16', fourk: '0' }, entry, input);
        if (play.bvid !== undefined && play.bvid !== bvid || play.cid !== undefined && play.cid !== part.cid) throw failure('INVALID_SOURCE');
        const videos = Array.isArray(play.dash?.video) ? play.dash.video : [], audios = Array.isArray(play.dash?.audio) ? play.dash.audio : [];
        if (videos.length > 100 || audios.length > 100) throw failure('INVALID_SOURCE');
        const video = videos.filter(track => object(track) && Number.isInteger(track.id) && track.id > 0 && track.id <= 32
          && Number.isInteger(track.width) && track.width > 0 && track.width <= 1920 && Number.isInteger(track.height) && track.height > 0 && track.height <= 1920
          && Math.min(track.width, track.height) <= 480 && track.width * track.height <= 480 * 1920
          && (track.mimeType ?? track.mime_type) === 'video/mp4' && /^avc1\.[0-9a-f]+$/i.test(track.codecs)
          && track.codecid === 7 && Number.isFinite(track.bandwidth) && track.bandwidth > 0 && track.bandwidth <= 20000000)
          .sort((a, b) => Math.min(b.width, b.height) - Math.min(a.width, a.height) || a.bandwidth - b.bandwidth)[0];
        const audio = audios.filter(track => object(track) && (track.mimeType ?? track.mime_type) === 'audio/mp4'
          && /^mp4a\.40\.\d+$/.test(track.codecs) && Number.isFinite(track.bandwidth) && track.bandwidth > 0 && track.bandwidth <= 2000000)
          .sort((a, b) => a.bandwidth - b.bandwidth)[0];
        if (video) entry.tracks.video = trackUrl(video);
        if (audio) entry.tracks.audio = trackUrl(audio);
        if (!video && !audio) throw failure('TRACK_UNAVAILABLE');
        active(entry, input);
        const source = Object.freeze({ url: canonicalUrl, bvid, page, cid: part.cid, title, author, durationSeconds, hasVideo: Boolean(video), hasAudio: Boolean(audio) });
        sources.set(source, entry); current = source;
        return source;
      } finally { busy = false; }
    },
    async download(source, kind, input = {}) {
      options(input);
      if (!['video', 'audio'].includes(kind) || !sources.has(source) || source !== current) throw failure('INVALID_SOURCE');
      if (busy) throw failure('BUSY');
      busy = true;
      const entry = sources.get(source);
      try {
        active(entry, input);
        if (!entry.tracks[kind]) throw failure('TRACK_UNAVAILABLE');
        if (entry.downloaded.has(kind)) { const cached = entry.downloaded.get(kind); return { bytes: Buffer.from(cached.bytes), sha256: cached.sha256 }; }
        if (entry.attempted.has(kind)) throw failure('ALREADY_ATTEMPTED');
        const maximum = Math.min(trackLimit, sourceLimit - entry.bytes);
        if (maximum <= 0) throw failure('SOURCE_TOO_LARGE');
        // Reserve the maximum before opening the socket. Failed/cancelled reads are never refunded.
        reserve('downloadBytes', maximum, settings());
        entry.attempted.add(kind);
        const bytes = await request(new URL(entry.tracks[kind]), entry, input, maximum);
        active(entry, input);
        if (!bytes.length) throw failure('INVALID_SOURCE');
        entry.bytes += bytes.length;
        const result = { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
        entry.downloaded.set(kind, result);
        return { bytes: Buffer.from(bytes), sha256: result.sha256 };
      } finally { busy = false; }
    },
    reserveAudio(seconds) {
      checkPause();
      const entry = sources.get(current);
      if (!entry) throw failure('INVALID_SOURCE');
      active(entry, {});
      const config = settings();
      if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > config.audioSeconds) throw failure('INVALID_BUDGET');
      return reserve('audioSeconds', seconds, config);
    },
    statusPause,
    resume(input) {
      if (!object(input) || Reflect.ownKeys(input).length !== 1 || !Object.hasOwn(input, 'confirmed') || input.confirmed !== true) throw failure('INVALID');
      if (busy) throw failure('BUSY');
      store.setSetting('biliVideoPause', null);
      return { resumed: true };
    },
    release(source) {
      const entry = sources.get(source);
      if (!entry) return false;
      if (busy) throw failure('BUSY');
      entry.downloaded.clear(); entry.tracks = {}; entry.secret = null;
      sources.delete(source);
      if (current === source) current = undefined;
      return true;
    },
  };
}
