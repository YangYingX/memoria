import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_TRACK_BYTES = 64 * 1024 * 1024;
const MAX_TRACK_TOTAL = 96 * 1024 * 1024;
const MAX_TRACK_SECONDS = 12 * 60 * 60;
const MAX_FRAME_BYTES = 512 * 1024;
const MAX_AUDIO_BYTES = 60 * 32000;
const EXECUTION_MS = 30000;
const STOP_GRACE_MS = 500;
const CLOSE_WAIT_MS = 3500;
const fail = (message, code = 'VIDEO_PROCESS') => Object.assign(new Error(message), { code });
const cancelled = () => fail('本次视频处理已取消。', 'VIDEO_CANCELLED');

function identity(path) {
  const actual = realpathSync(path), info = statSync(actual, { bigint: true });
  if (!info.isFile() || info.size <= 0n) throw new Error();
  if (process.platform !== 'win32') accessSync(actual, constants.X_OK);
  return { path: actual, stamp: [actual, info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String).join(':') };
}

function inputBytes(bytes, maximum = MAX_INPUT_BYTES) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 16 || bytes.length > maximum
    || !bytes.subarray(4, 8).equals(Buffer.from('ftyp')) || bytes.readUInt32BE(0) < 16 || bytes.readUInt32BE(0) > bytes.length) {
    throw fail(`只支持完整的${maximum / 1024 / 1024} MiB以内MP4/MOV数据。`, 'VIDEO_INVALID_INPUT');
  }
}

function trackInput(value) {
  const keys = ['videoBytes', 'audioBytes', 'durationSeconds', 'frameTimes', 'audioStartSeconds', 'audioSeconds'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))
    || !Number.isFinite(value.durationSeconds) || value.durationSeconds <= 0 || value.durationSeconds > MAX_TRACK_SECONDS
    || !Array.isArray(value.frameTimes) || value.frameTimes.length > 8
    || value.frameTimes.some((time, index) => !Number.isFinite(time) || time < 0 || time >= value.durationSeconds || index > 0 && time <= value.frameTimes[index - 1])) {
    throw fail('分轨资料须提供12小时以内的时长与最多8个递增采样时间。', 'VIDEO_INVALID_INPUT');
  }
  const audioStartSeconds = value.audioStartSeconds ?? 0, audioSeconds = value.audioSeconds ?? 0;
  if (!Number.isFinite(audioStartSeconds) || audioStartSeconds < 0 || audioStartSeconds >= value.durationSeconds
    || !Number.isFinite(audioSeconds) || audioSeconds < 0 || audioSeconds > 60 || audioStartSeconds + audioSeconds > value.durationSeconds
    || !value.videoBytes && !value.audioBytes || value.frameTimes.length && !value.videoBytes) throw fail('音轨范围或画面来源无效。', 'VIDEO_INVALID_INPUT');
  let total = 0;
  for (const name of ['videoBytes', 'audioBytes']) if (value[name] !== undefined) { inputBytes(value[name], MAX_TRACK_BYTES); total += value[name].length; }
  if (total > MAX_TRACK_TOTAL) throw fail('分轨数据合计不能超过96 MiB。', 'VIDEO_INVALID_INPUT');
  return { durationSeconds: value.durationSeconds, frameTimes: [...value.frameTimes], audioStartSeconds, audioSeconds };
}

function trackMetadata(bytes, kind, expectedDuration) {
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw fail('分轨资料无效。', 'VIDEO_UNSUPPORTED'); }
  const duration = Number(value?.format?.duration), streams = value?.streams;
  if (!Array.isArray(streams) || !streams.length || streams.length > 4
    || streams.some(item => !item || typeof item !== 'object' || !['video', 'audio'].includes(item.codec_type))
    || !String(value?.format?.format_name || '').split(',').includes('mov')
    || !Number.isFinite(duration) || duration <= 0 || duration > MAX_TRACK_SECONDS || Math.abs(duration - expectedDuration) > 1) {
    throw fail('实际分轨时长或容器与当前视频资料不符。', 'VIDEO_UNSUPPORTED');
  }
  const videos = streams.filter(item => item.codec_type === 'video'), audios = streams.filter(item => item.codec_type === 'audio');
  if (videos.length > 1 || audios.length > 1 || kind === 'video' && videos.length !== 1 || kind === 'audio' && (audios.length !== 1 || videos.length)) {
    throw fail('分轨的音视频轨道数量不符。', 'VIDEO_UNSUPPORTED');
  }
  const video = videos[0];
  if (video && (!['h264', 'hevc', 'av1', 'mpeg4'].includes(video.codec_name) || video.disposition?.attached_pic === 1
    || !Number.isSafeInteger(video.width) || !Number.isSafeInteger(video.height) || video.width < 2 || video.height < 2
    || video.width > 3840 || video.height > 2160 || video.width * video.height > 3840 * 2160)) throw fail('分轨视频编码或尺寸暂不支持。', 'VIDEO_UNSUPPORTED');
  if (audios.some(item => item.codec_name !== 'aac')) throw fail('分轨音频目前只支持AAC。', 'VIDEO_UNSUPPORTED');
  for (const item of streams) if (item.duration !== undefined && (!Number.isFinite(Number(item.duration)) || Number(item.duration) <= 0 || Math.abs(Number(item.duration) - duration) > 1)) {
    throw fail('分轨流时长与容器不符。', 'VIDEO_UNSUPPORTED');
  }
  return { durationSeconds: duration, hasAudio: audios.length > 0 };
}

function jpegSize(bytes) {
  if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw fail('采样画面格式无效。');
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset++] !== 255) break;
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 217 || marker === 218) break;
    if (marker === 1 || marker >= 208 && marker <= 215) continue;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if ([192, 193, 194].includes(marker)) {
      if (length < 8 || bytes[offset + 2] !== 8) break;
      const height = bytes.readUInt16BE(offset + 3), width = bytes.readUInt16BE(offset + 5);
      if (width < 1 || height < 1 || width > 512 || height > 512) break;
      return { width, height };
    }
    offset += length;
  }
  throw fail('采样画面尺寸无效。');
}

function metadata(bytes) {
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw fail('视频资料无效。', 'VIDEO_UNSUPPORTED'); }
  const streams = value?.streams, rawDuration = value?.format?.duration, duration = Number(rawDuration);
  if (!['number', 'string'].includes(typeof rawDuration) || !Array.isArray(streams) || !streams.length || streams.length > 4
    || streams.some(item => !item || typeof item !== 'object' || Array.isArray(item) || typeof item.codec_type !== 'string')
    || !String(value?.format?.format_name || '').split(',').includes('mov')
    || !Number.isFinite(duration) || duration <= 0 || duration > 60) throw fail('视频须为时长明确且不超过60秒的MP4/MOV。', 'VIDEO_UNSUPPORTED');
  const videos = streams.filter(item => item.codec_type === 'video'), audio = streams.filter(item => item.codec_type === 'audio');
  const video = videos[0];
  if (videos.length !== 1 || !['h264', 'hevc', 'mpeg4'].includes(video?.codec_name)
    || !Number.isSafeInteger(video.width) || !Number.isSafeInteger(video.height) || video.width < 1 || video.width > 3840 || video.height < 1 || video.height > 2160
    || video.disposition?.attached_pic === 1) throw fail('视频编码、画面尺寸或视频轨道暂不支持。', 'VIDEO_UNSUPPORTED');
  const parts = typeof video.avg_frame_rate === 'string' ? video.avg_frame_rate.match(/^(\d{1,9})\/([1-9]\d{0,8})$/) : null;
  const rate = parts ? Number(parts[1]) / Number(parts[2]) : 30;
  const fps = Number.isFinite(rate) && rate >= 0.1 && rate <= 240 ? rate : 30;
  return { durationSeconds: duration, hasAudio: audio.length > 0, fps };
}

function wave(pcm) {
  if (pcm.length % 2 || pcm.length > MAX_AUDIO_BYTES) throw fail('音轨超过本次处理范围。', 'VIDEO_UNSUPPORTED');
  if (!pcm.length) return undefined;
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  return wav;
}

export function createVideoRuntime({ dataDir }) {
  if (typeof dataDir !== 'string' || !isAbsolute(dataDir)) throw fail('视频数据目录须为绝对路径。', 'VIDEO_NOT_READY');
  const directory = resolve(dataDir), configPath = join(directory, 'video-runtime.json');
  let active, stopped = false, cleanupFailed = false, verifiedVersion;
  const queue = [], children = new Set();

  function inspect() {
    if (!existsSync(configPath)) return { configured: false, enabled: false };
    try {
      if (!lstatSync(configPath).isFile() || statSync(configPath).size > 8192) throw new Error();
      const source = readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''), value = JSON.parse(source), keys = ['enabled', 'ffmpegPath', 'ffprobePath'];
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length
        || keys.some(key => !Object.hasOwn(value, key)) || typeof value.enabled !== 'boolean'
        || !keys.slice(1).every(key => typeof value[key] === 'string' && isAbsolute(value[key]))) throw new Error();
      if (!value.enabled) return { configured: true, enabled: false };
      const ffmpeg = identity(value.ffmpegPath), ffprobe = identity(value.ffprobePath);
      const fingerprint = createHash('sha256').update(JSON.stringify([source, ffmpeg.stamp, ffprobe.stamp])).digest('hex');
      return { configured: true, enabled: true, ffmpeg, ffprobe, fingerprint };
    } catch { throw fail('本地视频工具配置或文件不可用，请重新准备视频运行层。', 'VIDEO_NOT_READY'); }
  }

  function status() {
    const base = { configured: existsSync(configPath), enabled: false, ready: false, busy: Boolean(active) || children.size > 0, queued: queue.length };
    try {
      const config = inspect();
      return { ...base, configured: config.configured, enabled: config.enabled, ready: config.enabled && !stopped && !cleanupFailed,
        versionChecked: Boolean(config.fingerprint && config.fingerprint === verifiedVersion),
        ...(cleanupFailed ? { error: '视频进程退出或临时文件清理尚未确认，已暂停新的处理。' } : {}) };
    } catch (error) { return { ...base, error: error.message }; }
  }

  function current(task) {
    task.controller.signal.throwIfAborted();
    task.signal?.throwIfAborted();
    if (stopped || cleanupFailed) throw cancelled();
    task.assertActive?.();
    const config = inspect();
    if (!config.enabled || config.fingerprint !== task.fingerprint) throw cancelled();
    return config;
  }

  function run(path, args, task, maxBytes) {
    current(task);
    return new Promise((accept, reject) => {
      let child, failure, outputBytes = 0, logBytes = 0, killTimer, joinTimer, guard, settled = false;
      const chunks = [], record = { child: null, closed: false };
      const done = (error, value) => { if (settled) return; settled = true; clearInterval(guard); error ? reject(error) : accept(value); };
      const stopChild = error => {
        failure ||= error;
        if (record.closed || record.stopping) return;
        record.stopping = true;
        try { child.kill('SIGTERM'); } catch { /* Still wait for this exact child. */ }
        killTimer = setTimeout(() => { if (!record.closed) try { child.kill('SIGKILL'); } catch { /* The join gate below reports uncertainty. */ } }, STOP_GRACE_MS);
        joinTimer = setTimeout(() => {
          if (record.closed) return;
          cleanupFailed = true;
          done(fail('视频进程尚未确认退出，临时文件未清理，新的处理已暂停。', 'VIDEO_PROCESS_EXIT_UNCONFIRMED'));
        }, CLOSE_WAIT_MS);
        killTimer.unref?.(); joinTimer.unref?.();
      };
      const abort = () => stopChild(task.controller.signal.reason?.code ? task.controller.signal.reason : cancelled());
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => ['path', 'systemroot', 'windir', 'comspec', 'pathext', 'temp', 'tmp'].includes(name.toLowerCase())));
      try { child = spawn(path, args, { cwd: task.work, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch { done(fail('视频工具未能启动。')); return; }
      record.child = child; children.add(record);
      guard = setInterval(() => { try { current(task); } catch (error) { stopChild(error); } }, 250);
      guard.unref?.();
      child.stdout.on('data', chunk => {
        if (failure) return;
        outputBytes += chunk.length;
        if (outputBytes > maxBytes) stopChild(fail('视频工具输出超过本次大小限制。', 'VIDEO_UNSUPPORTED'));
        else chunks.push(Buffer.from(chunk));
      });
      child.stderr.on('data', chunk => { logBytes += chunk.length; if (logBytes > 32768) stopChild(fail('视频工具日志超过大小限制。')); });
      child.once('error', () => stopChild(fail('视频工具未能正常运行。')));
      child.once('close', code => {
        record.closed = true; children.delete(record); clearTimeout(killTimer); clearTimeout(joinTimer);
        task.controller.signal.removeEventListener('abort', abort);
        if (failure) done(failure);
        else if (code !== 0) done(fail('视频没有完成解码，未自动重试。'));
        else { try { current(task); done(null, Buffer.concat(chunks, outputBytes)); } catch (error) { done(error); } }
      });
      task.controller.signal.addEventListener('abort', abort, { once: true });
      if (task.controller.signal.aborted) abort();
    });
  }

  const inputOptions = ['-max_alloc', '67108864', '-probesize', '5242880', '-analyzeduration', '5000000', '-max_probe_packets', '1024', '-max_streams', '4',
    '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov', '-enable_drefs', '0', '-use_absolute_path', '0', '-f', 'mov'];
  async function checkVersion(config, task) {
    if (verifiedVersion === config.fingerprint) return;
    for (const name of ['ffmpeg', 'ffprobe']) {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await run(config[name].path, ['-version'], task, 32768));
      if (!new RegExp('^' + name + ' version n?9\\.0(?:\\.|[-\\s])').test(text) || !text.includes('configuration:')
        || /--enable-(?:gpl|nonfree)(?:\s|$)/.test(text)) throw fail('视频工具须为固定9.0分支的LGPL构建。', 'VIDEO_NOT_READY');
    }
    verifiedVersion = config.fingerprint;
  }

  function removeWork(task) {
    if (!task.work) return;
    if (children.size) { cleanupFailed = true; throw fail('视频进程退出尚未确认，临时文件未清理。', 'VIDEO_PROCESS_EXIT_UNCONFIRMED'); }
    const actual = realpathSync(task.work), parent = realpathSync(task.workRoot), entries = readdirSync(actual, { withFileTypes: true });
    if (dirname(actual) !== parent || !basename(actual).startsWith('video-job-') || lstatSync(task.work).isSymbolicLink()
      || entries.length > 2 || entries.some(item => !['input.mp4', 'audio.mp4'].includes(item.name) || !item.isFile() || item.isSymbolicLink())) {
      cleanupFailed = true; throw fail('视频临时目录变化，未清理未知文件。', 'VIDEO_CLEANUP');
    }
    for (const item of entries) unlinkSync(join(actual, item.name)); rmdirSync(actual);
  }

  async function processTask(task) {
    const config = current(task), root = realpathSync(directory), workRoot = join(root, 'video-work');
    if (!existsSync(workRoot)) mkdirSync(workRoot, { mode: 0o700 });
    if (!lstatSync(workRoot).isDirectory() || lstatSync(workRoot).isSymbolicLink() || realpathSync(workRoot) !== workRoot) throw fail('视频工作目录不可用。', 'VIDEO_NOT_READY');
    task.workRoot = workRoot; task.work = mkdtempSync(join(workRoot, 'video-job-'));
    const input = join(task.work, 'input.mp4');
    try {
      writeFileSync(input, task.bytes, { flag: 'wx', mode: 0o600 }); task.bytes = null;
      await checkVersion(config, task);
      const data = metadata(await run(config.ffprobe.path, ['-v', 'error', ...inputOptions, '-show_entries',
        'format=format_name,duration:stream=index,codec_type,codec_name,width,height,duration,avg_frame_rate:stream_disposition=attached_pic', '-of', 'json', input], task, 65536));
      const count = Math.max(1, Math.min(8, Math.ceil(data.durationSeconds / 2)));
      const tail = Math.min(data.durationSeconds, Math.max(0.1, 2 / data.fps));
      const last = Math.max(0, data.durationSeconds - tail), frames = [], frameSeconds = [];
      for (let index = 0; index < count; index++) {
        const seconds = count === 1 ? 0 : Math.round(last * index / (count - 1) * 1000000) / 1000000;
        const bytes = await run(config.ffmpeg.path, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '2', '-filter_threads', '1', ...inputOptions,
          '-ss', seconds.toFixed(6), '-i', input, '-map', '0:v:0', '-an', '-sn', '-dn', '-frames:v', '1',
          '-vf', "scale=w='min(512,iw)':h='min(512,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
          '-c:v', 'mjpeg', '-q:v', '4', '-threads', '2', '-map_metadata', '-1', '-f', 'image2pipe', 'pipe:1'], task, MAX_FRAME_BYTES);
        if (!bytes.length) continue;
        if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw fail('没有取得有效的采样画面。');
        frames.push({ mimeType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,' + bytes.toString('base64') }); frameSeconds.push(seconds);
      }
      if (!frames.length) throw fail('本次没有取得可用画面，未将视频当作已观看。');
      let wav;
      if (data.hasAudio) wav = wave(await run(config.ffmpeg.path, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '2', '-filter_threads', '1', ...inputOptions,
        '-i', input, '-map', '0:a:0', '-vn', '-sn', '-dn', '-t', '60', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-threads', '2', '-f', 's16le', 'pipe:1'], task, MAX_AUDIO_BYTES));
      current(task);
      return { durationSeconds: data.durationSeconds, hasAudio: data.hasAudio, frameSeconds, frames, ...(wav ? { wav } : {}) };
    } finally { removeWork(task); }
  }

  async function processTracksTask(task) {
    const config = current(task), root = realpathSync(directory), workRoot = join(root, 'video-work');
    if (!existsSync(workRoot)) mkdirSync(workRoot, { mode: 0o700 });
    if (!lstatSync(workRoot).isDirectory() || lstatSync(workRoot).isSymbolicLink() || realpathSync(workRoot) !== workRoot) throw fail('视频工作目录不可用。', 'VIDEO_NOT_READY');
    task.workRoot = workRoot; task.work = mkdtempSync(join(workRoot, 'video-job-'));
    const paths = {}, probes = {}, request = task.tracks;
    try {
      for (const name of ['video', 'audio']) if (task[name + 'Bytes']) {
        paths[name] = join(task.work, name === 'video' ? 'input.mp4' : 'audio.mp4');
        writeFileSync(paths[name], task[name + 'Bytes'], { flag: 'wx', mode: 0o600 }); task[name + 'Bytes'] = null;
      }
      await checkVersion(config, task);
      for (const name of Object.keys(paths)) probes[name] = trackMetadata(await run(config.ffprobe.path, ['-v', 'error', ...inputOptions, '-show_entries',
        'format=format_name,duration:stream=index,codec_type,codec_name,width,height,duration:stream_disposition=attached_pic', '-of', 'json', paths[name]], task, 65536), name, request.durationSeconds);
      const durationSeconds = (probes.video || probes.audio).durationSeconds, frames = [];
      for (const at of request.frameTimes) {
        if (at >= probes.video.durationSeconds) throw fail('采样时间超过实际视频时长。', 'VIDEO_UNSUPPORTED');
        const bytes = await run(config.ffmpeg.path, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '2', '-filter_threads', '1', ...inputOptions,
          '-ss', at.toFixed(6), '-i', paths.video, '-map', '0:v:0', '-an', '-sn', '-dn', '-frames:v', '1',
          '-vf', "scale=w='min(512,iw)':h='min(512,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
          '-c:v', 'mjpeg', '-q:v', '4', '-threads', '2', '-map_metadata', '-1', '-f', 'image2pipe', 'pipe:1'], task, MAX_FRAME_BYTES);
        frames.push({ at, bytes, mimeType: 'image/jpeg', sha256: createHash('sha256').update(bytes).digest('hex'), ...jpegSize(bytes) });
      }
      const audioInput = paths.audio || paths.video, audioProbe = probes.audio || probes.video;
      let audio, audioState = request.audioSeconds ? 'no_track' : 'not_requested';
      if (request.audioSeconds && audioProbe.hasAudio) {
        if (request.audioStartSeconds >= audioProbe.durationSeconds || request.audioStartSeconds + request.audioSeconds > audioProbe.durationSeconds + 0.05) throw fail('请求音频范围超过实际音轨时长。', 'VIDEO_UNSUPPORTED');
        const pcm = await run(config.ffmpeg.path, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '2', '-filter_threads', '1', ...inputOptions,
          '-ss', request.audioStartSeconds.toFixed(6), '-i', audioInput, '-map', '0:a:0', '-vn', '-sn', '-dn', '-t', request.audioSeconds.toFixed(6),
          '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-threads', '2', '-f', 's16le', 'pipe:1'], task, MAX_AUDIO_BYTES);
        if (pcm.length > Math.ceil(request.audioSeconds * 32000) + 2) throw fail('解码音频超过指定片段范围。', 'VIDEO_UNSUPPORTED');
        const wav = wave(pcm);
        audioState = wav ? 'extracted' : 'empty';
        if (wav) audio = { wav, audioSeconds: pcm.length / 32000, startSeconds: request.audioStartSeconds, endSeconds: request.audioStartSeconds + pcm.length / 32000 };
      }
      current(task);
      return { durationSeconds, frames, ...(audio ? { audio } : {}), audioState };
    } finally { removeWork(task); }
  }

  function pump() {
    if (active || !queue.length) return;
    if (stopped || cleanupFailed) { for (const task of queue.splice(0)) { task.signal?.removeEventListener('abort', task.abort); task.bytes = task.videoBytes = task.audioBytes = null; task.reject(cancelled()); task.doneResolve(); } return; }
    const task = active = queue.shift();
    task.timer = setTimeout(() => task.controller.abort(fail('视频处理超时，未自动重试。', 'VIDEO_TIMEOUT')), EXECUTION_MS);
    task.timer.unref?.();
    (async () => {
      try { task.resolve(await (task.tracks ? processTracksTask(task) : processTask(task))); } catch (error) { task.reject(error); }
      finally { clearTimeout(task.timer); task.signal?.removeEventListener('abort', task.abort); task.bytes = task.videoBytes = task.audioBytes = null; active = null; task.doneResolve(); pump(); }
    })();
  }

  function submit(input, { signal, assertActive } = {}, tracks) {
    try {
      if (stopped || cleanupFailed) throw cancelled();
      if (signal !== undefined && !(signal instanceof AbortSignal) || assertActive !== undefined && typeof assertActive !== 'function') throw fail('视频取消或来源核对方式无效。', 'VIDEO_INVALID_INPUT');
      signal?.throwIfAborted(); assertActive?.();
      const request = tracks ? trackInput(input) : inputBytes(input);
      const config = inspect();
      if (!config.enabled) throw fail('本地视频处理尚未启用。', 'VIDEO_DISABLED');
      if (queue.length >= 2) throw fail('已有视频等待处理，请稍后再发。', 'VIDEO_BUSY');
      return new Promise((accept, reject) => {
        const task = { ...(tracks ? { tracks: request, ...(input.videoBytes ? { videoBytes: Buffer.from(input.videoBytes) } : {}), ...(input.audioBytes ? { audioBytes: Buffer.from(input.audioBytes) } : {}) } : { bytes: Buffer.from(input) }),
          fingerprint: config.fingerprint, signal, assertActive, controller: new AbortController(), resolve: accept, reject };
        task.done = new Promise(resolve => { task.doneResolve = resolve; });
        task.abort = () => {
          if (active === task) task.controller.abort(cancelled());
          else { const index = queue.indexOf(task); if (index >= 0) queue.splice(index, 1); signal.removeEventListener('abort', task.abort); task.bytes = task.videoBytes = task.audioBytes = null; reject(cancelled()); task.doneResolve(); }
        };
        signal?.addEventListener('abort', task.abort, { once: true }); queue.push(task);
        if (signal?.aborted) task.abort();
        pump();
      });
    } catch (error) { return Promise.reject(error); }
  }

  const extract = (bytes, options) => submit(bytes, options, false);
  const analyzeTracks = (input, options) => submit(input, options, true);

  async function cancel() {
    for (const task of queue.splice(0)) { task.signal?.removeEventListener('abort', task.abort); task.bytes = task.videoBytes = task.audioBytes = null; task.reject(cancelled()); task.doneResolve(); }
    const task = active; task?.controller.abort(cancelled()); await task?.done;
    if (children.size) throw fail('视频进程尚未确认退出。', 'VIDEO_PROCESS_EXIT_UNCONFIRMED');
  }
  async function stop() { stopped = true; await cancel(); }
  return { status, extract, analyze: extract, analyzeTracks, cancel, stop };
}
