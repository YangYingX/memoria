import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createStore } from './store.js';
import { readPage } from './reader.js';
import { encryptBackup, decryptBackup } from './backup.js';
import { createSessions, hashPassword, sameSecret, verifyPassword } from './auth.js';
import { runConversation } from './agent.js';
import { testModel } from './model.js';
import { createBackupJobs, normalizeBackupSettings, publicBackupSettings } from './backup-jobs.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const dataDir = resolve(process.env.PERSONA_DATA_DIR || join(root, 'data'));
const port = Number(process.env.PORT || 3210);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT 必须介于 1024 和 65535。');
mkdirSync(dataDir, { recursive: true });
const store = createStore(join(dataDir, 'persona.sqlite'));
const defaults = {
  persona: { name: '未央', description: '温和、好奇、坦诚，喜欢了解人的兴趣与日常。保留自己的表达习惯，尊重聊天场合，不虚构经历。' },
  model: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: '' },
  qq: { enabled: false, apiBaseUrl: 'http://127.0.0.1:3000', accessToken: '', webhookSecret: randomBytes(24).toString('hex'), allowedUsers: [], allowedGroups: [], botId: '' },
  reading: { enabled: false, urls: [], intervalMinutes: 60, dailyLimit: 5 },
  backup: { enabled: false, intervalHours: 6, keepLocal: 30, localDirectory: resolve(process.env.PERSONA_BACKUP_DIR || join(root, 'backups')), passphrase: '', webdav: { enabled: false, url: '', username: '', password: '' } },
};
for (const [key, value] of Object.entries(defaults)) if (!store.getSetting(key)) store.setSetting(key, value);
const setupKeyPath = join(dataDir, 'setup-key.txt');
if (!store.getSetting('admin') && !existsSync(setupKeyPath)) writeFileSync(setupKeyPath, randomBytes(24).toString('base64url'), { mode: 0o600 });
const sessions = createSessions();
const activeConversations = new Set();
const conversationQueues = new Map();
const readingJobs = new Set();
let readingBusy = false;
let activeMutation = 0;
let attempts = [];
let pendingBinding = null;
const backupJobs = createBackupJobs({ store, root, dataDir, isBusy: () => activeMutation > 0 || readingBusy });

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function body(req, max = 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error('请求内容超过大小限制。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function text(value, name, max, min = 1) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) throw new Error(`${name}长度须为 ${min}–${max}。`);
  return value.trim();
}

function endpoint(value) {
  const url = new URL(text(value, '接口地址', 500));
  if (url.username || url.password || url.search || url.hash) throw new Error('接口地址不能包含凭据、查询参数或片段。');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('接口须使用 HTTPS，本机接口可使用 HTTP。');
  return url.href.replace(/\/+$/, '');
}

function publicSettings() {
  const persona = store.getSetting('persona'), model = store.getSetting('model'), qq = store.getSetting('qq');
  const { apiKey, ...modelView } = model;
  const { accessToken, ...qqView } = qq;
  return { persona, model: { ...modelView, hasApiKey: Boolean(apiKey) }, qq: { ...qqView, hasAccessToken: Boolean(accessToken) }, reading: store.getSetting('reading'), backup: publicBackupSettings(store.getSetting('backup')) };
}

function saveSettings(input) {
  const next = {};
  if (input.persona) next.persona = { name: text(input.persona.name, '名字', 40), description: text(input.persona.description, '人格设定', 4000) };
  if (input.model) {
    const previous = store.getSetting('model');
    next.model = { baseUrl: endpoint(input.model.baseUrl), model: text(input.model.model, '模型名称', 120), apiKey: input.model.clearApiKey ? '' : (input.model.apiKey ? text(input.model.apiKey, 'API 密钥', 1000) : previous.apiKey) };
  }
  if (input.qq) {
    const q = input.qq, previous = store.getSetting('qq');
    const ids = list => {
      if (!Array.isArray(list) || list.length > 50 || list.some(id => !/^\d{1,20}$/.test(String(id)))) throw new Error('QQ 白名单须为最多 50 个数字 ID。');
      return [...new Set(list.map(String))];
    };
    if (typeof q.enabled !== 'boolean') throw new Error('QQ 开关无效。');
    if (q.botId && !/^\d{1,20}$/.test(String(q.botId))) throw new Error('机器人 QQ 号格式无效。');
    if (q.enabled && !q.botId) throw new Error('启用 QQ 前须填写机器人 QQ 号。');
    next.qq = { enabled: q.enabled, apiBaseUrl: endpoint(q.apiBaseUrl), botId: String(q.botId || ''), accessToken: q.accessToken ? text(q.accessToken, 'OneBot Token', 1000) : previous.accessToken, webhookSecret: q.webhookSecret ? text(q.webhookSecret, 'Webhook Secret', 200, 24) : previous.webhookSecret, allowedUsers: ids(q.allowedUsers || []), allowedGroups: ids(q.allowedGroups || []) };
  }
  if (input.reading) {
    const r = input.reading;
    if (typeof r.enabled !== 'boolean' || !Array.isArray(r.urls) || r.urls.length > 20) throw new Error('阅读配置格式无效，最多 20 个网址。');
    if (!Number.isInteger(r.intervalMinutes) || r.intervalMinutes < 5 || r.intervalMinutes > 1440 || !Number.isInteger(r.dailyLimit) || r.dailyLimit < 1 || r.dailyLimit > 20) throw new Error('阅读间隔为 5–1440 分钟，每日上限为 1–20 页。');
    const urls = [...new Set(r.urls.map(value => { const u = new URL(text(value, '阅读网址', 2000)); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('阅读网址无效。'); return u.href; }))];
    if (r.enabled && !urls.length) throw new Error('请先填写至少一个阅读网址。');
    next.reading = { enabled: r.enabled, urls, intervalMinutes: r.intervalMinutes, dailyLimit: r.dailyLimit };
  }
  if (input.backup) {
    if (backupJobs.status().busy) throw new Error('请等待备份任务完成再修改备份设置。');
    next.backup = normalizeBackupSettings(input.backup, store.getSetting('backup'), { root, dataDir });
  }
  for (const [key, value] of Object.entries(next)) store.setSetting(key, value);
  return publicSettings();
}

async function readAndRemember(url, scope, actor = 'owner') {
  const key = `${scope}:${url}`;
  if (readingJobs.size >= 2 || readingJobs.has(key)) throw new Error('已有阅读任务进行中，请稍后重试。');
  readingJobs.add(key); activeMutation++;
  try {
    const page = await readPage(url);
    const event = store.addEvent({ type: 'reading', scope, actor, content: page.text, sourceRef: page.url, metadata: { title: page.title, readAt: page.readAt } });
    const memory = store.saveMemory({ title: page.title.slice(0, 150), content: page.text.slice(0, 12000), category: 'reading', scope, sourceType: 'webpage', sourceRef: page.url });
    return { page, memory, eventId: event.id };
  } finally { readingJobs.delete(key); activeMutation--; }
}

async function chat(scope, message, actor = 'owner') {
  const queue = conversationQueues.get(scope) || { tail: Promise.resolve(), pending: 0 };
  if (queue.pending >= 10) throw new Error('当前对话已有 10 条消息等待处理，请稍后再发。');
  queue.pending++; activeMutation++;
  conversationQueues.set(scope, queue);
  const task = queue.tail.then(async () => {
    if (activeConversations.size >= 3) throw new Error('已有 3 个对话同时处理，请稍后再试。');
    activeConversations.add(scope);
    try { return await runConversation({ store, readAndRemember, scope, message, actor }); }
    finally { activeConversations.delete(scope); }
  });
  queue.tail = task.catch(() => {});
  try { return await task; }
  finally {
    activeMutation--; queue.pending--;
    if (!queue.pending) conversationQueues.delete(scope);
  }
}

async function sendQQ(config, target, reply) {
  const response = await fetch(`${config.apiBaseUrl}/${target.group_id ? 'send_group_msg' : 'send_private_msg'}`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', ...(config.accessToken ? { Authorization: `Bearer ${config.accessToken}` } : {}) },
    body: JSON.stringify({ ...target, message: [{ type: 'text', data: { text: reply.slice(0, 5000) } }] }),
  });
  if (!response.ok) throw new Error(`QQ 发送接口 HTTP ${response.status}`);
  const result = await response.json();
  if (result.status !== 'ok' || Number(result.retcode) !== 0) throw new Error('QQ 协议端未确认消息发送成功。');
}

async function testQQ() {
  const config = store.getSetting('qq');
  const call = async action => {
    const response = await fetch(`${config.apiBaseUrl}/${action}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', ...(config.accessToken ? { Authorization: `Bearer ${config.accessToken}` } : {}) }, body: '{}',
    });
    if (!response.ok) throw new Error(`QQ 接口返回 HTTP ${response.status}，请检查协议端地址与 Access Token。`);
    const data = await response.json();
    if (data.status !== 'ok' || Number(data.retcode) !== 0 || !data.data) throw new Error('QQ 协议端没有返回有效的状态信息。');
    return data.data;
  };
  const [login, status] = await Promise.all([call('get_login_info'), call('get_status')]);
  const botId = String(login.user_id || '');
  const online = status.online === true;
  const ok = online && botId === config.botId;
  return { ok, online, botId, nickname: String(login.nickname || '').slice(0, 100), lastEventAt: store.getSetting('onebotStatus', {}).lastEventAt || null,
    message: !online ? '协议端可连接，但 QQ 当前未登录或不在线。' : botId !== config.botId ? `协议端已登录，请把机器人 QQ 号设置为 ${botId} 后保存。` : 'QQ 在线且账号匹配；请再发送测试消息验证事件上报。' };
}

async function handleQQ(event, config) {
  if (event.post_type !== 'message' || !['private', 'group'].includes(event.message_type)) return;
  const userId = String(event.user_id || ''), selfId = String(event.self_id || '');
  if (!/^\d{1,20}$/.test(userId) || selfId !== config.botId || userId === selfId) return;
  const segments = Array.isArray(event.message) ? event.message : [];
  const message = segments.length ? segments.filter(s => s.type === 'text').map(s => s.data?.text || '').join('').trim() : String(event.raw_message || '').replace(/\[CQ:[^\]]*\]/g, '').trim();
  if (!message || message.length > 8000) return;
  if (event.message_id === undefined) return;
  if (!store.claimDelivery(`qq:${selfId}:${event.message_type}:${event.group_id || ''}:${event.message_id}`)) return;
  const binding = message.match(/^(?:绑定|bind)\s+([A-Za-z0-9_-]+)$/);
  if (event.message_type === 'private' && binding) {
    if (pendingBinding && pendingBinding.expires > Date.now() && sameSecret(createHash('sha256').update(binding[1]).digest('hex'), pendingBinding.hash)) {
      store.bindAccount({ platform: 'qq', userId, personId: 'owner', label: '创建人 QQ' });
      pendingBinding = null;
      await sendQQ(config, { user_id: userId }, '已通过一次性验证码绑定为创建人账号。管理设置请在本机后台操作。');
    }
    return;
  }
  const account = store.findAccount('qq', userId);
  let scope, target;
  if (event.message_type === 'group') {
    const groupId = String(event.group_id || '');
    const mentioned = segments.some(s => s.type === 'at' && String(s.data?.qq) === selfId) || String(event.raw_message).includes(`[CQ:at,qq=${selfId}]`);
    if (!config.allowedGroups.includes(groupId) || !mentioned) return;
    scope = `group:${groupId}`; target = { group_id: groupId };
  } else {
    if (!account && !config.allowedUsers.includes(userId)) return;
    scope = account?.personId === 'owner' ? 'owner' : `person:qq:${userId}`;
    target = { user_id: userId };
  }
  // Group context never inherits the owner's private scope, even when the owner speaks.
  let result;
  try { result = await chat(scope, message, account?.personId === 'owner' ? 'owner' : `qq:${userId}`); }
  catch (error) {
    await sendQQ(config, target, '本次消息未能处理完成，请稍后重发。创建人可在本机后台查看原因。');
    throw error;
  }
  await sendQQ(config, target, result.reply);
}

async function scheduledReading() {
  const config = store.getSetting('reading');
  if (!store.getSetting('admin') || !config.enabled || readingBusy || activeConversations.size) return;
  const now = Date.now(), day = new Date().toISOString().slice(0, 10);
  let status = store.getSetting('readingStatus', { day, count: 0, cursor: 0 });
  if (status.day !== day) status = { ...status, day, count: 0 };
  if (status.count >= config.dailyLimit || now - (status.lastAttempt || 0) < config.intervalMinutes * 60000 || !config.urls.length) return;
  readingBusy = true;
  const url = config.urls[(status.cursor || 0) % config.urls.length];
  status = { ...status, lastAttempt: now, cursor: (status.cursor || 0) + 1, count: status.count + 1 };
  store.setSetting('readingStatus', status);
  try {
    await readAndRemember(url, 'owner', 'scheduler');
    store.setSetting('readingStatus', { ...status, lastRun: new Date().toISOString(), lastError: '' });
  } catch (error) {
    store.setSetting('readingStatus', { ...status, lastError: error.message });
    store.addEvent({ type: 'error', scope: 'owner', actor: 'scheduler', content: `计划阅读失败：${error.message}`, sourceRef: url });
  } finally { readingBusy = false; }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(req.headers.host)) return json(res, 403, { error: '只接受本机地址访问。' });
    const url = new URL(req.url, `http://127.0.0.1:${port}`), path = url.pathname;
    if (path === '/integrations/onebot' && req.method === 'POST') {
      const qq = store.getSetting('qq');
      if (!qq.enabled || !store.getSetting('admin')) return json(res, 403, { error: 'QQ 接入未启用。' });
      const raw = await body(req);
      const expected = `sha1=${createHmac('sha1', qq.webhookSecret).update(raw).digest('hex')}`;
      if (!sameSecret(req.headers['x-signature'], expected)) return json(res, 401, { error: 'Webhook 签名无效。' });
      const event = JSON.parse(raw.toString('utf8'));
      if (!event || typeof event !== 'object' || Array.isArray(event)) return json(res, 400, { error: '事件格式无效。' });
      store.setSetting('onebotStatus', { lastEventAt: new Date().toISOString() });
      json(res, 200, {});
      handleQQ(event, qq).catch(error => store.addEvent({ type: 'error', scope: 'owner', actor: 'onebot', content: error.message }));
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (req.headers.origin && !hosts.some(host => req.headers.origin === `http://${host}`)) return json(res, 403, { error: '拒绝跨站操作。' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: '拒绝跨站操作。' });
      if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: '请求须使用 JSON。' });
    }
    if (path === '/api/status' && req.method === 'GET') return json(res, 200, { initialized: Boolean(store.getSetting('admin')), authenticated: Boolean(sessions.get(req)), version, mode: store.getSetting('model').apiKey ? 'live' : 'demo', ...(!store.getSetting('admin') ? { setupKeyPath } : {}) });
    if (['/api/setup', '/api/login'].includes(path) && req.method === 'POST') {
      attempts = attempts.filter(time => Date.now() - time < 60000);
      if (attempts.length >= 5) return json(res, 429, { error: '尝试次数过多，请一分钟后再试。' });
      attempts.push(Date.now());
      const input = JSON.parse((await body(req, 8192)).toString('utf8'));
      if (path === '/api/setup') {
        if (store.getSetting('admin')) return json(res, 409, { error: '已经完成初始化，请登录。' });
        if (!sameSecret(input.setupKey?.trim(), readFileSync(setupKeyPath, 'utf8').trim())) return json(res, 401, { error: '初始化码不正确。' });
        store.setSetting('admin', hashPassword(input.password));
        unlinkSync(setupKeyPath);
      } else if (!verifyPassword(input.password, store.getSetting('admin'))) return json(res, 401, { error: '密码不正确。' });
      attempts = []; sessions.start(res); return json(res, 200, { ok: true });
    }
    if (path.startsWith('/api/')) {
      if (!sessions.get(req)) return json(res, 401, { error: '请先登录创建人后台。' });
      const input = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? JSON.parse((await body(req, path.startsWith('/api/backups/') ? 40 * 1024 * 1024 : 1024 * 1024)).toString('utf8') || '{}') : {};
      if (path === '/api/logout' && req.method === 'POST') { sessions.end(req, res); return json(res, 200, { ok: true }); }
      if (path === '/api/state' && req.method === 'GET') return json(res, 200, { settings: publicSettings(), stats: store.stats(), accounts: store.listAccounts(), readingStatus: store.getSetting('readingStatus', {}), backupStatus: backupJobs.status(), modelUsage: store.getSetting('modelUsage', {}) });
      if (path === '/api/settings' && req.method === 'PUT') return json(res, 200, { settings: saveSettings(input) });
      if (path === '/api/model/test' && req.method === 'POST') {
        activeMutation++;
        try { return json(res, 200, await testModel(store)); } finally { activeMutation--; }
      }
      if (path === '/api/qq/test' && req.method === 'POST') return json(res, 200, await testQQ());
      if (path === '/api/backups/status' && req.method === 'GET') return json(res, 200, { status: backupJobs.status() });
      if (path === '/api/backups/run' && req.method === 'POST') {
        const status = await backupJobs.run({ force: true });
        if (status.skipped) return json(res, 409, { error: '当前有任务运行，请稍后再执行备份。' });
        return json(res, 200, { status });
      }
      if (path === '/api/messages' && req.method === 'GET') return json(res, 200, { messages: store.listMessages(url.searchParams.get('scope') || 'owner') });
      if (path === '/api/chat' && req.method === 'POST') {
        if (!['owner', 'group:demo'].includes(input.scope || 'owner')) throw new Error('调试场景无效。');
        return json(res, 200, await chat(input.scope || 'owner', input.message));
      }
      if (path === '/api/memories' && req.method === 'GET') return json(res, 200, { memories: store.listMemories({ q: url.searchParams.get('q') || '', scope: url.searchParams.get('scope') || '' }) });
      if (path === '/api/memories' && req.method === 'POST') return json(res, 201, { memory: store.saveMemory(input) });
      const memoryRoute = path.match(/^\/api\/memories\/([^/]+)(\/revisions)?$/);
      if (memoryRoute) {
        const id = decodeURIComponent(memoryRoute[1]);
        if (memoryRoute[2] && req.method === 'GET') return json(res, 200, { revisions: store.listRevisions(id) });
        if (req.method === 'PATCH') {
          const old = store.getMemory(id); if (!old) return json(res, 404, { error: '记忆不存在。' });
          return json(res, 200, { memory: store.saveMemory({ ...old, ...input, id }) });
        }
        if (req.method === 'DELETE') { store.deleteMemory(id); return json(res, 200, { ok: true }); }
      }
      if (path === '/api/read' && req.method === 'POST') {
        if (!['owner', 'public', 'group:demo'].includes(input.scope || 'owner')) throw new Error('阅读可见范围无效。');
        return json(res, 200, await readAndRemember(input.url, input.scope || 'owner'));
      }
      if (path === '/api/events' && req.method === 'GET') return json(res, 200, { events: store.listEvents({ limit: 60 }) });
      if (path === '/api/bindings/code' && req.method === 'POST') {
        const code = randomBytes(9).toString('base64url');
        pendingBinding = { hash: createHash('sha256').update(code).digest('hex'), expires: Date.now() + 10 * 60000 };
        return json(res, 200, { code, expiresAt: new Date(pendingBinding.expires).toISOString(), command: `绑定 ${code}` });
      }
      if (path.startsWith('/api/bindings/') && req.method === 'DELETE') { store.removeAccount(decodeURIComponent(path.split('/').at(-1))); return json(res, 200, { ok: true }); }
      if (path === '/api/backups/export' && req.method === 'POST') {
        if (activeMutation) return json(res, 409, { error: '请等待当前对话或阅读完成再备份。' });
        const archive = encryptBackup(store.exportData(), input.passphrase);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="persona-${new Date().toISOString().slice(0, 10)}.pab"` });
        return res.end(archive);
      }
      if (['/api/backups/preview', '/api/backups/restore'].includes(path) && req.method === 'POST') {
        const payload = decryptBackup(input.archive, input.passphrase);
        if (payload.schemaVersion !== 1 || !['memories', 'messages', 'events', 'accounts', 'revisions', 'tombstones'].every(key => Array.isArray(payload[key]))) throw new Error('备份数据格式不兼容。');
        if (path.endsWith('/preview')) return json(res, 200, { exportedAt: payload.exportedAt, counts: Object.fromEntries(['memories', 'events', 'messages', 'accounts'].map(key => [key, payload[key].length])) });
        if (input.confirm !== true) throw new Error('请先预览并确认恢复。');
        if (activeMutation || readingBusy || backupJobs.status().busy) return json(res, 409, { error: '请等待当前任务完成再恢复。' });
        const rollback = join(dataDir, `before-restore-${Date.now()}.pab`);
        writeFileSync(rollback, encryptBackup(store.exportData(), input.passphrase), { mode: 0o600 });
        store.importData(payload);
        store.setSetting('reading', { ...store.getSetting('reading'), enabled: false });
        store.setSetting('qq', { ...store.getSetting('qq'), enabled: false });
        store.setSetting('backup', { ...store.getSetting('backup'), enabled: false });
        pendingBinding = null;
        return json(res, 200, { ok: true, rollback, message: '已恢复。QQ、定时阅读和自动备份已暂停，跨平台账号绑定已清除，需要重新验证。模型密钥与登录密码保持不变。' });
      }
      return json(res, 404, { error: '接口不存在。' });
    }
    if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: '不支持此方法。' });
    const files = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'] };
    if (!files[path]) return json(res, 404, { error: '页面不存在。' });
    const [file, type] = files[path];
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
    res.end(req.method === 'HEAD' ? undefined : readFileSync(join(root, 'public', file)));
  } catch (error) {
    const safe = error instanceof SyntaxError ? '请求或返回的数据不是有效 JSON。' : error.message;
    if (!res.headersSent) json(res, 400, { error: safe || '操作失败。' });
    else res.end();
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 10000;
const timer = setInterval(() => {
  scheduledReading().catch(error => console.error('Reading scheduler:', error.message));
  backupJobs.tick().catch(error => console.error('Backup scheduler:', error.message));
}, 30000);
timer.unref();
server.listen(port, '127.0.0.1', () => {
  console.log(`Persona Agent v${version} — http://127.0.0.1:${port}`);
  console.log(`Data: ${dataDir}`);
  if (!store.getSetting('admin')) console.log(`Setup key file: ${setupKeyPath}`);
});
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用。` : error.message); clearInterval(timer); backupJobs.stop(); store.close(); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { clearInterval(timer); backupJobs.stop(); server.close(() => { store.close(); process.exit(0); }); setTimeout(() => process.exit(0), 3000).unref(); });
