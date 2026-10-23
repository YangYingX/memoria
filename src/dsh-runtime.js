import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryAccess } from './memory-access.js';

const hostScript = fileURLToPath(new URL('../scripts/dsh-host.js', import.meta.url));
const memoryTools = ['search_memory', 'read_memory', 'read_memory_source'];

export function createDshRuntime({ store, dataDir }) {
  let busy = false;
  function config() {
    const path = join(dataDir, 'dsh-runtime.json');
    if (!existsSync(path)) return { enabled: false };
    let input;
    try { input = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); }
    catch { throw new Error('DSH 本机配置无法读取。'); }
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.enabled !== 'boolean'
      || Object.keys(input).some(key => !['enabled', 'nodePath', 'hostDirectory'].includes(key))) throw new Error('DSH 本机配置无效。');
    if (!input.enabled) return { enabled: false };
    if (![input.nodePath, input.hostDirectory].every(value => typeof value === 'string' && isAbsolute(value))
      || !statSync(input.nodePath, { throwIfNoEntry: false })?.isFile()
      || !statSync(join(input.hostDirectory, 'package.json'), { throwIfNoEntry: false })?.isFile()) {
      throw new Error('请配置独立的 Node.js 24 和已安装 DSH 的宿主目录。');
    }
    return { enabled: true, nodePath: realpathSync(input.nodePath), hostDirectory: realpathSync(input.hostDirectory) };
  }
  return {
    status() {
      try { return { enabled: config().enabled, busy, mode: 'read-only', memoryAuthority: 'memoria' }; }
      catch { return { enabled: false, busy, mode: 'read-only', memoryAuthority: 'memoria', error: '请检查本机 DSH 配置。' }; }
    },
    async execute({ scope, actor, name, args = {}, signal }) {
      const memory = createMemoryAccess({ store, scope, actor });
      if (!['inspect', ...memoryTools].includes(name) || !args || typeof args !== 'object' || Array.isArray(args)
        || (name === 'inspect' && Object.keys(args).length)) throw new Error('此 DSH 入口仅支持状态核对和只读书架工具。');
      const settings = config();
      if (!settings.enabled) throw new Error('尚未启用 DSH 插件运行层。');
      if (busy) throw new Error('已有 DSH 任务运行，请稍后再试。');
      signal?.throwIfAborted();
      busy = true;
      let workspace;
      try {
        // Disposable profile/cache; the authoritative memories stay in Memoria's database.
        workspace = mkdtempSync(join(settings.hostDirectory, '.memoria-job-'));
        for (const folder of ['home', 'appdata', 'localappdata', 'tmp', 'dsh']) mkdirSync(join(workspace, folder));
        const env = {};
        for (const [key, value] of Object.entries(process.env)) {
          if (['systemroot', 'windir', 'comspec', 'path', 'pathext', 'systemdrive', 'number_of_processors', 'processor_architecture'].includes(key.toLowerCase())) env[key] = value;
        }
        Object.assign(env, { HOME: join(workspace, 'home'), USERPROFILE: join(workspace, 'home'),
          APPDATA: join(workspace, 'appdata'), LOCALAPPDATA: join(workspace, 'localappdata'),
          TEMP: join(workspace, 'tmp'), TMP: join(workspace, 'tmp'), DSH_HOME: join(workspace, 'dsh') });
        return await new Promise((accept, reject) => {
          const child = spawn(settings.nodePath, [hostScript], { cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
          let result, failure, received = false, requests = 0, stderrBytes = 0;
          const stop = message => { failure ||= new Error(message); child.kill(); };
          const timeout = setTimeout(() => stop('DSH 任务超时，未自动重试。'), 30000);
          const abort = () => stop('DSH 任务已取消。');
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
          child.stderr.on('data', chunk => {
            stderrBytes += chunk.length;
            if (stderrBytes > 65536) stop('DSH 日志超过大小限制。');
          });
          child.on('error', () => stop('DSH 子进程未能启动。'));
          child.on('spawn', () => child.send({ type: 'start', hostDirectory: settings.hostDirectory, workspace, operation: { name, args } }));
          child.on('message', message => {
            if (!message || typeof message !== 'object' || JSON.stringify(message).length > 100000) return stop('DSH 返回格式无效。');
            if (message.type === 'memory') {
              if (++requests > 10 || !memoryTools.includes(message.name) || !Number.isSafeInteger(message.id) || message.id < 1) return stop('DSH 记忆请求超出限制。');
              let response;
              try { response = { result: memory.execute(message.name, message.args) }; }
              catch (error) { response = { error: error.message }; }
              if (child.connected) child.send({ type: 'memory-result', id: message.id, ...response }, () => {});
            } else if (message.type === 'result' && !received) {
              received = true; result = message.result;
            } else if (message.type === 'failure') stop('DSH 核对未完成，请检查固定版本依赖与本机配置。');
            else stop('DSH 返回了不支持的消息。');
          });
          child.on('close', code => {
            clearTimeout(timeout); signal?.removeEventListener('abort', abort);
            if (failure || code !== 0 || !received) reject(failure || new Error('DSH 任务未正常完成。'));
            else accept(result);
          });
        });
      } finally {
        try {
          if (workspace && dirname(resolve(workspace)) === settings.hostDirectory && realpathSync(workspace) === resolve(workspace)) rmSync(workspace, { recursive: true, force: true });
        } finally { busy = false; }
      }
    },
  };
}
