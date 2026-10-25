import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { speechAssets, speechWorkerPins } from '../src/speech-runtime.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const origins = ['https://huggingface.co', 'https://hf-mirror.com'];
const license = 'https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE';
const help = '用法：node scripts/prepare-speech.js [--data-dir <已有数据目录绝对路径>] [--origin https://huggingface.co|https://hf-mirror.com]\n读取已有 dsh-runtime.json 的固定版宿主，校验并准备约 241 MB 本地识别资源；不加载模型、不修改 QQ 或 DSH 开关。';
const configurationKeys = ['enabled', 'nodePath', 'hostDirectory', 'modelDirectory', 'vadModelPath'];
function fail(message) { const error = new Error(message); error.validation = true; throw error; }
function originValue(value) { if (!origins.includes(value)) fail('下载来源只接受 https://huggingface.co 或 https://hf-mirror.com。'); return value; }
function regular(path) { const item = lstatSync(path, { throwIfNoEntry: false }); return item?.isFile() && !item.isSymbolicLink(); }
async function verified(path, asset) {
  const item = lstatSync(path, { throwIfNoEntry: false });
  if (!item) return false;
  if (!item.isFile() || item.isSymbolicLink()) fail('资源目标必须是普通文件，不能是链接或目录。');
  if (item.size !== asset.bytes) return false;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex') === asset.sha256;
}

// The CLI supplies only the fixed upstream assets. The small helper is also usable
// for isolated integrity/atomic-write verification without downloading a model.
export async function downloadSpeechAsset(asset, target, { origin = origins[0], fetcher = fetch, timeoutMs = 600000, log = console.log } = {}) {
  originValue(origin);
  if (!asset || basename(asset.name) !== asset.name || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1
    || !/^[a-f0-9]{64}$/.test(asset.sha256) || typeof asset.url !== 'string' || !asset.url.startsWith(origins[0] + '/')) fail('固定语音资源清单无效。');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1800000) fail('下载等待时间无效。');
  const directory = realpathSync(dirname(target));
  if (resolve(dirname(target)) !== directory || basename(target) !== asset.name) fail('资源路径不在准备目录内。');
  if (await verified(target, asset)) { log(`${asset.name}：已校验，复用缓存。`); return 'reused'; }
  const temporary = join(directory, `.${asset.name}.${randomUUID()}.part`);
  const signal = AbortSignal.timeout(timeoutMs), hash = createHash('sha256');
  let output, bytes = 0, lastProgress = Date.now();
  try {
    log(`${asset.name}：从 ${origin} 下载（${asset.bytes} 字节）。`);
    const response = await fetcher(origin + new URL(asset.url).pathname, { redirect: 'follow', headers: { 'Accept-Encoding': 'identity' }, signal });
    if (!response.ok || !response.body) { await response.body?.cancel(); fail(`${asset.name} 下载失败（HTTP ${response.status}）。`); }
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== asset.bytes)) { await response.body.cancel(); fail(`${asset.name} 下载长度与固定版本不符。`); }
    output = await open(temporary, 'wx', 0o600);
    for await (const part of response.body) {
      signal.throwIfAborted();
      const chunk = Buffer.from(part); bytes += chunk.length;
      if (bytes > asset.bytes) fail(`${asset.name} 下载超过固定长度。`);
      hash.update(chunk); await output.writeFile(chunk);
      if (Date.now() - lastProgress >= 15000) { log(`${asset.name}：${bytes}/${asset.bytes} 字节。`); lastProgress = Date.now(); }
    }
    signal.throwIfAborted();
    if (bytes !== asset.bytes || hash.digest('hex') !== asset.sha256) fail(`${asset.name} 的长度或 SHA-256 校验失败，未替换资源。`);
    await output.sync(); await output.close(); output = null;
    const current = lstatSync(target, { throwIfNoEntry: false });
    if (current && (!current.isFile() || current.isSymbolicLink())) fail('资源目标在下载期间变化，未替换。');
    renameSync(temporary, target);
    log(`${asset.name}：校验完成。`);
    return 'downloaded';
  } catch (error) {
    if (error.validation) throw error;
    fail(signal.aborted ? `${asset.name} 下载超时，已保留其他完整资源。` : `${asset.name} 下载未完成，请检查网络、目录或改选固定来源后重新运行。`);
  } finally {
    await output?.close();
    if (existsSync(temporary)) {
      if (dirname(realpathSync(temporary)) !== directory || !regular(temporary)) fail('临时下载路径变化，未清理未知文件。');
      rmSync(temporary);
    }
  }
}

export function preparedSpeechConfiguration(previous, defaults) {
  if (previous === null) return { enabled: true, ...defaults };
  if (!previous || typeof previous !== 'object' || Array.isArray(previous) || typeof previous.enabled !== 'boolean'
    || Object.keys(previous).some(key => !configurationKeys.includes(key))) fail('已有语音配置无效，未修改。');
  const paths = configurationKeys.slice(1), present = paths.filter(key => Object.hasOwn(previous, key));
  if (previous.enabled && !present.length || present.length && (present.length !== paths.length || paths.some(key => typeof previous[key] !== 'string' || !isAbsolute(previous[key])))) fail('已有语音配置的路径不完整，未修改。');
  if (present.length && paths.some(key => resolve(previous[key]) !== resolve(defaults[key]))) fail('已有语音配置使用其他路径，未覆盖；请先核对现有部署。');
  return { enabled: previous.enabled, ...defaults };
}

function inspectHost(dataDir) {
  const input = JSON.parse(readFileSync(join(dataDir, 'dsh-runtime.json'), 'utf8').replace(/^\uFEFF/, ''));
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.enabled !== 'boolean'
    || !['nodePath', 'hostDirectory'].every(key => typeof input[key] === 'string' && isAbsolute(input[key]))) fail('请先配置已有的 DSH Node.js 24 宿主路径。');
  if (!regular(input.nodePath) || !lstatSync(input.hostDirectory).isDirectory()) fail('DSH 运行时路径不可用。');
  const nodePath = realpathSync(input.nodePath), hostDirectory = realpathSync(input.hostDirectory);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['path', 'systemroot', 'windir', 'comspec', 'pathext', 'temp', 'tmp'].includes(key.toLowerCase())));
  const version = spawnSync(nodePath, ['--version'], { windowsHide: true, encoding: 'utf8', timeout: 10000, env });
  if (version.error || version.status !== 0 || !/^v24\.\d+\.\d+$/.test(version.stdout.trim())) fail('语音宿主需要可运行的 Node.js 24。');
  for (const [name, expected] of [[speechWorkerPins.name, speechWorkerPins.version], ['@deepseek-ai/dsh-experimental-speech-to-text', speechWorkerPins.version], ['sherpa-onnx-node', speechWorkerPins.sherpaVersion]]) {
    const manifest = JSON.parse(readFileSync(join(hostDirectory, 'node_modules', name, 'package.json'), 'utf8'));
    if (manifest.name !== name || manifest.version !== expected) fail('本地语音包版本与固定运行层不符。');
  }
  const packageDir = join(hostDirectory, 'node_modules', speechWorkerPins.name);
  if (createHash('sha256').update(readFileSync(join(packageDir, 'lib/worker.js'))).digest('hex') !== speechWorkerPins.workerSha256) fail('官方语音 worker 校验失败。');
  const assets = JSON.parse(readFileSync(join(packageDir, 'runtime/assets.json'), 'utf8'));
  for (const [kind, actual] of [['model', assets.models?.int8], ['tokens', assets.tokens], ['vad', assets.vad]]) {
    if (!actual || Object.entries(speechAssets[kind]).some(([key, value]) => actual[key] !== value)) fail('官方语音资源清单与固定版本不符。');
  }
  return { nodePath, hostDirectory };
}

export async function prepareSpeech({ dataDir, origin = origins[0] }) {
  originValue(origin);
  if (!isAbsolute(dataDir) || !lstatSync(dataDir).isDirectory()) fail('数据目录须为已存在且包含 dsh-runtime.json 的绝对路径。');
  dataDir = realpathSync(dataDir);
  if (dataDir === dirname(dataDir)) fail('不能使用文件系统根目录。');
  const runtime = inspectHost(dataDir), configurationPath = join(dataDir, 'speech-runtime.json');
  if (existsSync(configurationPath) && !regular(configurationPath)) fail('已有语音配置必须是普通文件。');
  const before = existsSync(configurationPath) ? readFileSync(configurationPath, 'utf8') : null;
  const previous = before === null ? null : JSON.parse(before.replace(/^\uFEFF/, ''));
  const modelDirectory = join(dataDir, 'speech-models', 'sensevoice-int8'), vadModelPath = join(modelDirectory, speechAssets.vad.name);
  const configuration = preparedSpeechConfiguration(previous, { ...runtime, modelDirectory, vadModelPath });
  for (const directory of [dirname(modelDirectory), modelDirectory]) {
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory) fail('模型缓存目录不能是链接。');
  }
  console.log(`SenseVoiceSmall 权重适用 FunASR Model License 1.1：${license}`);
  const results = [];
  for (const asset of Object.values(speechAssets)) results.push(await downloadSpeechAsset(asset, join(modelDirectory, asset.name), { origin }));
  const current = existsSync(configurationPath) ? readFileSync(configurationPath, 'utf8') : null;
  if (current !== before) fail('准备期间语音配置已变化；完整资源已保留，未覆盖配置。');
  const configurationUpdated = before === null || configurationKeys.some(key => previous[key] !== configuration[key]);
  if (configurationUpdated) {
    const temporary = join(dataDir, `.speech-runtime-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify(configuration, null, 2), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, configurationPath);
    } finally { if (existsSync(temporary)) rmSync(temporary); }
  }
  return { prepared: true, enabled: configuration.enabled, configurationUpdated, downloaded: results.filter(value => value === 'downloaded').length,
    reused: results.filter(value => value === 'reused').length, resources: Object.values(speechAssets).map(item => item.name) };
}

async function main() {
  const args = process.argv.slice(2), options = {};
  if (args.length === 1 && args[0] === '--help') { console.log(help); return; }
  for (let index = 0; index < args.length; index += 2) {
    if (!['--data-dir', '--origin'].includes(args[index]) || !args[index + 1] || Object.hasOwn(options, args[index])) fail(help);
    options[args[index]] = args[index + 1];
  }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || major === 22 && minor < 16 || !['win32', 'linux'].includes(process.platform) || process.arch !== 'x64') fail('准备脚本需要 Node.js 22.16+，当前验证目标为 Windows x64 或 Linux glibc x64。');
  const dataDir = resolve(options['--data-dir'] || process.env.PERSONA_DATA_DIR || join(root, 'data'));
  if (options['--data-dir'] && !isAbsolute(options['--data-dir'])) fail(help);
  console.log(JSON.stringify(await prepareSpeech({ dataDir, origin: options['--origin'] || origins[0] })));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.validation ? error.message : '语音资源准备未完成，请检查目录、网络或固定版本依赖。'); process.exitCode = 1; });
}
