import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { encryptBackup } from './backup.js';

const RETRY_MS = 15 * 60 * 1000;
const MAX_BYTES = 30 * 1024 * 1024;
const EMPTY_STATUS = { lastAttempt: '', lastSuccess: '', lastLocalFile: '', lastRemoteUrl: '', lastError: '', remoteVerified: false };

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function backupDirectory(value, { root, dataDir }) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new Error('本地备份目录必须使用绝对路径。');
  const directory = path.resolve(value);
  const forbidden = [dataDir, ...['src', 'public', 'scripts', 'node_modules', '.git'].map(name => path.join(root, name))];
  if (path.relative(path.resolve(root), directory) === '' || path.dirname(directory) === directory
    || forbidden.some(item => contains(path.resolve(item), directory))) {
    throw new Error('备份目录不能使用项目根目录、磁盘根目录、运行数据目录或程序目录。');
  }
  return directory;
}

function webdavUrl(value) {
  if (value === '') return '';
  let url;
  try { url = new URL(value); } catch { throw new Error('WebDAV 目录地址无效。'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new Error('WebDAV 须使用 HTTPS，不能在地址中放置凭据、查询参数或片段；仅本机测试允许 HTTP。');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

function boolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label}须为布尔值。`);
  return value;
}

function secret(input, previous, name, clearName) {
  if (input[clearName] !== undefined && typeof input[clearName] !== 'boolean') throw new Error('清除凭据选项须为布尔值。');
  if (input[name] !== undefined && (typeof input[name] !== 'string' || Buffer.byteLength(input[name]) > 4096)) throw new Error('备份凭据格式无效或过长。');
  return input[clearName] === true ? '' : (input[name] || previous || '');
}

export function normalizeBackupSettings(input = {}, previous = {}, locations) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('备份设置格式无效。');
  previous ||= {};
  const incomingWebdav = input.webdav ?? {};
  if (!incomingWebdav || typeof incomingWebdav !== 'object' || Array.isArray(incomingWebdav)) throw new Error('WebDAV 设置格式无效。');
  const oldWebdav = previous.webdav || {};
  const config = {
    enabled: boolean(input.enabled ?? previous.enabled ?? false, '自动备份开关'),
    intervalHours: input.intervalHours ?? previous.intervalHours ?? 6,
    keepLocal: input.keepLocal ?? previous.keepLocal ?? 30,
    localDirectory: backupDirectory(input.localDirectory ?? previous.localDirectory ?? path.join(locations.root, 'backups'), locations),
    passphrase: secret(input, previous.passphrase, 'passphrase', 'clearPassphrase'),
    webdav: {
      enabled: boolean(incomingWebdav.enabled ?? oldWebdav.enabled ?? false, 'WebDAV 开关'),
      url: webdavUrl(incomingWebdav.url ?? oldWebdav.url ?? ''),
      username: incomingWebdav.username ?? oldWebdav.username ?? '',
      password: secret(incomingWebdav, oldWebdav.password, 'password', 'clearPassword'),
    },
  };
  if (!Number.isInteger(config.intervalHours) || config.intervalHours < 1 || config.intervalHours > 168) throw new Error('备份间隔须为 1 至 168 小时的整数。');
  if (!Number.isInteger(config.keepLocal) || config.keepLocal < 1 || config.keepLocal > 365) throw new Error('本地备份保留数须为 1 至 365 的整数。');
  if (config.passphrase && Array.from(config.passphrase).length < 12) throw new Error('备份口令须为至少 12 个字符。');
  if (config.enabled && !config.passphrase) throw new Error('启用自动备份前请设置至少 12 个字符的备份口令。');
  if (typeof config.webdav.username !== 'string' || Buffer.byteLength(config.webdav.username) > 4096 || config.webdav.username.includes(':')) throw new Error('WebDAV 用户名无效或过长。');
  if (config.webdav.enabled && !config.webdav.url) throw new Error('启用 WebDAV 前请填写已有目录地址。');
  return config;
}

export function publicBackupSettings(config) {
  const { passphrase, webdav, ...view } = config;
  const { password, ...remoteView } = webdav;
  return { ...view, hasPassphrase: Boolean(passphrase), webdav: { ...remoteView, hasPassword: Boolean(password) } };
}

async function rejectLinkedAncestors(directory) {
  let current = directory;
  while (true) {
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('备份目录及其上级目录必须是实际目录，不能使用符号链接。');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function atomicArchive(directory, filename, archive) {
  const temporary = path.join(directory, `.${filename}.${randomUUID()}.tmp`);
  const destination = path.join(directory, filename);
  let handle;
  try {
    await rejectLinkedAncestors(directory);
    await mkdir(directory, { recursive: true });
    await rejectLinkedAncestors(directory);
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(archive);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, destination);
    return destination;
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function verifyRemote(response, archive) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > archive.length) {
    await response.body?.cancel();
    throw new Error('WebDAV 回读文件大小不一致，本地备份已保留。');
  }
  if (!response.body) throw new Error('WebDAV 回读为空，本地备份已保留。');
  const reader = response.body.getReader();
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > archive.length) throw new Error('WebDAV 回读文件大小不一致，本地备份已保留。');
      hash.update(value);
    }
    if (bytes !== archive.length || hash.digest('hex') !== createHash('sha256').update(archive).digest('hex')) {
      throw new Error('WebDAV 回读校验失败，本地备份已保留。');
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function createBackupJobs({ store, root, dataDir, isBusy = () => false }) {
  let installationId = store.getSetting('backupInstallationId');
  if (typeof installationId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(installationId)) {
    installationId = randomUUID();
    store.setSetting('backupInstallationId', installationId);
  }
  const prefix = `persona-${installationId}-`;
  let busy = false;
  let stopped = false;
  let controller, activeRun;
  let lastStatus = { ...EMPTY_STATUS, ...store.getSetting('backupStatus', {}) };
  const status = () => ({ ...(stopped ? lastStatus : lastStatus = { ...EMPTY_STATUS, ...store.getSetting('backupStatus', {}) }), busy });
  function update(values) {
    const { busy: ignored, ...previous } = status();
    lastStatus = { ...previous, ...values };
    store.setSetting('backupStatus', lastStatus);
  }

  async function prune(directory, keepLocal) {
    await rejectLinkedAncestors(directory);
    const candidates = [];
    const suffix = /^\d{8}T\d{9}Z-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.pab$/i;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !suffix.test(entry.name.slice(prefix.length))) continue;
      candidates.push(entry.name);
    }
    candidates.sort().reverse();
    for (const filename of candidates.slice(keepLocal)) {
      const target = path.join(directory, filename);
      const entry = await lstat(target);
      if (entry.isFile() && !entry.isSymbolicLink()) await unlink(target);
    }
  }

  async function run({ force = false } = {}) {
    if (stopped) throw new Error('备份任务已停止。');
    if (busy) return { ...status(), skipped: 'busy' };
    if (isBusy()) return { ...status(), skipped: 'activity' };
    const config = normalizeBackupSettings({}, store.getSetting('backup', {}), { root, dataDir });
    if (!force && !config.enabled) return { ...status(), skipped: 'disabled' };
    const before = status();
    const lastAttempt = Date.parse(before.lastAttempt) || 0;
    const lastSuccess = Date.parse(before.lastSuccess) || 0;
    const dueAt = before.lastError && lastAttempt >= lastSuccess
      ? lastAttempt + RETRY_MS : Math.max(lastSuccess, lastAttempt) + config.intervalHours * 3600000;
    if (!force && Date.now() < dueAt) return { ...status(), skipped: 'interval' };
    if (!config.passphrase) throw new Error('请先设置至少 12 个字符的备份口令。');
    busy = true;
    controller = new AbortController();
    let finish;
    const running = activeRun = { finished: new Promise(resolve => { finish = resolve; }) };
    let phase = 'snapshot';
    try {
      update({ lastAttempt: new Date().toISOString(), lastError: '', remoteVerified: false, lastRemoteUrl: '' });
      // Export and encrypt synchronously so no chat can mutate the snapshot mid-export.
      const archive = encryptBackup(store.exportData(), config.passphrase);
      if (archive.length > MAX_BYTES) throw new Error('加密备份超过 30 MB 上限。');
      const filename = `${prefix}${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID()}.pab`;
      phase = 'local';
      const localFile = await atomicArchive(config.localDirectory, filename, archive);
      update({ lastLocalFile: localFile });
      if (stopped) throw new Error('备份任务已停止，本地备份已保留。');
      controller.signal.throwIfAborted();
      if (config.webdav.enabled) {
        phase = 'remote';
        const url = new URL(filename, config.webdav.url).href;
        const headers = { 'Content-Type': 'application/octet-stream' };
        if (config.webdav.username || config.webdav.password) headers.Authorization = `Basic ${Buffer.from(`${config.webdav.username}:${config.webdav.password}`).toString('base64')}`;
        const options = { redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) };
        const uploaded = await fetch(url, { ...options, method: 'PUT', headers, body: archive });
        await uploaded.body?.cancel();
        controller.signal.throwIfAborted();
        if (!uploaded.ok) throw new Error(`WebDAV 上传失败（HTTP ${uploaded.status}），本地备份已保留。`);
        const downloaded = await fetch(url, { ...options, method: 'GET', headers: { ...headers, 'Cache-Control': 'no-cache' } });
        if (!downloaded.ok) {
          await downloaded.body?.cancel();
          throw new Error(`WebDAV 回读失败（HTTP ${downloaded.status}），本地备份已保留。`);
        }
        await verifyRemote(downloaded, archive);
        controller.signal.throwIfAborted();
        update({ lastRemoteUrl: url, remoteVerified: true });
      }
      phase = 'cleanup';
      await prune(config.localDirectory, config.keepLocal);
      controller.signal.throwIfAborted();
      update({ lastSuccess: new Date().toISOString(), lastError: '' });
      return { ...status(), busy: false };
    } catch (error) {
      let message;
      if (stopped) message = '备份任务已停止；已生成的本地备份会保留。';
      else if (controller.signal.aborted) message = '本次备份已取消；已生成的本地备份会保留。';
      else if (phase === 'remote') message = /^WebDAV /.test(error.message) ? error.message : 'WebDAV 上传或回读失败，请检查连接与凭据；本地备份已保留。';
      else if (phase === 'cleanup') message = '备份已保存，但本地旧版本清理失败，请检查目录权限。';
      else if (phase === 'local') message = '本地备份写入失败，请检查目录权限、磁盘空间及符号链接。';
      else message = '无法生成加密备份，请检查备份口令与数据大小。';
      update({ lastError: message });
      throw new Error(message);
    } finally { busy = false; controller = null; if (activeRun === running) activeRun = null; queueMicrotask(finish); }
  }

  async function tick() {
    if (stopped || !store.getSetting('admin')) return status();
    try { return await run(); } catch { return status(); }
  }

  function cancel() { controller?.abort(); }
  function cancelAndWait() { const running = activeRun; cancel(); return running?.finished || Promise.resolve(); }
  function stop() { if (!stopped) lastStatus = status(); stopped = true; return cancelAndWait(); }
  return { run, tick, status, cancel, cancelAndWait, stop };
}
