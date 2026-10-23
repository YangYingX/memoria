import { createRequire } from 'node:module';
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const versions = { dsh: '0.2.1-rc.2', humanism: '1.7.0' };
const memoryTools = ['search_memory', 'read_memory', 'read_memory_source'];
const readErrors = new Set(['PLATFORM_PAUSED', 'PERSISTENT_PAUSE', 'NO_READABLE_TEXT', 'NETWORK_FAILED',
  'READ_TOKEN_BUDGET', 'INVALID_SOURCE', 'SOURCE_TOO_LARGE', 'DSH_READ_FAILED']);
const maxResultBytes = 2 * 1024 * 1024;
const pending = new Map();
const lifecycle = new AbortController();
let sequence = 0;
let fetchAttempts = 0;
let networkRequests = 0;
let shutdown;
let operationName;

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function fields(value, allowed) { return object(value) && Object.keys(value).every(key => allowed.includes(key)); }
function videoUrl(value) {
  if (typeof value !== 'string' || value.length > 160) fail('INVALID_SOURCE');
  const match = /^https:\/\/www\.bilibili\.com\/video\/(BV[0-9A-Za-z]{10})\/?(?:\?p=([1-9][0-9]{0,2}))?$/.exec(value);
  if (!match || Number(match[2] || 1) > 100) fail('INVALID_SOURCE');
  const page = Number(match[2] || 1);
  return { bvid: match[1], page, url: `https://www.bilibili.com/video/${match[1]}/?p=${page}` };
}

function nativeError(code) {
  if (readErrors.has(code)) return code;
  if (['CREDENTIAL_EXPIRED', 'CREDENTIAL_INVALID'].includes(code)) return 'PLATFORM_PAUSED';
  if (['HTTP_FAILED', 'BODY_READ_FAILED', 'INVALID_RESPONSE'].includes(code)) return 'NETWORK_FAILED';
  if (['INVALID_SEGMENTS', 'INVALID_TIMESTAMP', 'INVALID_DURATION', 'READING_NOT_FOUND', 'INVALID_OFFSET'].includes(code)) return 'INVALID_SOURCE';
  if (['TOO_MANY_SEGMENTS', 'SEGMENT_TOO_LONG', 'RESPONSE_TOO_LARGE'].includes(code)) return 'SOURCE_TOO_LARGE';
  return 'DSH_READ_FAILED';
}

async function completeReading(execute, video) {
  const fetched = await execute('bili_humanism_read', { video: video.url }, 90000);
  const first = fetched?.result;
  if (!object(first) || !Array.isArray(first.segments)) fail('INVALID_SOURCE');
  if (first.route === 'none' && !first.segments.length && first.segment_count === 0) fail('NO_READABLE_TEXT');
  if (!['A1', 'A2'].includes(first.route) || first.segments.length === 0
    || typeof first.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(first.id)
    || first.bvid !== video.bvid || first.page !== video.page || first.url !== video.url
    || !Number.isSafeInteger(first.cid) || first.cid <= 0
    || typeof first.title !== 'string' || !first.title.trim() || first.title.length > 500
    || typeof first.author !== 'string' || first.author.length > 200
    || !Number.isFinite(first.duration) || first.duration <= 0
    || !Number.isSafeInteger(first.segment_count) || first.segment_count <= 0) fail('INVALID_SOURCE');
  if (first.segment_count > 30000) fail('SOURCE_TOO_LARGE');
  const coverage = first.coverage;
  if (!object(coverage) || coverage.state !== 'partial' || coverage.duration_seconds !== first.duration
    || !Number.isFinite(coverage.timed_seconds) || coverage.timed_seconds < 0 || coverage.timed_seconds > first.duration + 0.01
    || !Number.isFinite(coverage.timed_fraction) || coverage.timed_fraction < 0 || coverage.timed_fraction > 1
    || typeof coverage.missing !== 'string' || typeof coverage.speech !== 'string' || typeof coverage.note !== 'string') fail('INVALID_SOURCE');
  const metadataKeys = ['id', 'bvid', 'page', 'cid', 'url', 'title', 'author', 'route', 'coverage', 'duration', 'segment_count'];
  const metadata = page => JSON.stringify(metadataKeys.map(key => page[key]));
  const expectedMetadata = metadata(first);
  const segments = [];
  let current = first, offset = 0, textBytes = 0, resultBytes = 0, lastStart = -1;
  while (true) {
    if (!object(current) || metadata(current) !== expectedMetadata || !Array.isArray(current.segments)
      || current.segments.length === 0 || current.segments.length + offset > first.segment_count
      || (Object.hasOwn(current, 'offset') && current.offset !== offset)
      || current.source_text_partial !== (offset > 0 || current.segments.length < first.segment_count)) fail('INVALID_SOURCE');
    for (const item of current.segments) {
      if (!object(item) || !Number.isFinite(item.start) || item.start < 0 || item.start < lastStart || item.start > first.duration + 5
        || (item.end !== null && (!Number.isFinite(item.end) || item.end < item.start || item.end > first.duration + 5))
        || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 20000 || item.source !== first.route) fail('INVALID_SOURCE');
      const segment = { start: item.start, end: item.end, text: item.text, source: item.source };
      textBytes += Buffer.byteLength(segment.text, 'utf8');
      resultBytes += Buffer.byteLength(JSON.stringify(segment), 'utf8') + 1;
      if (textBytes > 600000) fail('READ_TOKEN_BUDGET');
      if (resultBytes > maxResultBytes) fail('SOURCE_TOO_LARGE');
      segments.push(segment); lastStart = segment.start;
    }
    offset += current.segments.length;
    if (offset === first.segment_count) {
      if (current.next_offset !== null) fail('INVALID_SOURCE');
      break;
    }
    if (current.next_offset !== offset) fail('INVALID_SOURCE');
    current = await execute('bili_humanism_source', { readingId: first.id, offset });
  }
  const usage = fetched.usage;
  if (!object(usage) || !Number.isSafeInteger(usage.requests) || usage.requests < 0 || usage.requests > 12
    || !Number.isSafeInteger(usage.candidates) || usage.candidates < 0 || usage.candidates > 3
    || usage.asr_seconds !== 0 || !Number.isFinite(usage.elapsed_ms) || usage.elapsed_ms < 0 || usage.tokens !== null
    || typeof first.cached !== 'boolean') fail('INVALID_SOURCE');
  const result = { reading: { id: first.id, bvid: first.bvid, page: first.page, url: first.url,
    title: first.title, author: first.author, route: first.route, coverage: first.coverage, duration: first.duration, segments },
    usage: { requests: usage.requests, candidates: usage.candidates, asr_seconds: 0, elapsed_ms: usage.elapsed_ms, tokens: null },
    visual: 'unavailable', cached: first.cached };
  if (Buffer.byteLength(JSON.stringify({ type: 'result', result }), 'utf8') > maxResultBytes) fail('SOURCE_TOO_LARGE');
  return result;
}
function send(message) {
  return new Promise((accept, reject) => {
    if (!process.connected || typeof process.send !== 'function') return reject(new Error('IPC_DISCONNECTED'));
    process.send(message, error => error ? reject(new Error('IPC_DISCONNECTED')) : accept());
  });
}

function requestVideoSelection(candidates) {
  return new Promise((accept, reject) => {
    if (lifecycle.signal.aborted || !process.connected) return reject(new Error('CANCELLED'));
    const id = ++sequence;
    const finish = (error, url) => {
      if (!pending.delete(id)) return;
      clearTimeout(timer); lifecycle.signal.removeEventListener('abort', abort);
      if (error || (url !== null && !candidates.some(candidate => candidate.url === url))) {
        const code = error || 'INVALID_SOURCE'; reject(Object.assign(new Error(code), { code }));
      }
      else accept(url);
    };
    const abort = () => finish('CANCELLED');
    const timer = setTimeout(() => finish('SELECTION_TIMEOUT'), 10000);
    pending.set(id, { kind: 'video-selection', finish });
    lifecycle.signal.addEventListener('abort', abort, { once: true });
    send({ type: 'select-video', id, candidates }).catch(() => finish('IPC_DISCONNECTED'));
  });
}

async function discoverVideos(execute) {
  const discovery = await execute('bili_humanism_candidates', { count: 3 });
  if (!object(discovery) || !Array.isArray(discovery.result) || discovery.result.length > 3) fail('INVALID_SOURCE');
  const candidates = discovery.result.map(item => {
    if (!object(item) || typeof item.bvid !== 'string') fail('INVALID_SOURCE');
    const video = videoUrl(item.url);
    if (item.bvid !== video.bvid || video.page !== 1 || typeof item.title !== 'string' || !item.title.trim()
      || item.title.length > 500 || typeof item.author !== 'string' || item.author.length > 200
      || !Number.isFinite(item.duration) || item.duration <= 0) fail('INVALID_SOURCE');
    return { url: video.url, title: item.title, author: item.author, duration: item.duration };
  });
  if (new Set(candidates.map(item => item.url)).size !== candidates.length) fail('INVALID_SOURCE');
  const usage = discovery.usage;
  if (!object(usage) || !Number.isSafeInteger(usage.requests) || usage.requests < 0 || usage.requests > 12
    || !Number.isSafeInteger(usage.candidates) || usage.candidates !== candidates.length
    || usage.asr_seconds !== 0 || !Number.isFinite(usage.elapsed_ms) || usage.elapsed_ms < 0 || usage.tokens !== null) fail('INVALID_SOURCE');
  lifecycle.signal.throwIfAborted();
  if (!candidates.length) return { selection: null };
  const selected = await requestVideoSelection(candidates);
  lifecycle.signal.throwIfAborted();
  return { selection: candidates.find(item => item.url === selected) ?? null,
    usage: { requests: usage.requests, candidates: usage.candidates, asr_seconds: 0, elapsed_ms: usage.elapsed_ms, tokens: null } };
}

function requestMemory(name, args, signal) {
  return new Promise((accept, reject) => {
    if (signal?.aborted) return reject(new Error('MEMORY_CANCELLED'));
    const id = ++sequence;
    const finish = (error, result) => {
      if (!pending.delete(id)) return;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      error ? reject(new Error(error)) : accept(result);
    };
    const abort = () => finish('MEMORY_CANCELLED');
    const timer = setTimeout(() => finish('MEMORY_TIMEOUT'), 10000);
    pending.set(id, { kind: 'memory-result', finish });
    signal?.addEventListener('abort', abort, { once: true });
    send({ type: 'memory', id, name, args }).catch(() => finish('IPC_DISCONNECTED'));
  });
}

const start = new Promise((accept, reject) => {
  let started = false;
  process.on('message', message => {
    if (!object(message) || JSON.stringify(message).length > 100000) return reject(new Error('INVALID_MESSAGE'));
    if (message.type === 'start' && !started) {
      started = true;
      accept(message);
    } else if (['memory-result', 'video-selection'].includes(message.type) && started) {
      const request = pending.get(message.id);
      if (!request || request.kind !== message.type) return;
      if (message.type === 'video-selection') {
        if (!fields(message, ['type', 'id', 'url']) || !Object.hasOwn(message, 'url')) request.finish('INVALID_SOURCE');
        else request.finish(null, message.url);
      } else {
        if (!fields(message, ['type', 'id', 'result', 'error'])) return;
        if (Object.hasOwn(message, 'error')) request.finish('MEMORY_UNAVAILABLE');
        else if (Object.hasOwn(message, 'result')) request.finish(null, message.result);
        else request.finish('INVALID_MEMORY_RESULT');
      }
    }
  });
  process.once('disconnect', () => {
    lifecycle.abort();
    reject(new Error('IPC_DISCONNECTED'));
    for (const request of [...pending.values()]) request.finish('IPC_DISCONNECTED');
    if (shutdown) void shutdown.shutdown(1);
  });
  process.once('SIGTERM', () => lifecycle.abort());
  process.once('SIGINT', () => lifecycle.abort());
  if (typeof process.send !== 'function') reject(new Error('IPC_REQUIRED'));
});

async function main(input) {
  operationName = input?.operation?.name;
  const browsing = operationName === 'browse_bili';
  const reading = operationName === 'read_bili_video' || browsing;
  if (Number(process.versions.node.split('.')[0]) !== 24) fail('NODE_VERSION_MISMATCH');
  if (!fields(input, ['type', 'hostDirectory', 'workspace', 'cacheDirectory', 'credentialPath', 'operation'])
    || ![input.hostDirectory, input.workspace].every(value => typeof value === 'string' && isAbsolute(value))
    || !fields(input.operation, ['name', 'args'])
    || !['inspect', 'read_bili_video', 'browse_bili', ...memoryTools].includes(operationName)
    || !object(input.operation.args)
    || (operationName === 'inspect' && Object.keys(input.operation.args).length)
    || (!reading && (Object.hasOwn(input, 'cacheDirectory') || Object.hasOwn(input, 'credentialPath')))) fail('INVALID_START');
  let video, cacheDirectory, credentialPath = '';
  if (reading) {
    if (!fields(input.operation.args, browsing ? [] : ['url']) || typeof input.cacheDirectory !== 'string'
      || !isAbsolute(input.cacheDirectory)) fail('INVALID_START');
    if (!browsing) video = videoUrl(input.operation.args.url);
    cacheDirectory = realpathSync(input.cacheDirectory);
    if (!lstatSync(input.cacheDirectory).isDirectory() || lstatSync(input.cacheDirectory).isSymbolicLink()
      || basename(cacheDirectory) !== 'humanism' || basename(dirname(cacheDirectory)) !== 'dsh-cache') fail('INVALID_START');
    if (Object.hasOwn(input, 'credentialPath')) {
      const expected = join(dirname(dirname(cacheDirectory)), 'bili-credentials.json');
      if (input.credentialPath !== expected) fail('INVALID_START');
      const file = lstatSync(expected);
      if (!file.isFile() || file.isSymbolicLink() || realpathSync(expected) !== expected) fail('INVALID_START');
      credentialPath = expected;
    }
  }
  const host = realpathSync(input.hostDirectory);
  const workspace = realpathSync(input.workspace);
  if (lstatSync(input.workspace).isSymbolicLink() || dirname(workspace) !== host
    || !basename(workspace).startsWith('.memoria-job-') || realpathSync(process.cwd()) !== workspace) fail('INVALID_WORKSPACE');
  for (const folder of ['home', 'appdata', 'localappdata', 'tmp', 'dsh']) {
    const path = join(workspace, folder);
    if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink() || readdirSync(path).length) fail('WORKSPACE_NOT_EMPTY');
  }
  if (readdirSync(workspace).some(name => !['home', 'appdata', 'localappdata', 'tmp', 'dsh'].includes(name))) fail('WORKSPACE_NOT_EMPTY');
  process.env.DSH_HOME = join(workspace, 'dsh');
  process.env.DSH_TELEMETRY_DISABLED = '1';

  // These application-level rules govern the audited plugin's fetch transport; they are not an OS sandbox.
  const fetcher = globalThis.fetch;
  globalThis.fetch = async () => { fetchAttempts++; fail('NETWORK_DISABLED'); };
  const require = createRequire(join(host, 'package.json'));
  for (const [name, version] of [['@deepseek-ai/dsh', versions.dsh], ['dsh-bili-humanism', versions.humanism]]) {
    const manifest = JSON.parse(readFileSync(join(host, 'node_modules', name, 'package.json'), 'utf8'));
    if (manifest.name !== name || manifest.version !== version) fail('PACKAGE_VERSION_MISMATCH');
  }
  const load = name => import(pathToFileURL(require.resolve(name)).href);
  if (reading) {
    const { permitted, credential } = await import(pathToFileURL(join(dirname(require.resolve('dsh-bili-humanism')), 'lib/network.mjs')).href);
    const secret = credential(credentialPath);
    const cookie = secret ? `SESSDATA=${secret}` : null;
    const positive = value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));
    globalThis.fetch = async (raw, options = {}) => {
      if (lifecycle.signal.aborted || !process.connected) fail('CANCELLED');
      fetchAttempts++;
      const value = raw instanceof URL ? raw.href : raw;
      if (typeof value !== 'string' || !object(options) || (options.method ?? 'GET') !== 'GET'
        || options.body != null || (options.redirect !== undefined && options.redirect !== 'manual')
        || (options.credentials !== undefined && options.credentials !== 'omit')) fail('NETWORK_DISABLED');
      const candidate = new URL(value);
      if (candidate.hash) fail('NETWORK_DISABLED');
      const url = permitted(value, candidate.hostname === 'api.bilibili.com' ? 'api' : 'subtitle');
      if (url.hostname !== 'api.bilibili.com' && !video) fail('NETWORK_DISABLED');
      if (url.hostname === 'api.bilibili.com') {
        const keys = [...url.searchParams.keys()];
        if (browsing && url.pathname === '/x/web-interface/popular') {
          if (keys.length !== 2 || new Set(keys).size !== 2 || keys.some(key => !['pn', 'ps'].includes(key))
            || url.searchParams.get('pn') !== '1' || url.searchParams.get('ps') !== '3') fail('NETWORK_DISABLED');
        } else if (!video) fail('NETWORK_DISABLED');
        else if (secret && url.pathname === '/x/web-interface/nav') {
          if (keys.length || url.search) fail('NETWORK_DISABLED');
        } else if (secret && url.pathname === '/x/web-interface/view/conclusion/get') {
          if (keys.length !== 5 || new Set(keys).size !== 5
            || keys.some(key => !['bvid', 'cid', 'up_mid', 'wts', 'w_rid'].includes(key))
            || url.searchParams.get('bvid') !== video.bvid
            || !['cid', 'up_mid', 'wts'].every(key => positive(url.searchParams.get(key)))
            || !/^[0-9a-f]{32}$/i.test(url.searchParams.get('w_rid') ?? '')) fail('NETWORK_DISABLED');
        } else if (!['/x/web-interface/view', '/x/player/wbi/v2'].includes(url.pathname)
            || url.searchParams.get('bvid') !== video.bvid || keys.filter(key => key === 'bvid').length !== 1
            || keys.some(key => !['bvid', 'cid'].includes(key))
            || (url.pathname === '/x/web-interface/view' && keys.length !== 1)
            || (url.pathname === '/x/player/wbi/v2' && (keys.length !== 2 || !positive(url.searchParams.get('cid'))))) fail('NETWORK_DISABLED');
      }
      const headers = new Headers(options.headers);
      const suppliedCookie = headers.get('cookie');
      if ([...headers.keys()].some(name => !['user-agent', 'referer', 'cookie'].includes(name))
        || (suppliedCookie !== null && (url.hostname !== 'api.bilibili.com' || !cookie || suppliedCookie !== cookie))) fail('NETWORK_DISABLED');
      if (networkRequests >= 12) fail('REQUESTS_BUDGET');
      networkRequests++;
      const response = await fetcher(url, { method: 'GET', redirect: 'manual', credentials: 'omit',
        headers: { 'User-Agent': 'dsh-bili-humanism/1.7.0', Referer: 'https://www.bilibili.com/',
          ...(suppliedCookie !== null ? { Cookie: suppliedCookie } : {}) },
        signal: AbortSignal.any([lifecycle.signal, ...(options.signal ? [options.signal] : [])]) });
      if (lifecycle.signal.aborted || !process.connected) {
        await response.body?.cancel().catch(() => {});
        fail('CANCELLED');
      }
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        await response.body?.cancel().catch(() => {});
        fail('NETWORK_FAILED');
      }
      return response;
    };
  }
  const { initProfile, resolveProfileDir, DEFAULT_PROFILE_BUNDLES, loadLayeredEnv } = await load('@deepseek-ai/dsh-app-boot');
  const { runProfile } = await load('@deepseek-ai/dsh/profile-boot');
  const { defineTool } = await load('@deepseek-ai/dsh-tools');
  const profile = 'memoria-read-only';
  initProfile(resolveProfileDir(profile), [...DEFAULT_PROFILE_BUNDLES, 'dsh-bili-humanism']);
  const overlay = join(workspace, 'read-only.yml');
  const pluginConfig = { dataDir: cacheDirectory || join(workspace, 'plugin-data'), credentialPath, writePolicyPath: '', accountStateDir: '',
    enableDailyFetching: false, enablePersonalityLearning: false,
    enableHistoryWrites: false, enableFavoriteWrites: false, enableLikeWrites: false, enableCoinWrites: false };
  writeFileSync(overlay, `- id: bili-humanism\n  config: ${JSON.stringify(pluginConfig)}\n`, { flag: 'wx' });
  const runtime = await runProfile({ environment: loadLayeredEnv('dsh'), profile, patchFiles: [overlay], args: [] });
  shutdown = runtime.shutdown;
  const { ctx } = runtime;

  // No model prompt or DSH session owns these memories: the parent binds verified identity and scope.
  for (const name of memoryTools) {
    const keys = name === 'search_memory' ? ['query'] : ['id', 'offset'];
    ctx.tools.register(defineTool({
      name: `memoria_${name}`,
      description: name === 'search_memory' ? 'Search the persistent Memoria bookshelf in the current verified scope.'
        : name === 'read_memory' ? 'Read a page from a persistent Memoria memory in the current verified scope.'
          : 'Read a page of source evidence for a Memoria memory in the current verified scope.',
      parameters: name === 'search_memory' ? { query: { type: 'string', required: true } }
        : { id: { type: 'string', required: true }, offset: { type: 'integer' } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args, exec) {
        if (!fields(args, keys)) fail('INVALID_MEMORY_ARGS');
        return JSON.stringify(await requestMemory(name, args, exec.signal));
      },
    }));
  }
  const allowedTools = new Set(['bili_humanism_status', 'bili_humanism_guide', ...memoryTools.map(name => `memoria_${name}`),
    ...(reading ? ['bili_humanism_read', 'bili_humanism_source'] : []), ...(browsing ? ['bili_humanism_candidates'] : [])]);
  ctx.tools.guard(exec => allowedTools.has(exec.name) ? undefined : 'MEMORIA_READ_ONLY');
  let call = 0;
  async function execute(name, args = {}, timeout = 12000) {
    lifecycle.signal.throwIfAborted();
    if (!process.connected) fail('CANCELLED');
    if (!allowedTools.has(name)) fail('TOOL_NOT_ALLOWED');
    const result = await ctx.tools.execute({ callId: `memoria-${++call}`, name, arguments: args,
      signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(timeout)]) });
    if (result.isError || typeof result.value !== 'string') fail('TOOL_FAILED');
    let parsed;
    try { parsed = JSON.parse(result.value); } catch { fail('INVALID_TOOL_RESULT'); }
    if (name.startsWith('bili_humanism_') && object(parsed) && typeof parsed.error === 'string') fail(nativeError(parsed.error));
    return parsed;
  }

  const tools = ctx.tools.schemas().map(tool => tool.name).sort();
  const status = await execute('bili_humanism_status');
  const switches = status?.writes?.switches;
  if (status?.scheduled !== false || status?.dailyFetching?.enabled !== false || status.dailyFetching.running !== false
    || status.dailyFetching.nextAt !== null || !object(switches)
    || !['history', 'favorites', 'likes', 'coins'].every(name => switches[name] === false)
    || !Array.isArray(status.platformWriteTools) || status.platformWriteTools.length
    || !Array.isArray(status.writes.platformWriteTools) || status.writes.platformWriteTools.length
    || tools.includes('bili_humanism_personality')
    || ['history', 'favorite', 'like', 'coin'].some(name => tools.includes(`bili_humanism_${name}`))
    || fetchAttempts) fail('READ_ONLY_CHECK_FAILED');

  if (browsing) {
    const discovery = await discoverVideos(execute);
    if (!discovery.selection) return { skipped: 'no_unread_videos' };
    video = videoUrl(discovery.selection.url);
    const result = { ...await completeReading(execute, video), discoveryUsage: discovery.usage, selection: discovery.selection };
    if (Buffer.byteLength(JSON.stringify({ type: 'result', result }), 'utf8') > maxResultBytes) fail('SOURCE_TOO_LARGE');
    return result;
  }
  if (reading) return completeReading(execute, video);
  if (input.operation.name !== 'inspect') {
    const result = await execute(`memoria_${input.operation.name}`, input.operation.args);
    if (fetchAttempts) fail('NETWORK_ATTEMPTED');
    return result;
  }
  const guide = await execute('bili_humanism_guide');
  if (typeof guide !== 'string') fail('INVALID_TOOL_RESULT');
  if (fetchAttempts) fail('NETWORK_ATTEMPTED');
  return { versions, tools, callableTools: ['inspect', ...memoryTools], guideCharacters: guide.length,
    safety: { dailyFetching: false, personalityLearning: false, platformWrites: false,
      telemetry: false, fetchAttempts, networkPolicy: 'local-only-fetch-blocked', osSandbox: false, memoryAuthority: 'memoria' } };
}

let reply;
let exitCode = 0;
try { reply = { type: 'result', result: await main(await start) }; }
catch (error) { exitCode = 1; reply = { type: 'failure', error: 'DSH_READ_ONLY_FAILED',
  ...(['read_bili_video', 'browse_bili'].includes(operationName) ? { code: nativeError(error.code) } : {}) }; }
finally {
  for (const request of [...pending.values()]) request.finish('HOST_STOPPED');
  try { await shutdown?.shutdown(exitCode); }
  catch { exitCode = 1; reply = { type: 'failure', error: 'DSH_SHUTDOWN_FAILED' }; }
}
try { await send(reply); } catch { exitCode = 1; }
process.exitCode = exitCode;
if (process.connected) process.disconnect();
