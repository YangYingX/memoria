const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_WAV_BYTES = 6 * 1024 * 1024;
const MAX_AUDIO_SECONDS = 60;
const OUTPUT_RATE = 16000;

function validFile(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,1023}$/.test(value) && !value.includes('..');
}

export function parseQQVoice(event) {
  const segments = Array.isArray(event?.message) ? event.message : [];
  const records = segments.filter(segment => segment?.type === 'record');
  if (!records.length) return undefined;
  if (records.length !== 1 || segments.some(segment => ['image', 'file', 'onlinefile', 'flashtransfer', 'video'].includes(segment?.type))) {
    return { unsupported: true, reason: '请单独发送一条不超过60秒的语音，不要与图片、视频或文件混合。' };
  }
  const file = records[0].data?.file;
  if (!validFile(file)) return { unsupported: true, reason: '没有收到有效的语音标识，请重新发送语音。' };
  return { file };
}

function canonicalWav(bytes) {
  const invalid = () => { throw new Error('语音格式无效，需要完整的单声道 PCM16 WAV。'); };
  if (bytes.length < 44 || bytes.length > MAX_WAV_BYTES || bytes.toString('latin1', 0, 4) !== 'RIFF'
    || bytes.toString('latin1', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) !== bytes.length - 8) invalid();
  let format, samples, offset = 12;
  while (offset + 8 <= bytes.length) {
    const name = bytes.toString('latin1', offset, offset + 4), size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8, end = start + size, next = end + (size & 1);
    if (end > bytes.length || next > bytes.length) invalid();
    if (name === 'fmt ') {
      if (format || ![16, 18].includes(size) || (size === 18 && bytes.readUInt16LE(start + 16) !== 0)) invalid();
      const rate = bytes.readUInt32LE(start + 4);
      if (bytes.readUInt16LE(start) !== 1 || bytes.readUInt16LE(start + 2) !== 1 || rate < 8000 || rate > 48000
        || bytes.readUInt32LE(start + 8) !== rate * 2 || bytes.readUInt16LE(start + 12) !== 2 || bytes.readUInt16LE(start + 14) !== 16) invalid();
      format = { rate };
    } else if (name === 'data') {
      if (samples || !size || size % 2) invalid();
      samples = bytes.subarray(start, end);
    }
    offset = next;
  }
  if (offset !== bytes.length || !format || !samples) invalid();
  const sourceFrames = samples.length / 2;
  if (sourceFrames > format.rate * MAX_AUDIO_SECONDS) throw new Error('每条语音最多支持60秒。');
  const frames = Math.max(1, Math.round(sourceFrames * OUTPUT_RATE / format.rate));
  const wav = Buffer.alloc(44 + frames * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(OUTPUT_RATE, 24); wav.writeUInt32LE(OUTPUT_RATE * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40);
  if (format.rate === OUTPUT_RATE) samples.copy(wav, 44);
  else {
    // Linear interpolation adapts already-decoded short speech to the worker's fixed input rate.
    // It does not decode SILK or restore information absent from the source recording.
    for (let frame = 0; frame < frames; frame++) {
      const position = Math.min(sourceFrames - 1, frame * format.rate / OUTPUT_RATE), index = Math.floor(position);
      const left = samples.readInt16LE(index * 2), right = samples.readInt16LE(Math.min(sourceFrames - 1, index + 1) * 2);
      wav.writeInt16LE(Math.round(left + (right - left) * (position - index)), 44 + frame * 2);
    }
  }
  return { wav, audioSeconds: frames / OUTPUT_RATE };
}

export async function loadQQVoice({ voice, config, signal, assertActive } = {}) {
  if (!voice || Object.keys(voice).length !== 1 || !validFile(voice.file)) throw new Error('语音标识无效，请重新发送语音。');
  if (assertActive !== undefined && typeof assertActive !== 'function') throw new Error('语音状态核对方式无效。');
  if (typeof config?.apiBaseUrl !== 'string' || config.apiBaseUrl.length > 500
    || (config.accessToken !== undefined && (typeof config.accessToken !== 'string' || config.accessToken.length > 1000 || /[\u0000-\u001f\u007f]/.test(config.accessToken)))) {
    throw new Error('QQ 语音接入配置无效。');
  }
  let endpoint;
  try {
    endpoint = new URL(config.apiBaseUrl.replace(/\/+$/, '') + '/get_record');
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error();
  } catch { throw new Error('QQ 语音接口地址无效。'); }
  const timeout = AbortSignal.timeout(30000), active = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const check = () => { active.throwIfAborted(); assertActive?.(); };
  check();
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: active,
    headers: { 'Content-Type': 'application/json', ...(config.accessToken ? { Authorization: `Bearer ${config.accessToken}` } : {}) },
    body: JSON.stringify({ file_id: voice.file, out_format: 'wav' }) });
  try {
    check();
    const declared = response.headers.get('content-length');
    if (!response.ok || !response.body || declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) throw new Error('QQ 未返回可用的语音数据。');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      check(); size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) throw new Error('QQ 语音响应超过大小限制。');
      chunks.push(chunk);
    }
    check();
    if (declared !== null && Number(declared) !== size) throw new Error('QQ 语音响应不完整。');
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new Error('QQ 语音响应格式无效。'); }
    const encoded = value?.data?.base64;
    if (value?.status !== 'ok' || ![0, '0'].includes(value.retcode) || typeof encoded !== 'string' || !encoded.length
      || encoded.length > Math.ceil(MAX_WAV_BYTES / 3) * 4 || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      throw new Error('协议端未返回可用的WAV语音数据，请检查 NapCat 语音转码支持。');
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > MAX_WAV_BYTES || bytes.toString('base64') !== encoded) throw new Error('QQ 语音数据编码无效。');
    const result = canonicalWav(bytes);
    check();
    return result;
  } finally { await response.body?.cancel().catch(() => {}); }
}
