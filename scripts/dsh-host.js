import { createRequire } from 'node:module';
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const versions = { dsh: '0.2.1-rc.2', humanism: '1.7.0' };
const memoryTools = ['search_memory', 'read_memory', 'read_memory_source'];
const allowedTools = new Set(['bili_humanism_status', 'bili_humanism_guide', ...memoryTools.map(name => `memoria_${name}`)]);
const pending = new Map();
let sequence = 0;
let fetchAttempts = 0;
let shutdown;

function fail(code) { throw new Error(code); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function fields(value, allowed) { return object(value) && Object.keys(value).every(key => allowed.includes(key)); }
function send(message) {
  return new Promise((accept, reject) => {
    if (!process.connected || typeof process.send !== 'function') return reject(new Error('IPC_DISCONNECTED'));
    process.send(message, error => error ? reject(new Error('IPC_DISCONNECTED')) : accept());
  });
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
    pending.set(id, { finish });
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
    } else if (message.type === 'memory-result' && started) {
      const request = pending.get(message.id);
      if (!request || !fields(message, ['type', 'id', 'result', 'error'])) return;
      if (Object.hasOwn(message, 'error')) request.finish('MEMORY_UNAVAILABLE');
      else if (Object.hasOwn(message, 'result')) request.finish(null, message.result);
      else request.finish('INVALID_MEMORY_RESULT');
    }
  });
  process.once('disconnect', () => {
    reject(new Error('IPC_DISCONNECTED'));
    for (const request of [...pending.values()]) request.finish('IPC_DISCONNECTED');
    if (shutdown) void shutdown.shutdown(1);
  });
  if (typeof process.send !== 'function') reject(new Error('IPC_REQUIRED'));
});

async function main(input) {
  if (Number(process.versions.node.split('.')[0]) !== 24) fail('NODE_VERSION_MISMATCH');
  if (!fields(input, ['type', 'hostDirectory', 'workspace', 'operation'])
    || ![input.hostDirectory, input.workspace].every(value => typeof value === 'string' && isAbsolute(value))
    || !fields(input.operation, ['name', 'args'])
    || !['inspect', ...memoryTools].includes(input.operation.name)
    || !object(input.operation.args)
    || (input.operation.name === 'inspect' && Object.keys(input.operation.args).length)) fail('INVALID_START');
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

  // This prevents accidental fetches in this audited, local-only probe. It is not an OS sandbox.
  globalThis.fetch = async () => { fetchAttempts++; fail('NETWORK_DISABLED'); };
  const require = createRequire(join(host, 'package.json'));
  for (const [name, version] of [['@deepseek-ai/dsh', versions.dsh], ['dsh-bili-humanism', versions.humanism]]) {
    const manifest = JSON.parse(readFileSync(join(host, 'node_modules', name, 'package.json'), 'utf8'));
    if (manifest.name !== name || manifest.version !== version) fail('PACKAGE_VERSION_MISMATCH');
  }
  const load = name => import(pathToFileURL(require.resolve(name)).href);
  const { initProfile, resolveProfileDir, DEFAULT_PROFILE_BUNDLES, loadLayeredEnv } = await load('@deepseek-ai/dsh-app-boot');
  const { runProfile } = await load('@deepseek-ai/dsh/profile-boot');
  const { defineTool } = await load('@deepseek-ai/dsh-tools');
  const profile = 'memoria-read-only';
  initProfile(resolveProfileDir(profile), [...DEFAULT_PROFILE_BUNDLES, 'dsh-bili-humanism']);
  const overlay = join(workspace, 'read-only.yml');
  const pluginConfig = { dataDir: join(workspace, 'plugin-data'), credentialPath: '', writePolicyPath: '', accountStateDir: '',
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
  ctx.tools.guard(exec => allowedTools.has(exec.name) ? undefined : 'MEMORIA_READ_ONLY');
  let call = 0;
  async function execute(name, args = {}) {
    if (!allowedTools.has(name)) fail('TOOL_NOT_ALLOWED');
    const result = await ctx.tools.execute({ callId: `memoria-${++call}`, name, arguments: args, signal: AbortSignal.timeout(12000) });
    if (result.isError || typeof result.value !== 'string') fail('TOOL_FAILED');
    try { return JSON.parse(result.value); } catch { fail('INVALID_TOOL_RESULT'); }
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
catch { exitCode = 1; reply = { type: 'failure', error: 'DSH_READ_ONLY_FAILED' }; }
finally {
  for (const request of [...pending.values()]) request.finish('HOST_STOPPED');
  try { await shutdown?.shutdown(exitCode); }
  catch { exitCode = 1; reply = { type: 'failure', error: 'DSH_SHUTDOWN_FAILED' }; }
}
try { await send(reply); } catch { exitCode = 1; }
process.exitCode = exitCode;
if (process.connected) process.disconnect();
