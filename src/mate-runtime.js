import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeCompanionState } from './companion-state.js';

export const matePins = Object.freeze(JSON.parse(readFileSync(new URL('../deploy/mate/pins.json', import.meta.url), 'utf8')));
const hostScript = fileURLToPath(new URL('../scripts/mate-host.js', import.meta.url));
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fields = (value, names) => object(value) && Object.keys(value).every(key => names.includes(key));
const messages = { MATE_DISABLED: '陪伴行为内核尚未启用。', CONFIG_INVALID: '请检查本机陪伴内核运行环境。',
  INPUT_INVALID: '陪伴状态或联系人时间窗口无法核对，本次保持安静。', CANCELLED: '陪伴行为判断已取消。',
  BUSY: '已有陪伴行为判断运行。', FAILED: '陪伴行为判断未完成，本次保持安静。' };
export function mateFailure(code) { const error = new Error(messages[code] || messages.FAILED); error.code = messages[code] ? code : 'FAILED'; return error; }

export function verifyMatePackage(packageDirectory) {
  try {
    if (typeof packageDirectory !== 'string' || !isAbsolute(packageDirectory)) throw new Error();
    const directory = realpathSync(packageDirectory);
    if (!lstatSync(directory).isDirectory() || directory.split(/[\\/]/).includes('node_modules')) throw new Error();
    for (const [relative, expected] of Object.entries(matePins.files)) {
      const path = join(directory, relative);
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || realpathSync(path) !== path
        || createHash('sha256').update(readFileSync(path)).digest('hex') !== expected) throw new Error();
    }
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    if (manifest.name !== matePins.name || manifest.version !== matePins.version) throw new Error();
    return directory;
  } catch { throw mateFailure('CONFIG_INVALID'); }
}

export function normalizeMateInput(value) {
  try {
    if (!fields(value, ['state', 'now', 'timeZone', 'contacts', 'unanswered', 'recentProactive'])
      || !Number.isSafeInteger(value.now) || value.now < 0 || value.now > 8640000000000000
      || typeof value.timeZone !== 'string' || value.timeZone.length > 80
      || !Array.isArray(value.contacts) || value.contacts.length > 10000
      || ![value.unanswered, value.recentProactive].every(number => Number.isSafeInteger(number) && number >= 0 && number <= 1000)) throw new Error();
    const timeZone = new Intl.DateTimeFormat('en', { timeZone: value.timeZone }).resolvedOptions().timeZone;
    const state = normalizeCompanionState(value.state);
    if (state && state.t > value.now) throw new Error();
    const ids = new Set(); let previous = state?.t ?? 0;
    const contacts = value.contacts.map(item => {
      if (!fields(item, ['id', 'at']) || typeof item.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,127}$/.test(item.id) || ids.has(item.id)
        || !Number.isSafeInteger(item.at) || item.at < previous || item.at > value.now) throw new Error();
      previous = item.at; ids.add(item.id);
      return { id: item.id, at: item.at };
    });
    const start = state?.t ?? contacts[0]?.at ?? value.now;
    if (value.now - start > 366 * 86400000) throw new Error();
    const result = { state, now: value.now, timeZone, contacts, unanswered: value.unanswered, recentProactive: value.recentProactive };
    if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024) throw new Error();
    return result;
  } catch { throw mateFailure('INPUT_INVALID'); }
}

function normalizeResult(value) {
  if (!fields(value, ['state', 'action', 'kind', 'urgency', 'inclination', 'fatigue', 'drowsiness'])
    || !['stay_silent', 'think_only', 'reach_out'].includes(value.action)
    || ![null, 'curiosity', 'missing_user', 'observation'].includes(value.kind)
    || !Number.isFinite(value.urgency) || value.urgency < 0 || value.urgency > 2
    || !Number.isFinite(value.inclination) || value.inclination < -1 || value.inclination > 1
    || ![value.fatigue, value.drowsiness].every(number => Number.isFinite(number) && number >= 0 && number <= 1)
    || (value.action === 'stay_silent' && (value.kind !== null || value.urgency !== 0))
    || (value.action !== 'stay_silent' && value.kind === null)) throw mateFailure('FAILED');
  return { state: normalizeCompanionState(value.state), action: value.action, kind: value.kind,
    urgency: value.urgency, inclination: value.inclination, fatigue: value.fatigue, drowsiness: value.drowsiness };
}

export function createMateRuntime({ dataDir }) {
  const directory = resolve(dataDir);
  let busy = false, stopped = false, current, drained = Promise.resolve();
  function config() {
    const path = join(directory, 'mate-runtime.json');
    if (!existsSync(path)) return { enabled: false };
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'));
      if (!fields(value, ['enabled', 'nodePath', 'packageDirectory']) || typeof value.enabled !== 'boolean') throw new Error();
      if (!value.enabled) return { enabled: false };
      if (typeof value.nodePath !== 'string' || !isAbsolute(value.nodePath)) throw new Error();
      const nodePath = realpathSync(value.nodePath);
      if (!statSync(nodePath).isFile()) throw new Error();
      return { enabled: true, nodePath, packageDirectory: verifyMatePackage(value.packageDirectory) };
    } catch { throw mateFailure('CONFIG_INVALID'); }
  }
  return {
    status() {
      const result = { enabled: false, ready: false, busy, engine: 'dsh-mate-companion', version: matePins.version, error: null };
      try { const value = config(); result.enabled = value.enabled; result.ready = value.enabled && !stopped; }
      catch (error) { result.error = messages[error.code] || messages.FAILED; }
      return result;
    },
    async assess({ signal, ...raw }) {
      if (stopped || signal?.aborted) throw mateFailure('CANCELLED');
      if (busy) throw mateFailure('BUSY');
      const settings = config();
      if (!settings.enabled) throw mateFailure('MATE_DISABLED');
      const input = normalizeMateInput(raw), controller = new AbortController();
      let finish, workspace;
      busy = true; drained = new Promise(accept => { finish = accept; });
      const abort = () => controller.abort(); current = abort;
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      const timeout = setTimeout(abort, 15000);
      try {
        workspace = realpathSync(mkdtempSync(join(tmpdir(), 'memoria-mate-')));
        const env = {};
        for (const [key, value] of Object.entries(process.env)) if (['systemroot', 'windir', 'comspec', 'path', 'pathext', 'systemdrive'].includes(key.toLowerCase())) env[key] = value;
        Object.assign(env, { TZ: input.timeZone, HOME: workspace, USERPROFILE: workspace, TEMP: workspace, TMP: workspace });
        const result = await new Promise((accept, reject) => {
          const child = spawn(settings.nodePath, [hostScript], { cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
          let output, failure, received = false, stderr = 0, hardTimer;
          const cancel = () => { failure ||= mateFailure('CANCELLED'); child.kill(); hardTimer ||= setTimeout(() => child.kill('SIGKILL'), 2000); };
          controller.signal.addEventListener('abort', cancel, { once: true });
          child.once('spawn', () => {
            if (controller.signal.aborted) return cancel();
            child.send({ type: 'start', packageDirectory: settings.packageDirectory, input }, error => { if (error) { failure ||= mateFailure('FAILED'); cancel(); } });
          });
          child.on('error', () => { failure ||= mateFailure('FAILED'); });
          child.stderr.on('data', part => { stderr += part.length; if (stderr > 65536) { failure ||= mateFailure('FAILED'); cancel(); } });
          child.on('message', message => {
            if (received || !fields(message, ['type', 'result', 'code']) || Buffer.byteLength(JSON.stringify(message)) > 65536) { failure ||= mateFailure('FAILED'); return cancel(); }
            received = true;
            if (message.type === 'result' && fields(message, ['type', 'result'])) output = message.result;
            else if (message.type === 'failure' && fields(message, ['type', 'code'])) failure = mateFailure(message.code === 'INPUT_INVALID' ? 'INPUT_INVALID' : 'FAILED');
            else { failure ||= mateFailure('FAILED'); cancel(); }
          });
          child.once('close', code => {
            clearTimeout(hardTimer); controller.signal.removeEventListener('abort', cancel);
            if (failure || code !== 0 || !received) reject(failure || mateFailure('FAILED')); else accept(output);
          });
          if (controller.signal.aborted) cancel();
        });
        if (controller.signal.aborted || stopped) throw mateFailure('CANCELLED');
        if (JSON.stringify(config()) !== JSON.stringify(settings)) throw mateFailure('CANCELLED');
        const safe = normalizeResult(result);
        if (!safe.state || safe.state.t !== input.now) throw mateFailure('FAILED');
        return safe;
      } catch (error) { throw messages[error?.code] ? error : mateFailure('FAILED'); }
      finally {
        clearTimeout(timeout); signal?.removeEventListener('abort', abort); controller.abort();
        try { if (workspace && dirname(workspace) === realpathSync(tmpdir()) && realpathSync(workspace) === workspace && !lstatSync(workspace).isSymbolicLink()) rmSync(workspace, { recursive: true, force: true }); } catch {}
        busy = false; current = undefined; finish();
      }
    },
    stop() { stopped = true; current?.(); return drained; },
  };
}
