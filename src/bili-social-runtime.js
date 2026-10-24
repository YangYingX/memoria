import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, realpathSync, lstatSync, statSync, mkdtempSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { normalizeBiliCredentials } from './bili-credentials.js';
import { biliSocialId, normalizeNotice, biliMentionFeed, biliDynamicId, biliDynamicFeed, biliCommentKey, parseBiliJson } from './bili-social-notice.js';

export const biliSocialPins = Object.freeze({ version: '0.7.7', commit: 'bbe41848137cdfa334bf04ebe7d5d29830390923',
  archive: 'd9d86e16e9fca9ddf34c65f4e56a817de014f98bd8a9665ee608d9148401cf2a',
  client: '7f4c02f597322a69b997666172a74317d3dff3aaac8bb1353b6f97d2e94038b6',
  server: '06d077b95fd12b26802545c4dc690fff81a651c86f53c57c911f22516ee6dd51' });
const capabilities = Object.freeze({ replies: true, mentions: true, dynamicPosts: true, dynamicReplies: true });
const hostScript = fileURLToPath(new URL('../scripts/bili-social-host.js', import.meta.url));
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fields = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const messages = { CONFIG_INVALID: '请检查本机 B站社交运行环境配置。', CREDENTIAL_INVALID: 'B站社交需要重新导入专用账号及评论凭据。',
  ACCOUNT_CHANGED: 'B站实际登录账号与专用账号不一致，已停止。', PLATFORM_PAUSED: 'B站社交访问已暂停，请先在本机核对账号和平台状态。',
  SOURCE_CHANGED: 'B站原评论已变化、不可见或无法核对，本次不回复。', CANCELLED: 'B站社交任务已取消。', BUSY: '已有 B站社交任务运行。',
  FAILED: 'B站社交任务未完成，未自动重试。' };
function failure(code) { const error = new Error(messages[code] || messages.FAILED); error.code = code; return error; }
function dynamicId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value)) throw failure('FAILED');
  return value;
}

export function createBiliSocialRuntime({ dataDir, getCredentials }) {
  const directory = resolve(dataDir), pausePath = join(directory, 'bili-social-pause.json');
  let busy = false, stopped = false, cancelCurrent, drained = Promise.resolve();
  function config() {
    const path = join(directory, 'bili-social-runtime.json');
    if (!existsSync(path)) return { enabled: false };
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'));
      if (!fields(value, ['enabled', 'nodePath', 'hostDirectory', 'pythonPath']) || typeof value.enabled !== 'boolean') throw new Error();
      if (!value.enabled) return { enabled: false };
      if (![value.nodePath, value.hostDirectory, value.pythonPath].every(path => typeof path === 'string' && isAbsolute(path))) throw new Error();
      // A venv executable is usually a symlink on Linux; resolving it loses pyvenv.cfg discovery.
      const result = { enabled: true, nodePath: realpathSync(value.nodePath), hostDirectory: realpathSync(value.hostDirectory), pythonPath: resolve(value.pythonPath) };
      if (![result.nodePath, result.pythonPath].every(path => statSync(path).isFile()) || !lstatSync(result.hostDirectory).isDirectory()) throw new Error();
      const packagePath = join(result.hostDirectory, 'node_modules', 'dsh-bili-subagent');
      const manifest = JSON.parse(readFileSync(join(packagePath, 'package.json'), 'utf8'));
      if (manifest.name !== 'dsh-bili-subagent' || manifest.version !== biliSocialPins.version
        || hash(join(packagePath, 'lib', 'mcp.mjs')) !== biliSocialPins.client
        || hash(join(packagePath, 'vendor', 'bilibili-mcp', 'mcp_server.py')) !== biliSocialPins.server) throw new Error();
      return result;
    } catch { throw failure('CONFIG_INVALID'); }
  }
  function credentials(value) {
    try { const result = normalizeBiliCredentials(value); biliSocialId(result.accountId); if (!result.biliJct) throw new Error(); return result; }
    catch { throw failure('CREDENTIAL_INVALID'); }
  }
  function paused() {
    if (!existsSync(pausePath)) return false;
    try { return JSON.parse(readFileSync(pausePath, 'utf8')).paused !== false; } catch { return true; }
  }
  function pause() {
    mkdirSync(directory, { recursive: true });
    const temporary = `${pausePath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ paused: true, at: new Date().toISOString() }), { mode: 0o600 });
    renameSync(temporary, pausePath);
  }
  async function run(operation, { notice, text, signal, beforeSend } = {}) {
    if (stopped) throw failure('CANCELLED');
    if (busy) throw failure('BUSY');
    const settings = config();
    if (!settings.enabled) throw failure('CONFIG_INVALID');
    if (paused()) throw failure('PLATFORM_PAUSED');
    const secret = credentials(getCredentials());
    if (['reply', 'post'].includes(operation)) {
      if (operation === 'reply') notice = normalizeNotice(notice);
      if (typeof text !== 'string' || !text.trim() || text.length > (operation === 'post' ? 800 : 600)
        || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) || typeof beforeSend !== 'function') throw failure('FAILED');
      if (operation === 'post') text = text.trim();
    }
    const controller = new AbortController();
    let finish;
    busy = true; drained = new Promise(accept => { finish = accept; });
    const abort = () => controller.abort();
    cancelCurrent = abort; signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const timeout = setTimeout(abort, 120000);
    const dynamicNotices = [];
    let workspace, child, posted = false, postRequested = false, postReceipt = null, requests = 0;
    const active = () => { if (controller.signal.aborted || stopped) throw failure('CANCELLED'); };
    const cookie = `SESSDATA=${secret.sessdata}; bili_jct=${secret.biliJct}${secret.buvid3 ? `; buvid3=${secret.buvid3}` : ''}`;
    async function fetchJson(url, options = {}, json = false) {
      active(); if (paused()) throw failure('PLATFORM_PAUSED');
      if (++requests > 16) throw failure('FAILED');
      const response = await fetch(url, { ...options, redirect: 'manual', credentials: 'omit',
        headers: { 'User-Agent': 'memoria-bili-social/1', Referer: 'https://www.bilibili.com/', Cookie: cookie,
          ...(options.method === 'POST' ? { 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded', Origin: 'https://www.bilibili.com' } : {}) },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
      if ([412, 429, 401].includes(response.status)) { await response.body?.cancel().catch(() => {}); pause(); throw failure('PLATFORM_PAUSED'); }
      if (response.redirected || (response.status >= 300 && response.status < 400)) throw failure('FAILED');
      const parts = []; let size = 0;
      for await (const part of response.body) { size += part.length; if (size > 1024 * 1024) throw failure('FAILED'); parts.push(part); }
      const body = parseBiliJson(Buffer.concat(parts).toString('utf8'));
      if ([-412, -352, -799, -509, -10403, -101, -105, 12015].includes(Number(body?.code))) { pause(); throw failure('PLATFORM_PAUSED'); }
      active();
      if (!response.ok || !object(body)) throw failure('FAILED');
      return { status: response.status, body };
    }
    async function verifyAccount() {
      const current = credentials(await getCredentials());
      if (JSON.stringify(current) !== JSON.stringify(secret) || JSON.stringify(config()) !== JSON.stringify(settings)) throw failure('ACCOUNT_CHANGED');
      const response = await fetchJson('https://api.bilibili.com/x/web-interface/nav');
      if (response.body.code !== 0 || String(response.body.data?.mid) !== secret.accountId || response.body.data?.isLogin !== true) throw failure('ACCOUNT_CHANGED');
    }
    async function verifySource() {
      const root = notice.root === '0' ? notice.rpid : notice.root;
      for (let page = 1; page <= 6; page++) {
        const { body } = await fetchJson(`https://api.bilibili.com/x/v2/reply/reply?type=${notice.resource === 'dynamic' ? notice.commentType : 1}&oid=${notice.resource === 'dynamic' ? notice.oid : notice.aid}&root=${root}&pn=${page}&ps=20`);
        if (body.code !== 0 || !object(body.data) || (body.data.replies != null && !Array.isArray(body.data.replies))) throw failure('SOURCE_CHANGED');
        const replies = body.data.replies || [];
        const candidates = [...replies, ...(object(body.data.root) ? [body.data.root] : [])];
        const target = candidates.find(item => String(item?.rpid_str ?? item?.rpid) === notice.rpid);
        if (target) {
          if (String(target.member?.mid ?? target.mid) !== notice.mid || (target.mid != null && String(target.mid) !== notice.mid)
            || typeof target.content?.message !== 'string' || target.content.message.trim() !== notice.content
            || (target.oid != null && String(target.oid) !== (notice.resource === 'dynamic' ? notice.oid : notice.aid))
            || (notice.rpid === root ? !['0', root].includes(String(target.root_str ?? target.root ?? '0')) : String(target.root_str ?? target.root) !== root)) throw failure('SOURCE_CHANGED');
          return;
        }
        if (replies.length < 20) break;
      }
      throw failure('SOURCE_CHANGED');
    }
    async function broker(request) {
      active();
      if (!fields(request, ['method', 'url', 'params', 'data', 'json']) || (Object.hasOwn(request, 'json') && request.json !== true)
        || typeof request.url !== 'string' || !object(request.params) || !object(request.data)) throw failure('FAILED');
      const url = new URL(request.url), params = request.params, data = request.data;
      if (url.origin !== 'https://api.bilibili.com' || url.search || url.hash || url.username || url.password
        || Object.values(params).some(value => typeof value !== 'string')
        || (request.json !== true && Object.values(data).some(value => typeof value !== 'string'))) throw failure('FAILED');
      if (request.method === 'GET') {
        if (Object.keys(data).length || request.json === true) throw failure('FAILED');
        if (operation === 'inbox' && ['/x/msgfeed/reply', '/x/msgfeed/at', '/x/msgfeed/like'].includes(url.pathname) && !Object.keys(params).length) {
          const result = await fetchJson(url.href);
          if (['/x/msgfeed/reply', '/x/msgfeed/at'].includes(url.pathname)) dynamicNotices.push(...biliDynamicFeed(url.pathname.endsWith('/at') ? 'at' : 'reply', result.body));
          return url.pathname === '/x/msgfeed/at' ? { ...result, body: biliMentionFeed(result.body) } : result;
        }
        if (['reply', 'post'].includes(operation) && url.pathname === '/x/web-interface/nav' && !Object.keys(params).length) {
          const result = await fetchJson(url.href);
          if (result.body.code !== 0 || result.body.data?.isLogin !== true || String(result.body.data?.mid) !== secret.accountId) throw failure('ACCOUNT_CHANGED');
          return result;
        }
        if (operation === 'reply' && url.pathname === '/x/web-interface/view' && Object.keys(params).length === 2
          && params.bvid === notice.bvid && params.aid === notice.aid) {
          url.search = new URLSearchParams(params).toString();
          const result = await fetchJson(url.href);
          if (result.body.code !== 0 || String(result.body.data?.aid) !== notice.aid || result.body.data?.bvid !== notice.bvid) throw failure('SOURCE_CHANGED');
          return result;
        }
        throw failure('FAILED');
      }
      const signingKeys = ['dm_img_list', 'dm_img_str', 'dm_cover_img_str', 'dm_img_inter', 'wts', 'web_location', 'w_rid'];
      const keys = operation === 'post' ? [...signingKeys, 'csrf'] : signingKeys;
      if (!['reply', 'post'].includes(operation) || request.method !== 'POST' || postRequested
        || Object.keys(params).length !== keys.length || Object.keys(params).some(key => !keys.includes(key))
        || params.dm_img_list !== '[]' || params.dm_img_inter !== '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}'
        || !/^[A-K]{2}$/.test(params.dm_img_str) || !/^[A-K]{2}$/.test(params.dm_cover_img_str)
        || params.web_location !== '1550101' || !/^[1-9]\d{9}$/.test(params.wts) || Math.abs(Number(params.wts) * 1000 - Date.now()) > 300000
        || !/^[0-9a-f]{32}$/.test(params.w_rid)) throw failure('FAILED');
      if (operation === 'post') {
        const expected = { dyn_req: { content: { contents: [{ biz_id: '', type: 1, raw_text: text }] }, scene: 1,
          meta: { app_meta: { from: 'create.dynamic.web', mobi_app: 'web' } }, attach_card: null }, csrf: secret.biliJct, csrf_token: secret.biliJct };
        if (url.pathname !== '/x/dynamic/feed/create/dyn' || request.json !== true || params.csrf !== secret.biliJct || !isDeepStrictEqual(data, expected)) throw failure('FAILED');
      } else {
        const expected = { oid: notice.resource === 'dynamic' ? notice.oid : notice.aid, type: notice.resource === 'dynamic' ? String(notice.commentType) : '1', message: text, plat: '1', statistics: "{'appId': 100, 'platform': 5}", gaia_source: 'main_web',
          root: notice.root === '0' ? notice.rpid : notice.root, parent: notice.rpid, csrf: secret.biliJct, csrf_token: secret.biliJct };
        if (url.pathname !== '/x/v2/reply/add' || request.json === true || !isDeepStrictEqual(data, expected)) throw failure('FAILED');
      }
      postRequested = true;
      await verifyAccount();
      if (operation === 'reply') {
        if (notice.resource === 'dynamic') {
          const { body } = await fetchJson('https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=' + notice.dynamicId);
          const item = body.data?.item;
          if (body.code !== 0 || !object(item) || item.visible === false || String(item.id_str) !== notice.dynamicId
            || Number(item.basic?.comment_type) !== notice.commentType || String(item.basic?.comment_id_str) !== notice.oid) throw failure('SOURCE_CHANGED');
        }
        await verifySource();
      }
      active();
      if (await beforeSend() === false) throw failure('CANCELLED');
      active();
      if (JSON.stringify(credentials(await getCredentials())) !== JSON.stringify(secret) || JSON.stringify(config()) !== JSON.stringify(settings)) throw failure('ACCOUNT_CHANGED');
      posted = true;
      url.search = new URLSearchParams(params).toString();
      const result = await fetchJson(url.href, { method: 'POST', body: operation === 'post' ? JSON.stringify(data) : new URLSearchParams(data).toString() }, operation === 'post');
      if (result.body.code === 0) {
        try { postReceipt = operation === 'post' ? dynamicId(result.body.data?.dyn_id_str ?? result.body.data?.dyn_id)
          : (notice?.resource === 'dynamic' ? biliDynamicId : biliSocialId)(result.body.data?.rpid_str ?? result.body.data?.rpid); } catch {}
      }
      return result;
    }
    try {
      await verifyAccount();
      active();
      workspace = realpathSync(mkdtempSync(join(tmpdir(), 'memoria-bili-social-')));
      for (const folder of ['home', 'tmp']) mkdirSync(join(workspace, folder), { mode: 0o700 });
      const source = join(settings.hostDirectory, 'node_modules', 'dsh-bili-subagent', 'vendor', 'bilibili-mcp', 'mcp_server.py');
      writeFileSync(join(workspace, 'mcp_server.py'), readFileSync(source), { mode: 0o600, flag: 'wx' });
      writeFileSync(join(workspace, 'bili_credential.json'), JSON.stringify({ sessdata: secret.sessdata, bili_jct: secret.biliJct, buvid3: secret.buvid3 || '', dedeuserid: secret.accountId }), { mode: 0o600, flag: 'wx' });
      const env = {};
      for (const [key, value] of Object.entries(process.env)) if (['systemroot', 'windir', 'comspec', 'path', 'pathext', 'systemdrive'].includes(key.toLowerCase())) env[key] = value;
      Object.assign(env, { HOME: join(workspace, 'home'), USERPROFILE: join(workspace, 'home'), TEMP: join(workspace, 'tmp'), TMP: join(workspace, 'tmp') });
      const result = await new Promise((accept, reject) => {
        let value, received = false, childError, stderr = 0;
        const ids = new Set();
        child = spawn(settings.nodePath, [hostScript], { cwd: workspace, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        const cancel = () => { if (child.connected) child.send({ type: 'cancel' }, () => {}); };
        controller.signal.addEventListener('abort', cancel, { once: true });
        const killTree = () => {
          if (!child.pid || child.exitCode !== null) return;
          if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
        };
        let hardTimer;
        const rejected = error => { childError ||= error; cancel(); hardTimer ||= setTimeout(killTree, 3000); };
        const aborted = () => rejected(failure('CANCELLED'));
        controller.signal.addEventListener('abort', aborted, { once: true });
        child.once('spawn', () => child.send({ type: 'start', operation, workspace, hostDirectory: settings.hostDirectory, pythonPath: settings.pythonPath,
          ...(operation === 'reply' ? { notice, text } : operation === 'post' ? { text } : {}) }));
        child.on('error', () => rejected(failure('FAILED')));
        child.stderr.on('data', chunk => { stderr += chunk.length; if (stderr > 65536) rejected(failure('FAILED')); });
        child.on('message', message => {
          if (!object(message) || Buffer.byteLength(JSON.stringify(message)) > 2 * 1024 * 1024 || received || controller.signal.aborted) return rejected(failure('FAILED'));
          if (message.type === 'network' && fields(message, ['type', 'id', 'request']) && Number.isSafeInteger(message.id) && message.id > 0 && message.id <= 16 && !ids.has(message.id)) {
            ids.add(message.id);
            broker(message.request).then(result => { if (child.connected) child.send({ type: 'network-result', id: message.id, result }, () => {}); })
              .catch(error => { childError ||= messages[error?.code] ? error : failure('FAILED');
                if (child.connected) child.send({ type: 'network-result', id: message.id, result: { error: 'REFUSED' } }, () => {}); });
          } else if (message.type === 'result' && fields(message, ['type', 'result'])) { value = message.result; received = true; }
          else rejected(failure('FAILED'));
        });
        child.once('close', code => {
          clearTimeout(hardTimer); controller.signal.removeEventListener('abort', cancel); controller.signal.removeEventListener('abort', aborted);
          if (childError || code !== 0 || !received) reject(childError || failure('FAILED')); else accept(value);
        });
        if (controller.signal.aborted) aborted();
      });
      active();
      if (operation === 'inbox') {
        if (!object(result) || !Array.isArray(result.items) || result.items.length > 1000 || result.error) throw failure('FAILED');
        const notices = [], comments = new Set();
        for (const item of [...result.items, ...dynamicNotices]) {
          try { const notice = normalizeNotice(item); const age = Date.now() - Date.parse(notice.at);
            const key = biliCommentKey(secret.accountId, notice);
            if (age >= 0 && age <= 7 * 86400000 && notice.mid !== secret.accountId && !comments.has(key)) {
              comments.add(key); notices.push(notice);
            } } catch {}
        }
        return { accountId: secret.accountId, notices: notices.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 20), capabilities: { ...capabilities } };
      }
      let receipt;
      try { if (result?.success === true) receipt = operation === 'post' ? dynamicId(result.data?.dyn_id_str ?? result.data?.dyn_id)
        : (notice?.resource === 'dynamic' ? biliDynamicId : biliSocialId)(result.rpid_str ?? result.rpid); } catch {}
      return receipt && receipt === postReceipt && posted ? { outcome: 'sent', receipt: operation === 'post' ? { dynamicId: receipt } : { rpid: receipt } }
        : { outcome: posted ? 'unknown' : 'failed', code: 'UNCONFIRMED' };
    } catch (error) {
      if (['reply', 'post'].includes(operation)) return { outcome: posted ? 'unknown' : 'failed', code: messages[error?.code] ? error.code : 'FAILED' };
      throw messages[error?.code] ? error : failure('FAILED');
    } finally {
      clearTimeout(timeout); signal?.removeEventListener('abort', abort); controller.abort();
      if (workspace && dirname(workspace) === realpathSync(tmpdir()) && realpathSync(workspace) === workspace && !lstatSync(workspace).isSymbolicLink()) rmSync(workspace, { recursive: true, force: true });
      busy = false; cancelCurrent = undefined; finish();
    }
  }
  return {
    status() {
      const result = { enabled: false, ready: false, busy, mode: 'dsh-plugin-mcp', accountId: null, capabilities: { ...capabilities }, paused: paused(), pauseUntil: null, error: null };
      try { const settings = config(); result.enabled = settings.enabled; if (!settings.enabled) return result;
        const secret = credentials(getCredentials()); result.accountId = secret.accountId; result.ready = !result.paused && !stopped;
        if (result.paused) result.error = messages.PLATFORM_PAUSED;
      } catch (error) { result.error = messages[error?.code] || messages.FAILED; }
      return result;
    },
    inbox: options => run('inbox', options),
    reply: options => run('reply', options),
    post: options => run('post', options),
    stop() { stopped = true; cancelCurrent?.(); return drained; },
  };
}
