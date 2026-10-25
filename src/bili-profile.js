import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { normalizeBiliCredentials } from './bili-credentials.js';
import { parseBiliJson } from './bili-social-notice.js';

const endpoints = Object.freeze({
  nav: 'https://api.bilibili.com/x/web-interface/nav',
  account: 'https://api.bilibili.com/x/member/web/account',
  policy: 'https://api.bilibili.com/x/member/uname/update/message',
  avatar: 'https://api.bilibili.com/x/member/web/face/update',
  nickname: 'https://api.bilibili.com/x/member/web/update',
  signature: 'https://api.bilibili.com/x/member/web/sign/update'
});
const capabilities = Object.freeze({ avatar: true, nickname: true, signature: true });
const avatarIds = new Set(['hello', 'happy', 'thinking', 'comfort']);
const object = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fields = (value, allowed) => object(value) && Reflect.ownKeys(value).every(key => allowed.includes(key));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const messages = {
  INVALID: 'B站资料操作参数无效。', CREDENTIAL_INVALID: 'B站资料操作需要重新导入专用账号登录状态。',
  ACCOUNT_CHANGED: 'B站登录账号或登录状态已变化，本次已停止。', SOURCE_CHANGED: 'B站资料已变化，本次未覆盖现有资料。',
  ASSET_CHANGED: '内置头像素材无法核对，本次未上传。', PLATFORM_PAUSED: 'B站操作已暂停，请在本机核对账号和平台状态。',
  VERIFICATION_REQUIRED: 'B站要求人工验证，请在官方页面完成验证后再操作。', CANCELLED: 'B站资料任务已取消。',
  BUSY: '已有 B站资料任务运行。', FAILED: 'B站资料操作未完成，未自动重试。'
};
function failure(code) { const error = new Error(messages[code] || messages.FAILED); error.code = code; return error; }
function avatarUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
      || !/^(?:i[0-2]|static|face)\.hdslb\.com$/.test(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}
function textValue(value, max, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())
    || !value.isWellFormed() || /[\x00-\x1f\x7f]/.test(value)) throw failure('INVALID');
  return value;
}

// This executor deliberately has no dependency on the DSH social plugin or its broker.
export function createBiliProfileRuntime({ dataDir, getCredentials, getAvatar, fetcher = globalThis.fetch }) {
  if (typeof dataDir !== 'string' || !dataDir.trim() || typeof getCredentials !== 'function'
    || typeof getAvatar !== 'function' || typeof fetcher !== 'function') throw failure('INVALID');
  const directory = resolve(dataDir), pausePath = join(directory, 'bili-social-pause.json');
  const confirmedAvatars = new Map();
  let busy = false, stopped = false, cancelCurrent, drained = Promise.resolve();
  function credentials(write = false) {
    try {
      const value = normalizeBiliCredentials(getCredentials());
      if (write && !value.biliJct) throw new Error();
      return value;
    } catch { throw failure('CREDENTIAL_INVALID'); }
  }
  function paused() {
    if (!existsSync(pausePath)) return false;
    try { return JSON.parse(readFileSync(pausePath, 'utf8')).paused !== false; } catch { return true; }
  }
  function pause() {
    mkdirSync(directory, { recursive: true });
    const temporary = `${pausePath}.${process.pid}.profile.tmp`;
    writeFileSync(temporary, JSON.stringify({ paused: true, at: new Date().toISOString() }), { mode: 0o600 });
    renameSync(temporary, pausePath);
  }
  function status() {
    const result = { available: false, busy, capabilities, paused: paused(), error: null };
    try {
      credentials(true);
      if (stopped) throw failure('CANCELLED');
      if (result.paused) throw failure('PLATFORM_PAUSED');
      result.available = true;
    } catch (error) { result.error = messages[error.code] || messages.FAILED; }
    return result;
  }
  async function run(operation, input) {
    const write = operation === 'change';
    let action, value, avatarId;
    if (!fields(input, write ? ['action', 'value', 'avatarId', 'expectedAvatarHash', 'signal', 'beforeSend', 'assertActive'] : ['signal'])
      || (input.signal !== undefined && !(input.signal instanceof AbortSignal))) throw failure('INVALID');
    if (write) {
      ({ action, value, avatarId } = input);
      if (!Object.hasOwn(capabilities, action) || typeof input.beforeSend !== 'function'
        || (input.assertActive !== undefined && typeof input.assertActive !== 'function')) throw failure('INVALID');
      if (action === 'avatar') {
        if (!avatarIds.has(avatarId) || Object.hasOwn(input, 'value') || (input.expectedAvatarHash !== undefined
          && (typeof input.expectedAvatarHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedAvatarHash)))) throw failure('INVALID');
      } else {
        if (Object.hasOwn(input, 'avatarId') || Object.hasOwn(input, 'expectedAvatarHash')) throw failure('INVALID');
        value = textValue(value, action === 'nickname' ? 16 : 80, action === 'signature');
        if (action === 'nickname' && value.length < 2) throw failure('INVALID');
      }
    }
    if (stopped) throw failure('CANCELLED');
    if (busy) throw failure('BUSY');
    if (paused()) throw failure('PLATFORM_PAUSED');
    const secret = credentials(write), snapshot = JSON.stringify(secret);
    const controller = new AbortController();
    let finish, attempted = false, accepted = false, rejected = false, requests = 0;
    let asset, baseline, responseFace, beforeFace;
    busy = true; drained = new Promise(accept => { finish = accept; });
    const abort = () => controller.abort();
    cancelCurrent = abort;
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    const timeout = setTimeout(abort, 120000);
    const active = () => {
      if (controller.signal.aborted || stopped) throw failure('CANCELLED');
      if (paused()) throw failure('PLATFORM_PAUSED');
      if (JSON.stringify(credentials(write)) !== snapshot) throw failure('ACCOUNT_CHANGED');
      input.assertActive?.();
    };
    const result = (outcome, extra = {}) => ({ action, outcome, ...(action === 'avatar' ? { avatarId } : { value }), ...extra });
    const cookie = `SESSDATA=${secret.sessdata}${secret.biliJct ? `; bili_jct=${secret.biliJct}` : ''}${secret.buvid3 ? `; buvid3=${secret.buvid3}` : ''}`;
    const cleanMessage = raw => typeof raw === 'string' ? raw.replace(/<[^>]*>/g, '').replace(/[\x00-\x1f\x7f]/g, ' ')
      .replaceAll(secret.sessdata, '[已隐藏]').replaceAll(secret.biliJct || '\0', '[已隐藏]')
      .replace(/\d{6,}/g, '[已隐藏]').slice(0, 240).trim() : '';
    async function request(key, body) {
      active();
      if (++requests > 24 || !Object.hasOwn(endpoints, key)) throw failure('FAILED');
      const post = body !== undefined;
      const url = key === 'avatar' ? `${endpoints.avatar}?csrf=${secret.biliJct}` : endpoints[key];
      if (post) attempted = true;
      const response = await fetcher(url, { method: post ? 'POST' : 'GET', redirect: 'manual', credentials: 'omit',
        headers: { 'User-Agent': 'memoria-bili-profile/1', Referer: 'https://account.bilibili.com/', Cookie: cookie,
          ...(post ? { Origin: 'https://account.bilibili.com', ...(body instanceof URLSearchParams
            ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) } : {}) },
        ...(post ? { body } : {}), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
      if ([401, 412, 429].includes(response.status)) {
        await response.body?.cancel().catch(() => {}); pause(); throw failure('VERIFICATION_REQUIRED');
      }
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        await response.body?.cancel().catch(() => {}); throw failure('FAILED');
      }
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 1024 * 1024) throw failure('FAILED');
        chunks.push(chunk);
      }
      const parsed = parseBiliJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      if ([-412, -352, -799, -509, -10403, -101, -105, 12015, 61001, 61002].includes(Number(parsed?.code))) {
        pause(); throw failure('VERIFICATION_REQUIRED');
      }
      active();
      if (!response.ok || !object(parsed) || !Number.isSafeInteger(parsed.code)) throw failure('FAILED');
      return parsed;
    }
    async function readProfile() {
      const nav = await request('nav');
      if (nav.code !== 0 || nav.data?.isLogin !== true || String(nav.data.mid) !== secret.accountId) throw failure('ACCOUNT_CHANGED');
      const account = await request('account');
      if (account.code !== 0 || !object(account.data) || typeof account.data.uname !== 'string' || typeof account.data.sign !== 'string') throw failure('FAILED');
      return { nickname: account.data.uname, signature: account.data.sign, avatarUrl: avatarUrl(nav.data.face),
        birthday: account.data.birthday, sex: account.data.sex, nickFree: account.data.nick_free };
    }
    async function readPolicy(profile) {
      const body = await request('policy');
      if (body.code !== 0 || !object(body.data)) throw failure('FAILED');
      const allowed = body.data.allow === true || body.data.allow === 1;
      const free = profile.nickFree === true || profile.nickFree === 1;
      return { allowed, free, requiredCoins: free ? 0 : null,
        message: [cleanMessage(body.data.uname_message), cleanMessage(body.data.confirm_message)].filter(Boolean).join(' ').slice(0, 400) };
    }
    async function readAsset() {
      const current = await getAvatar(avatarId);
      active();
      if (!fields(current, ['bytes', 'mimeType', 'sha256']) || !Buffer.isBuffer(current.bytes)
        || current.mimeType !== 'image/png' || current.bytes.length < 24 || current.bytes.length > 2 * 1024 * 1024
        || typeof current.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(current.sha256)
        || !current.bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw failure('ASSET_CHANGED');
      const bytes = Buffer.from(current.bytes), sha256 = digest(bytes);
      if (sha256 !== current.sha256 || (asset && sha256 !== asset.sha256)
        || (input.expectedAvatarHash !== undefined && sha256 !== input.expectedAvatarHash)) throw failure('ASSET_CHANGED');
      return { bytes, sha256 };
    }
    function unchanged(profile) {
      return action === 'avatar' ? !!profile.avatarUrl && confirmedAvatars.get(asset.sha256) === profile.avatarUrl
        : profile[action] === value;
    }
    function preserve(profile) {
      if (profile.nickname !== baseline.nickname || profile.signature !== baseline.signature
        || (action === 'avatar' && profile.avatarUrl !== baseline.avatarUrl)
        || (action === 'nickname' && (profile.birthday !== baseline.birthday || profile.sex !== baseline.sex))) throw failure('SOURCE_CHANGED');
    }
    async function readyToWrite() {
      const fresh = await readProfile();
      if (unchanged(fresh)) return false;
      preserve(fresh);
      if (action === 'nickname') {
        if (typeof fresh.birthday !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fresh.birthday)
          || !['男', '女', '保密'].includes(fresh.sex)) throw failure('SOURCE_CHANGED');
        const policy = await readPolicy(fresh);
        if (!policy.allowed || !policy.free) throw failure('FEE_REQUIRED');
      }
      if (action === 'avatar') asset = await readAsset();
      active();
      return true;
    }
    try {
      active();
      baseline = await readProfile(); beforeFace = baseline.avatarUrl;
      if (!write) {
        let nicknamePolicy;
        try { nicknamePolicy = await readPolicy(baseline); }
        catch (error) {
          active();
          if (error.code === 'VERIFICATION_REQUIRED') throw error;
          nicknamePolicy = { allowed: false, free: false, requiredCoins: null, message: '暂时无法核对改名费用，未启用昵称修改。' };
        }
        return { profile: { nickname: baseline.nickname, signature: baseline.signature, avatarUrl: baseline.avatarUrl || '' }, nicknamePolicy };
      }
      if (action === 'avatar') asset = await readAsset();
      if (unchanged(baseline)) return result('unchanged');
      if (!await readyToWrite()) return result('unchanged');
      if (await input.beforeSend() === false) throw failure('CANCELLED');
      active();
      // Recheck after the asynchronous budget/ownership gate, before the only POST.
      if (!await readyToWrite()) return result('unchanged');
      let body;
      if (action === 'avatar') {
        body = new FormData(); body.set('dopost', 'save'); body.set('DisplayRank', '10000');
        body.set('face', new Blob([asset.bytes], { type: 'image/png' }), `${avatarId}.png`);
      } else {
        body = new URLSearchParams(action === 'signature' ? { user_sign: value, csrf: secret.biliJct }
          : { uname: value, usersign: baseline.signature, sex: baseline.sex, birthday: baseline.birthday, csrf: secret.biliJct });
      }
      active();
      const ack = await request(action, body);
      if (ack.code !== 0 || (action === 'nickname' && Number(ack.data?.code) === 40014)) {
        rejected = true;
        return result('failed', { message: action === 'avatar' && [40012, 40013].includes(ack.code)
          ? 'B站未接受头像格式或大小，本次未自动重试。' : 'B站未接受本次资料修改，未自动重试。' });
      }
      accepted = true;
      if (action === 'avatar') {
        const candidates = [ack.data?.face, ack.data?.url].filter(item => item !== undefined).map(avatarUrl);
        responseFace = candidates.length && candidates.every(item => item && item === candidates[0]) ? candidates[0] : null;
      }
      try {
        const updated = await readProfile();
        if (action !== 'avatar' && updated[action] === value) return result('updated');
        if (action === 'avatar' && responseFace && updated.avatarUrl === responseFace) {
          confirmedAvatars.set(asset.sha256, responseFace); return result('updated');
        }
        return result('submitted', action === 'avatar' ? { readbackChanged: !!updated.avatarUrl && updated.avatarUrl !== beforeFace } : {});
      } catch {
        return result('submitted', { message: 'B站已接受提交，暂未核实资料生效。' });
      }
    } catch (error) {
      if (!write) throw failure(error.code || 'FAILED');
      if (error.code === 'VERIFICATION_REQUIRED' || error.code === 'PLATFORM_PAUSED') return result('verification_required', { message: messages[error.code] });
      if (error.code === 'FEE_REQUIRED') return result('fee_required', { message: '尚未确认本次改名免费，未提交昵称修改。' });
      return result(accepted ? 'submitted' : attempted && !rejected ? 'unknown' : 'failed', { message: messages[error.code] || messages.FAILED });
    } finally {
      clearTimeout(timeout); input.signal?.removeEventListener('abort', abort); controller.abort();
      busy = false; cancelCurrent = undefined; finish();
    }
  }
  return {
    status,
    inspect: (input = {}) => run('inspect', input),
    change: async (input = {}) => {
      try { return await run('change', input); }
      catch (error) { return { action: Object.hasOwn(capabilities, input?.action) ? input.action : null,
        outcome: error.code === 'PLATFORM_PAUSED' ? 'verification_required' : 'failed', message: messages[error.code] || messages.FAILED }; }
    },
    cancel() { cancelCurrent?.(); return drained; },
    stop() { stopped = true; cancelCurrent?.(); return drained; }
  };
}
