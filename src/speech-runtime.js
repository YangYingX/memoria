import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export const speechAssets = {
  model: { name: 'model.int8.onnx', bytes: 239233841, sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
    url: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/model.int8.onnx' },
  tokens: { name: 'tokens.txt', bytes: 315894, sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
    url: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/tokens.txt' },
  vad: { name: 'silero_vad.onnx', bytes: 1807522, sha256: 'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28',
    url: 'https://huggingface.co/csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc/silero_vad.onnx' },
};
export const speechWorkerPins = { name: '@deepseek-ai/dsh-experimental-speech-to-text-sensevoice', version: '0.2.1-rc.2',
  workerSha256: 'cf530352910d233d96eed917a7ff5ef8b64632491c3cd2ebfdc89377eb24a2ec', sherpaVersion: '1.13.8' };

const MAX_AUDIO_BYTES = 44 + 60 * 32000;
const START_TIMEOUT = 60000;
const INFERENCE_TIMEOUT = 60000;
const IDLE_TIMEOUT = 60000;
const MAX_RESPONSE_BYTES = 65536;
const error = (message, code = 'SPEECH_RUNTIME') => Object.assign(new Error(message), { code });
const cancelled = () => error('本次语音识别已取消。', 'SPEECH_CANCELLED');

function waveSeconds(wav) {
  if (!Buffer.isBuffer(wav) || wav.length < 46 || wav.length > MAX_AUDIO_BYTES || (wav.length - 44) % 2
    || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.readUInt32LE(4) !== wav.length - 8
    || wav.toString('ascii', 8, 16) !== 'WAVEfmt ' || wav.readUInt32LE(16) !== 16 || wav.readUInt16LE(20) !== 1
    || wav.readUInt16LE(22) !== 1 || wav.readUInt32LE(24) !== 16000 || wav.readUInt32LE(28) !== 32000
    || wav.readUInt16LE(32) !== 2 || wav.readUInt16LE(34) !== 16 || wav.toString('ascii', 36, 40) !== 'data'
    || wav.readUInt32LE(40) !== wav.length - 44) throw error('语音须为60秒以内的16 kHz单声道PCM16 WAV。', 'SPEECH_INVALID_AUDIO');
  return (wav.length - 44) / 32000;
}

function digestFile(path) {
  const hash = createHash('sha256'), chunk = Buffer.allocUnsafe(1024 * 1024), fd = openSync(path, 'r');
  try { let size; while ((size = readSync(fd, chunk, 0, chunk.length, null))) hash.update(chunk.subarray(0, size)); }
  finally { closeSync(fd); }
  return hash.digest('hex');
}

function fileIdentity(path) {
  const actual = realpathSync(path), info = statSync(actual, { bigint: true });
  if (!info.isFile()) throw error('本地语音识别所需文件尚未准备好。', 'SPEECH_NOT_READY');
  return { path: actual, size: Number(info.size), stamp: [actual, info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String).join(':') };
}

export function createSpeechRuntime({ dataDir }) {
  if (typeof dataDir !== 'string' || !isAbsolute(dataDir)) throw error('语音数据目录须为绝对路径。', 'SPEECH_NOT_READY');
  const directory = resolve(dataDir), settingsPath = join(directory, 'speech-runtime.json');
  let verified, worker, active, idleTimer, stopped = false, cleanupFailed = false;
  const queue = [];

  function inspect() {
    if (!existsSync(settingsPath)) return { configured: false, enabled: false };
    try {
      if (statSync(settingsPath).size > 8192) throw new Error();
      const source = readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, ''), config = JSON.parse(source);
      const keys = ['enabled', 'nodePath', 'hostDirectory', 'modelDirectory', 'vadModelPath'];
      if (!config || typeof config !== 'object' || Array.isArray(config) || typeof config.enabled !== 'boolean'
        || Object.keys(config).some(key => !keys.includes(key))) throw new Error();
      if (!config.enabled) return { configured: true, enabled: false };
      if (!keys.slice(1).every(key => typeof config[key] === 'string' && isAbsolute(config[key]))) throw new Error();
      const host = realpathSync(config.hostDirectory), packageRoot = join(host, 'node_modules', speechWorkerPins.name);
      const paths = { node: fileIdentity(config.nodePath), manifest: fileIdentity(join(packageRoot, 'package.json')),
        worker: fileIdentity(join(packageRoot, 'lib/worker.js')), sherpa: fileIdentity(join(host, 'node_modules/sherpa-onnx-node/package.json')),
        model: fileIdentity(join(config.modelDirectory, speechAssets.model.name)), tokens: fileIdentity(join(config.modelDirectory, speechAssets.tokens.name)),
        vad: fileIdentity(config.vadModelPath) };
      const fingerprint = createHash('sha256').update(source + JSON.stringify(Object.values(paths).map(item => item.stamp))).digest('hex');
      if (verified?.fingerprint !== fingerprint) {
        const manifest = JSON.parse(readFileSync(paths.manifest.path, 'utf8')), sherpa = JSON.parse(readFileSync(paths.sherpa.path, 'utf8'));
        if (manifest.name !== speechWorkerPins.name || manifest.version !== speechWorkerPins.version
          || sherpa.name !== 'sherpa-onnx-node' || sherpa.version !== speechWorkerPins.sherpaVersion
          || digestFile(paths.worker.path) !== speechWorkerPins.workerSha256) throw new Error();
        for (const name of ['model', 'tokens', 'vad']) {
          if (paths[name].size !== speechAssets[name].bytes || digestFile(paths[name].path) !== speechAssets[name].sha256) throw new Error();
        }
        verified = { fingerprint, paths };
      }
      return { configured: true, enabled: true, ...verified };
    } catch { throw error('本地语音配置、固定版本或模型校验未通过，请重新准备语音运行层。', 'SPEECH_NOT_READY'); }
  }

  function status() {
    const base = { configured: existsSync(settingsPath), enabled: false, ready: false, busy: Boolean(active), queued: queue.length, provider: 'sensevoice-local' };
    try {
      const config = inspect();
      return { ...base, configured: config.configured, enabled: config.enabled, ready: config.enabled && !stopped && !cleanupFailed,
        ...(cleanupFailed ? { error: '语音子进程尚未确认退出，请重启语音运行层。' } : {}) };
    } catch (failure) { return { ...base, error: failure.message }; }
  }

  async function terminate(current) {
    if (!current) return;
    if (!current.stopping) current.stopping = Promise.resolve().then(async () => {
      if (!current.closed) {
        try { current.child.kill('SIGTERM'); }
        catch { cleanupFailed = true; throw error('语音子进程尚未确认退出。'); }
        const grace = setTimeout(() => { if (!current.closed) try { current.child.kill('SIGKILL'); } catch { cleanupFailed = true; } }, 1000);
        let deadline;
        try {
          await Promise.race([current.exited, new Promise((_, reject) => { deadline = setTimeout(() => reject(error('语音子进程尚未确认退出。')), 4000); })]);
        } catch (failure) { cleanupFailed = true; throw failure; }
        finally { clearTimeout(grace); clearTimeout(deadline); }
      }
      if (worker === current) worker = null;
    });
    return current.stopping;
  }

  async function start(config, signal) {
    clearTimeout(idleTimer);
    if (worker?.stopping || worker?.invalid || worker && worker.fingerprint !== config.fingerprint) await terminate(worker);
    if (worker?.closed) worker = null;
    if (worker) return worker;
    const token = randomBytes(32).toString('hex'), env = {};
    for (const [key, value] of Object.entries(process.env)) if (['path', 'systemroot', 'windir', 'comspec', 'pathext', 'temp', 'tmp'].includes(key.toLowerCase())) env[key] = value;
    Object.assign(env, { DSH_SPEECH_TOKEN: token, ELECTRON_RUN_AS_NODE: '1' });
    const configJson = { dataRoot: directory, model: config.paths.model.path, tokens: config.paths.tokens.path, vad: config.paths.vad.path,
      threads: 2, maxAudioBytes: MAX_AUDIO_BYTES, inferenceTimeoutMs: INFERENCE_TIMEOUT };
    const child = spawn(config.paths.node.path, [config.paths.worker.path, JSON.stringify(configJson)],
      { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let acceptExit, acceptReady, rejectReady, ready = false, stdout = '', stdoutBytes = 0, stderrBytes = 0;
    const current = worker = { child, token, fingerprint: config.fingerprint, closed: false,
      exited: new Promise(accept => { acceptExit = accept; }), ready: new Promise((accept, reject) => { acceptReady = accept; rejectReady = reject; }) };
    const invalid = () => {
      current.invalid = true;
      const failure = error('本地语音子进程未返回有效就绪信息。');
      rejectReady(failure);
      if (worker === current) {
        if (active) active.controller.abort(failure);
        else terminate(current).catch(() => {});
      }
    };
    child.on('error', invalid);
    child.once('close', () => { current.closed = true; acceptExit(); rejectReady(error('本地语音子进程已退出。')); });
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 16384) invalid(); });
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 4096 || ready && chunk.toString().trim()) return invalid();
      if (ready) return;
      stdout += chunk.toString();
      const end = stdout.indexOf('\n');
      if (end < 0) return;
      try {
        const frame = JSON.parse(stdout.slice(0, end));
        if (!frame || Object.keys(frame).length !== 1 || !Number.isSafeInteger(frame.port) || frame.port < 1 || frame.port > 65535 || stdout.slice(end + 1).trim()) throw new Error();
        current.port = frame.port; ready = true; acceptReady();
      } catch { invalid(); }
    });
    const abort = () => rejectReady(cancelled());
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => rejectReady(error('本地语音模型启动超时。')), START_TIMEOUT);
    try { signal.throwIfAborted(); await current.ready; signal.throwIfAborted(); return current; }
    catch (failure) { await terminate(current); throw failure; }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }

  function assertCurrent(task) {
    task.controller.signal.throwIfAborted();
    task.signal?.throwIfAborted();
    if (stopped || cleanupFailed) throw cancelled();
    let config;
    try { task.assertActive?.(); config = inspect(); } catch { throw cancelled(); }
    if (!config.enabled || config.fingerprint !== task.fingerprint) throw cancelled();
    return config;
  }

  async function execute(task) {
    let current, guard, timeout;
    try {
      const config = assertCurrent(task);
      guard = setInterval(() => { try { assertCurrent(task); } catch { task.controller.abort(cancelled()); } }, 250);
      current = await start(config, task.controller.signal);
      assertCurrent(task);
      timeout = setTimeout(() => task.controller.abort(error('本地语音识别超时，请重新发送。', 'SPEECH_TIMEOUT')), INFERENCE_TIMEOUT);
      const response = await fetch(`http://127.0.0.1:${current.port}/transcribe?language=auto`, { method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${current.token}`, 'Content-Type': 'audio/wav' }, body: task.wav, signal: task.controller.signal });
      if (!response.ok) { await response.body?.cancel(); throw error('本地语音识别未完成，请重新发送。'); }
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length; if (bytes > MAX_RESPONSE_BYTES) throw error('语音识别结果超过长度限制。');
        chunks.push(chunk);
      }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 3
        || !['text', 'audioSeconds', 'inferenceSeconds'].every(key => Object.hasOwn(result, key))
        || typeof result.text !== 'string' || result.text.length > 8000 || !result.text.isWellFormed() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result.text)
        || typeof result.audioSeconds !== 'number' || !Number.isFinite(result.audioSeconds) || Math.abs(result.audioSeconds - task.seconds) > 0.001
        || typeof result.inferenceSeconds !== 'number' || !Number.isFinite(result.inferenceSeconds) || result.inferenceSeconds < 0) throw error('本地语音识别返回格式无效。');
      assertCurrent(task);
      if (current.closed || current.invalid) throw error('本地语音子进程状态已变化。');
      return { text: result.text.trim(), audioSeconds: result.audioSeconds, inferenceSeconds: result.inferenceSeconds };
    } catch (failure) {
      await terminate(current || worker);
      if (task.controller.signal.aborted) throw task.controller.signal.reason;
      throw typeof failure.code === 'string' && failure.code.startsWith('SPEECH_') ? failure : error('本地语音识别未完成，请稍后重新发送。');
    } finally { clearInterval(guard); clearTimeout(timeout); }
  }

  function idle() {
    clearTimeout(idleTimer);
    if (!active && !queue.length && worker) {
      const current = worker;
      idleTimer = setTimeout(() => { if (!active && !queue.length && worker === current) terminate(current).catch(() => {}); }, IDLE_TIMEOUT);
      idleTimer.unref();
    }
  }

  function pump() {
    if (cleanupFailed) for (const task of queue.splice(0)) { task.signal?.removeEventListener('abort', task.abort); task.reject(error('语音子进程尚未确认退出，请重启语音运行层。')); }
    if (active || stopped || cleanupFailed || !queue.length) return idle();
    const task = active = queue.shift();
    const finish = () => {
      task.signal?.removeEventListener('abort', task.abort);
      active = null; pump();
    };
    task.done = execute(task).then(result => { finish(); task.accept(result); }, failure => { finish(); task.reject(failure); });
  }

  function transcribe(wav, { signal, assertActive } = {}) {
    try {
      const seconds = waveSeconds(wav);
      if (signal !== undefined && !(signal instanceof AbortSignal) || assertActive !== undefined && typeof assertActive !== 'function') throw error('语音取消或来源核对配置无效。');
      signal?.throwIfAborted(); assertActive?.();
      if (stopped || cleanupFailed) throw cancelled();
      const config = inspect();
      if (!config.enabled) throw error('尚未开启本地语音识别。', 'SPEECH_DISABLED');
      if (queue.length >= 2) throw error('已有语音等待识别，请稍后重新发送。', 'SPEECH_BUSY');
      signal?.throwIfAborted();
      return new Promise((accept, reject) => {
        const task = { wav, seconds, signal, assertActive, fingerprint: config.fingerprint, controller: new AbortController(), accept, reject };
        task.abort = () => {
          if (active === task) task.controller.abort(cancelled());
          else { const index = queue.indexOf(task); if (index >= 0) queue.splice(index, 1); signal.removeEventListener('abort', task.abort); reject(cancelled()); }
        };
        signal?.addEventListener('abort', task.abort, { once: true });
        queue.push(task); pump();
      });
    } catch (failure) { return Promise.reject(typeof failure.code === 'string' && failure.code.startsWith('SPEECH_') ? failure : cancelled()); }
  }

  async function cancel() {
    clearTimeout(idleTimer);
    for (const task of queue.splice(0)) { task.signal?.removeEventListener('abort', task.abort); task.reject(cancelled()); }
    const task = active;
    task?.controller.abort(cancelled());
    await terminate(worker);
    await task?.done;
  }
  async function stop() { stopped = true; await cancel(); }
  return { status, transcribe, cancel, stop };
}
