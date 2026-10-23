import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const script = fileURLToPath(new URL('../scripts/dsh-im-host.js', import.meta.url));

export function createFeishuRuntime({ dataDir, getSettings, onEvent, onReady = () => {}, onPause = () => {} }) {
  let current, starting, sequence = 0, generation = 0, lastError = '', lifecycle = Promise.resolve();
  const pending = new Map();
  const closing = new Set();
  function send(state, message, failed = () => {}) {
    try {
      if (!state.child.connected) { failed(); return; }
      state.child.send(message, error => { if (error) failed(); });
    } catch { failed(); }
  }
  function configuration() {
    const path = join(dataDir, 'feishu-runtime.json');
    if (!existsSync(path)) throw new Error('请先配置本机飞书运行环境。');
    const input = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['nodePath', 'hostDirectory', 'profileDirectory', 'credentialPath'].includes(key))) throw new Error('飞书运行环境配置无效。');
    for (const key of ['nodePath', 'hostDirectory', 'profileDirectory', 'credentialPath']) {
      if (typeof input[key] !== 'string' || !isAbsolute(input[key])) throw new Error('飞书运行路径须为绝对路径。');
    }
    if (!statSync(input.nodePath, { throwIfNoEntry: false })?.isFile()
      || !statSync(join(input.hostDirectory, 'package.json'), { throwIfNoEntry: false })?.isFile()
      || !statSync(input.credentialPath, { throwIfNoEntry: false })?.isFile()) throw new Error('飞书运行环境或凭据文件不可用。');
    mkdirSync(input.profileDirectory, { recursive: true, mode: 0o700 });
    if (lstatSync(input.profileDirectory).isSymbolicLink()) throw new Error('飞书资料目录不能使用链接。');
    const config = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, realpathSync(value)]));
    const profile = resolve(config.profileDirectory), host = resolve(config.hostDirectory);
    const contains = (parent, child) => { const path = relative(parent, child); return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)); };
    if (contains(host, profile) || contains(profile, host) || contains(profile, resolve(dataDir)) || contains(profile, config.credentialPath)) {
      throw new Error('飞书须使用独立的资料目录。');
    }
    const marker = join(profile, '.memoria-feishu-profile.json');
    const expected = { version: 1, application: 'memoria-feishu', profileDirectory: profile };
    if (existsSync(marker)) {
      if (!lstatSync(marker).isFile() || lstatSync(marker).isSymbolicLink()
        || JSON.stringify(JSON.parse(readFileSync(marker, 'utf8'))) !== JSON.stringify(expected)) throw new Error('飞书资料目录归属无效。');
    } else {
      if (readdirSync(profile).length) throw new Error('首次连接飞书须使用空的专用资料目录。');
      writeFileSync(marker, JSON.stringify(expected), { flag: 'wx', mode: 0o600 });
    }
    return config;
  }
  function status() {
    return { connected: current?.ready === true, connecting: Boolean(starting), epoch: current?.epoch || '',
      botId: current?.botId || '', fingerprint: current?.fingerprint || '', proactiveReady: current?.proactiveReady === true, error: lastError };
  }
  function pause(state) {
    if (current !== state) return;
    current = undefined;
    closing.add(state);
    const timer = setTimeout(() => state.child.kill('SIGKILL'), 8000);
    state.closed.finally(() => { clearTimeout(timer); closing.delete(state); });
    for (const [id, task] of pending) { pending.delete(id); task.reject(new Error('飞书发送结果未确认。')); }
    void Promise.resolve().then(onPause).catch(() => {});
  }
  async function start() {
    if (starting) return starting;
    if (current?.ready) return status();
    if (!getSettings().enabled) return status();
    const ticket = generation;
    starting = (async () => {
      let state;
      try {
        await Promise.all([...closing].map(item => item.closed));
        if (ticket !== generation || !getSettings().enabled) return status();
        const config = configuration(), settings = getSettings();
        const environment = {};
        for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'LANG', 'TZ', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
          if (process.env[key] !== undefined) environment[key] = process.env[key];
        }
        const temporary = join(config.profileDirectory, 'tmp');
        mkdirSync(temporary, { recursive: true, mode: 0o700 });
        Object.assign(environment, { HOME: config.profileDirectory, USERPROFILE: config.profileDirectory, DSH_HOME: config.profileDirectory,
          TEMP: temporary, TMP: temporary, TMPDIR: temporary, APPDATA: join(config.profileDirectory, 'appdata'), LOCALAPPDATA: join(config.profileDirectory, 'localappdata') });
        const child = spawn(config.nodePath, [script], { cwd: config.hostDirectory, env: environment,
          windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        state = { child, epoch: randomBytes(18).toString('base64url'), ready: false, botId: settings.botId, fingerprint: settings.expectedFingerprint };
        current = state;
        state.closed = new Promise(resolveClose => child.once('close', resolveClose));
        await new Promise((accept, reject) => {
          let settled = false, errors = 0;
          const fail = () => {
            if (!state.stopping) lastError = '飞书连接未完成，请核对固定版本、账号凭据和网络后重新连接。';
            pause(state);
            child.kill();
            if (!settled) { settled = true; clearTimeout(timer); reject(new Error(lastError || '飞书连接已停止。')); }
          };
          const timer = setTimeout(fail, 60000);
          child.stderr.on('data', bytes => { errors += bytes.length; if (errors > 65536) fail(); });
          child.on('error', fail);
          child.on('close', () => { if (!settled || current === state) fail(); });
          child.on('message', message => {
            if (current !== state) return;
            if (!message || typeof message !== 'object' || Array.isArray(message) || Buffer.byteLength(JSON.stringify(message)) > 65536
              || message.epoch !== state.epoch) return fail();
            if (message.type === 'ready') {
              const descriptor = message.descriptor;
              if (state.ready || message.protocol !== 1 || descriptor?.version !== 1 || descriptor.channel !== 'feishu'
                || descriptor.botId !== state.botId || descriptor.account?.fingerprint !== state.fingerprint || descriptor.connected !== true
                || !Array.isArray(descriptor.capabilities) || !['exclusive-text-consumer', 'reply-text-checked'].every(value => descriptor.capabilities.includes(value))) return fail();
              state.ready = true; lastError = ''; settled = true; clearTimeout(timer); accept();
              state.proactiveReady = ['proactive-text-checked', 'proactive-receipt-checked', 'history-text-checked'].every(value => descriptor.capabilities.includes(value));
              void Promise.resolve().then(onReady).catch(fail);
            } else if (message.type === 'inbound') {
              if (!state.ready || !Number.isSafeInteger(message.id) || message.id < 1
                || Object.keys(message).some(key => !['type', 'epoch', 'id', 'event'].includes(key))) return fail();
              Promise.resolve().then(() => onEvent(message.event)).then(result => {
                if (current === state) send(state, { type: 'inbound-result', epoch: state.epoch, id: message.id, accepted: result?.accepted === true }, fail);
              }).catch(() => { if (current === state) send(state, { type: 'inbound-result', epoch: state.epoch, id: message.id, accepted: false }, fail); });
            } else if (message.type === 'proactive-prepared') {
              if (!state.ready || !Number.isSafeInteger(message.id) || Object.keys(message).some(key => !['type', 'epoch', 'id'].includes(key))) return fail();
              const task = pending.get(message.id);
              if (!task || task.kind !== 'proactive' || task.prepared) return;
              task.prepared = true;
              try {
                task.check();
                const result = task.beforeSend();
                if (result && typeof result.then === 'function') throw new Error('ASYNC_SEND_GUARD');
                task.check(); task.permitted = true;
                send(state, { type: 'proactive-permit', epoch: state.epoch, id: message.id, allowed: true }, task.abort);
              } catch {
                pending.delete(message.id);
                send(state, { type: 'proactive-permit', epoch: state.epoch, id: message.id, allowed: false });
                task.reject(new Error('飞书主动私聊未通过发送前核对。'));
              }
            } else if (message.type === 'proactive-result') {
              if (!state.ready || !Number.isSafeInteger(message.id) || !['sent', 'failed', 'unknown'].includes(message.outcome)
                || Object.keys(message).some(key => !['type', 'epoch', 'id', 'outcome', 'receipt', 'code'].includes(key))) return fail();
              const task = pending.get(message.id);
              if (!task) return;
              if (task.kind !== 'proactive') return fail();
              pending.delete(message.id);
              const receipt = message.receipt;
              if (message.outcome === 'sent' && task.permitted && receipt?.sent === true
                && Object.keys(receipt).length === 5 && ['sent', 'messageId', 'conversationId', 'botId', 'fingerprint'].every(key => Object.hasOwn(receipt, key))
                && typeof receipt.messageId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(receipt.messageId)
                && receipt.conversationId === task.conversationId && receipt.botId === state.botId && receipt.fingerprint === state.fingerprint) {
                try { task.check(); task.accept({ sent: true, messageId: receipt.messageId, conversationId: receipt.conversationId }); }
                catch { task.reject(new Error('飞书主动私聊结果未确认，不自动重试。')); }
              } else task.reject(new Error(task.permitted ? '飞书主动私聊结果未确认，不自动重试。' : '飞书主动私聊未通过发送前核对。'));
            } else if (message.type === 'reply-result') {
              if (!state.ready || !Number.isSafeInteger(message.id) || !['sent', 'failed', 'unknown'].includes(message.outcome)) return fail();
              const task = pending.get(message.id);
              if (!task) return;
              if (task.kind === 'proactive') return fail();
              pending.delete(message.id);
              if (message.outcome === 'sent' && message.receipt?.sent === true) task.accept(message.receipt);
              else task.reject(new Error('飞书发送结果未确认。'));
            } else if (message.type === 'stopped') pause(state);
            else fail();
          });
          child.once('spawn', () => send(state, { type: 'start', protocol: 1, epoch: state.epoch,
            hostDirectory: config.hostDirectory, profileDirectory: config.profileDirectory, credentialPath: config.credentialPath,
            botId: state.botId, expectedFingerprint: state.fingerprint }, fail));
        });
        return status();
      } catch {
        if (state?.stopping) return status();
        lastError ||= '飞书连接未完成，请检查本机运行配置。';
        if (state) pause(state);
        throw new Error(lastError);
      }
    })().finally(() => { starting = undefined; });
    return starting;
  }
  async function stop() {
    generation++;
    const state = current;
    if (!state) { await starting?.catch(() => {}); await Promise.all([...closing].map(item => item.closed)); return; }
    state.stopping = true;
    pause(state);
    send(state, { type: 'stop', epoch: state.epoch });
    await state.closed; await starting?.catch(() => {});
  }
  return {
    status, start, stop,
    restart() { lifecycle = lifecycle.catch(() => {}).then(async () => { await stop(); return start(); }); return lifecycle; },
    async sendProactive(route, text, { signal, epoch, beforeSend } = {}) {
      signal?.throwIfAborted();
      const state = current;
      let settings, runtimeSettings;
      try { settings = JSON.stringify(getSettings()); runtimeSettings = readFileSync(join(dataDir, 'feishu-runtime.json'), 'utf8'); }
      catch { throw new Error('飞书主动私聊来源或连接无效。'); }
      const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);
      if (!state?.ready || !state.proactiveReady || state.epoch !== epoch || typeof beforeSend !== 'function'
        || typeof text !== 'string' || !text.trim() || text.length > 4000 || text.includes('\0')
        || !route || typeof route !== 'object' || Array.isArray(route) || route.kind !== 'dm'
        || Object.keys(route).some(key => !['kind', 'messageId', 'conversationId', 'actorId', 'threadId', 'rootId', 'parentId'].includes(key))
        || !['messageId', 'conversationId', 'actorId'].every(key => validId(route[key]))
        || ['threadId', 'rootId', 'parentId'].some(key => route[key] !== undefined && !validId(route[key]))) throw new Error('飞书主动私聊来源或连接无效。');
      const check = () => {
        signal?.throwIfAborted();
        const next = getSettings();
        if (current !== state || !state.ready || !next.enabled || state.epoch !== epoch || next.botId !== state.botId
          || next.expectedFingerprint !== state.fingerprint || JSON.stringify(next) !== settings
          || readFileSync(join(dataDir, 'feishu-runtime.json'), 'utf8') !== runtimeSettings) throw new Error('飞书主动私聊来源或连接已变化。');
      };
      check();
      const id = ++sequence;
      return new Promise((accept, reject) => {
        const finish = action => value => { clearTimeout(timer); signal?.removeEventListener('abort', abort); action(value); };
        const abort = () => {
          if (!pending.delete(id)) return;
          if (current === state) send(state, { type: 'cancel', epoch, id });
          finish(reject)(new Error('飞书主动私聊结果未确认，不自动重试。'));
        };
        const timer = setTimeout(abort, 45000);
        pending.set(id, { kind: 'proactive', conversationId: route.conversationId, check, beforeSend, abort,
          prepared: false, permitted: false, accept: finish(accept), reject: finish(reject) });
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) return abort();
        send(state, { type: 'proactive', epoch, id, route: structuredClone(route), text }, abort);
      });
    },
    async reply(route, text, { signal, epoch, recovered = false } = {}) {
      signal?.throwIfAborted();
      const state = current;
      if (!state?.ready || state.epoch !== epoch || typeof recovered !== 'boolean' || typeof text !== 'string' || !text.trim() || text.length > 4000
        || !route || typeof route !== 'object' || Array.isArray(route)
        || Object.keys(route).some(key => !['messageId', 'conversationId', 'actorId', 'threadId', 'rootId', 'parentId'].includes(key))
        || !['messageId', 'conversationId', 'actorId'].every(key => typeof route[key] === 'string')) throw new Error('飞书回复位置或连接已失效。');
      const id = ++sequence;
      return new Promise((accept, reject) => {
        const finish = action => value => { clearTimeout(timer); signal?.removeEventListener('abort', abort); action(value); };
        const abort = () => {
          if (!pending.delete(id)) return;
          if (current === state) send(state, { type: 'cancel', epoch, id });
          finish(reject)(new Error('飞书发送结果未确认。'));
        };
        const timer = setTimeout(abort, 45000);
        pending.set(id, { accept: finish(accept), reject: finish(reject) });
        signal?.addEventListener('abort', abort, { once: true });
        send(state, { type: 'reply', epoch, id, route, text, recovered }, abort);
      });
    },
  };
}
