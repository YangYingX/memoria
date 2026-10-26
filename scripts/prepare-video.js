import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = 'autobuild-2026-09-30-13-08';
const build = 'n9.0.2-17-g2a571b6068';
const downloadRoot = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/' + release + '/';
export const videoToolAssets = {
  win32: { name: 'ffmpeg-n9.0.2-17-g2a571b6068-win64-lgpl-9.0.zip', bytes: 171535354, sha256: '6b264b9e6019103f601d98c292bd332fd87acf1c5e941ddff4fb71760fe63432' },
  linux: { name: 'ffmpeg-n9.0.2-17-g2a571b6068-linux64-lgpl-9.0.tar.xz', bytes: 137863452, sha256: '2d41cbea0ca1a15029b638330740f78d6f5aeb062355bf425433fc938705350a' },
};
for (const asset of Object.values(videoToolAssets)) {
  asset.url = downloadRoot + asset.name;
  asset.archiveRoot = asset.name.replace(/\.(?:zip|tar\.xz)$/, '');
}
const configKeys = ['enabled', 'ffmpegPath', 'ffprobePath'];
const receiptName = '.video-install.json';
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 4096;
const help = '用法：node scripts/prepare-video.js [--data-dir <已有数据目录绝对路径>] [--ffmpeg <完整FFmpeg绝对路径> --ffprobe <ffprobe绝对路径>]\n默认准备固定版 BtbN FFmpeg 9.0.2 LGPL 工具并核对本地抽帧与PCM输出能力；不修改 QQ 开关、不处理用户视频。';
function fail(message, cause) { const error = new Error(message, cause ? { cause } : undefined); error.validation = true; throw error; }
function regular(path) { const item = lstatSync(path, { throwIfNoEntry: false }); return item?.isFile() && !item.isSymbolicLink(); }
function directory(path) { return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() && !lstatSync(path).isSymbolicLink() && realpathSync(path) === resolve(path); }
async function digest(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
async function verified(path, asset) { return regular(path) && lstatSync(path).size === asset.bytes && await digest(path) === asset.sha256; }
const safeEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => ['path', 'systemroot', 'windir', 'comspec', 'pathext', 'temp', 'tmp', 'lang', 'lc_all'].includes(key.toLowerCase())));
const wait = milliseconds => new Promise(accept => setTimeout(accept, milliseconds));

// Native inspection and tar extraction use no shell. Linux process groups include tar's xz child.
async function runCommand(file, args, { timeoutMs = 10000, maxOutputBytes = 2 * 1024 * 1024, cwd } = {}) {
  const child = spawn(file, args, { cwd, env: safeEnv(), shell: false, windowsHide: true, detached: process.platform === 'linux', stdio: ['ignore', 'pipe', 'pipe'] });
  let timer, failure, size = 0;
  const stdout = [], stderr = [];
  function terminate(reason) {
    failure ||= reason;
    try { if (process.platform === 'linux' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') failure.cleanupUnsafe = true; }
  }
  const result = await new Promise(accept => {
    child.once('error', error => { failure ||= error; });
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', value => {
      size += value.length;
      if (size > maxOutputBytes) terminate(new Error('工具输出超过限制。'));
      else chunks.push(value);
    });
    timer = setTimeout(() => terminate(new Error('工具执行超时。')), timeoutMs);
    child.once('close', (status, signal) => { clearTimeout(timer); accept({ status, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }); });
  });
  if (process.platform === 'linux' && child.pid) {
    let gone = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { process.kill(-child.pid, 0); } catch (error) { if (error.code === 'ESRCH') { gone = true; break; } }
      if (failure) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Checked again before cleanup. */ } }
      await wait(100);
    }
    if (!gone) { failure ||= new Error('工具进程退出状态未确认，保留临时目录。'); failure.cleanupUnsafe = true; }
  }
  if (failure) throw failure;
  return result;
}

export async function downloadVideoArchive(asset, target, { fetcher = fetch, timeoutMs = 600000, log = console.log } = {}) {
  if (!asset || basename(asset.name) !== asset.name || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || !/^[a-f0-9]{64}$/.test(asset.sha256)
    || asset.url !== downloadRoot + asset.name) fail('固定视频工具清单无效。');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1800000) fail('下载等待时间无效。');
  const parent = realpathSync(dirname(target));
  if (resolve(dirname(target)) !== parent || basename(target) !== asset.name) fail('下载路径不在工具缓存内。');
  const current = lstatSync(target, { throwIfNoEntry: false });
  if (current && (!current.isFile() || current.isSymbolicLink())) fail('工具归档目标必须是普通文件。');
  if (await verified(target, asset)) { log(asset.name + '：已校验，复用归档。'); return 'reused'; }
  const temporary = join(parent, '.' + asset.name + '.' + randomUUID() + '.part');
  const signal = AbortSignal.timeout(timeoutMs), hash = createHash('sha256');
  let output, bytes = 0, progressAt = Date.now();
  try {
    log(asset.name + '：下载 ' + asset.bytes + ' 字节。');
    const response = await fetcher(asset.url, { redirect: 'follow', signal, headers: { 'Accept-Encoding': 'identity' } });
    if (!response.ok || !response.body) { await response.body?.cancel(); fail('视频工具下载失败（HTTP ' + response.status + '）。'); }
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== asset.bytes)) { await response.body.cancel(); fail('视频工具下载长度与固定版本不符。'); }
    output = await open(temporary, 'wx', 0o600);
    for await (const part of response.body) {
      signal.throwIfAborted();
      const chunk = Buffer.from(part); bytes += chunk.length;
      if (bytes > asset.bytes) fail('视频工具下载超过固定长度。');
      hash.update(chunk); await output.writeFile(chunk);
      if (Date.now() - progressAt >= 15000) { log(asset.name + '：' + bytes + '/' + asset.bytes + ' 字节。'); progressAt = Date.now(); }
    }
    signal.throwIfAborted();
    if (bytes !== asset.bytes || hash.digest('hex') !== asset.sha256) fail('视频工具长度或 SHA-256 校验失败，未替换缓存。');
    await output.sync(); await output.close(); output = null;
    if (existsSync(target) && !regular(target)) fail('工具归档路径在下载期间变化，未替换。');
    renameSync(temporary, target); log(asset.name + '：校验完成。');
    return 'downloaded';
  } catch (error) {
    if (error.validation) throw error;
    fail(signal.aborted ? '视频工具下载超时；其他完整资源保留。' : '视频工具下载未完成，请检查网络和缓存目录。');
  } finally {
    await output?.close();
    if (existsSync(temporary)) {
      if (dirname(realpathSync(temporary)) !== parent || !regular(temporary)) fail('临时下载路径变化，未删除未知文件。');
      rmSync(temporary);
    }
  }
}

function entryPath(value, archiveRoot) {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\\:\u0000-\u001f\u007f]/u.test(value) || value.startsWith('/')) fail('工具归档含无效路径。');
  const parts = value.replace(/\/$/, '').split('/');
  if (parts.some(part => !part || part === '.' || part === '..') || parts[0] !== archiveRoot) fail('工具归档路径越界。');
  return value;
}
function selection(names, asset, platform) {
  const extension = platform === 'win32' ? '.exe' : '';
  const binaries = ['ffmpeg', 'ffprobe'].map(name => asset.archiveRoot + '/bin/' + name + extension);
  const license = ['LICENSE.txt', 'LICENSE', 'COPYING.LGPLv2.1', 'COPYING.LGPLv3'].map(name => asset.archiveRoot + '/' + name).find(name => names.has(name));
  if (!binaries.every(name => names.has(name)) || !license) fail('工具归档缺少 FFmpeg、ffprobe 或许可文件。');
  return [...binaries, license];
}
async function visitZip(archive, visit) {
  const zip = await new Promise((accept, reject) => yauzl.open(archive, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (error, value) => error ? reject(error) : accept(value)));
  try {
    await new Promise((accept, reject) => {
      zip.once('error', reject); zip.once('end', accept);
      zip.on('entry', entry => Promise.resolve().then(() => visit(entry, zip)).then(() => zip.readEntry(), error => { zip.close(); reject(error); }));
      zip.readEntry();
    });
  } finally { zip.close(); }
}
async function zipFile(zip, entry, target, maxBytes) {
  const input = await new Promise((accept, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : accept(stream)));
  const output = await open(target, 'wx', 0o700); let count = 0;
  try {
    for await (const chunk of input) { count += chunk.length; if (count > maxBytes || count > entry.uncompressedSize) fail('解压工具文件超过限制。'); await output.writeFile(chunk); }
    if (count !== entry.uncompressedSize) fail('工具归档文件被截断。');
    await output.sync();
  } finally { input.destroy(); await output.close(); }
}

export async function extractVideoArchive(asset, archive, staging, { platform = process.platform, run = runCommand } = {}) {
  if (!['win32', 'linux'].includes(platform) || !directory(staging) || readdirSync(staging).length) fail('工具解压目录须为空的普通目录。');
  const names = new Set(), sizes = new Map();
  let selected;
  if (platform === 'win32') {
    await visitZip(archive, entry => {
      const name = entryPath(entry.fileName, asset.archiveRoot), type = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (names.has(name) || ![0, 0x8000, 0x4000].includes(type) || type === 0x8000 && name.endsWith('/')) fail('工具归档含重复路径或链接。');
      if (names.size >= MAX_ARCHIVE_ENTRIES || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize > MAX_FILE_BYTES) fail('工具归档超过解压限制。');
      names.add(name); sizes.set(name, entry.uncompressedSize);
    });
    selected = selection(names, asset, platform);
    await visitZip(archive, async (entry, zip) => {
      if (!selected.includes(entry.fileName)) return;
      const target = join(staging, ...entry.fileName.split('/'));
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      await zipFile(zip, entry, target, entry.fileName === selected[2] ? 4 * 1024 * 1024 : MAX_FILE_BYTES);
    });
  } else {
    const options = { timeoutMs: 120000, maxOutputBytes: 1024 * 1024 };
    const listing = await run('tar', ['--absolute-names', '-tf', archive], options);
    const details = await run('tar', ['--absolute-names', '-tvf', archive], options);
    if (listing.status !== 0 || details.status !== 0) fail('不能读取固定视频工具归档。');
    const paths = listing.stdout.trimEnd().split('\n'), rows = details.stdout.trimEnd().split('\n');
    if (!paths.length || paths.length > MAX_ARCHIVE_ENTRIES || rows.length !== paths.length) fail('工具归档目录无效。');
    paths.forEach((path, index) => {
      const name = entryPath(path.replace(/\r$/, ''), asset.archiveRoot);
      const details = rows[index].match(/^[d-]\S*\s+\S+\s+(\d+)\s/);
      if (names.has(name) || !details || !Number.isSafeInteger(Number(details[1])) || Number(details[1]) > MAX_FILE_BYTES) fail('工具归档含重复路径、链接或超大文件。');
      names.add(name); sizes.set(name, Number(details[1]));
    });
    selected = selection(names, asset, platform);
    if (sizes.get(selected[2]) > 4 * 1024 * 1024) fail('归档许可文件超过限制。');
    const result = await run('tar', ['-xf', archive, '-C', staging, '--no-same-owner', '--no-same-permissions', '--keep-old-files', '--', ...selected], options);
    if (result.status !== 0) fail('固定视频工具解压失败。');
  }
  for (const name of selected) {
    const target = join(staging, ...name.split('/'));
    if (!regular(target) || lstatSync(target).size < 1 || lstatSync(target).size > (name === selected[2] ? 4 * 1024 * 1024 : MAX_FILE_BYTES)) fail('解压后工具文件无效。');
  }
  if (platform === 'linux') selected.slice(0, 2).forEach(name => chmodSync(join(staging, ...name.split('/')), 0o700));
  return { selected, ffmpegPath: join(staging, ...selected[0].split('/')), ffprobePath: join(staging, ...selected[1].split('/')) };
}

export async function inspectVideoTools(paths, { run = runCommand } = {}) {
  if (!['ffmpegPath', 'ffprobePath'].every(key => typeof paths[key] === 'string' && isAbsolute(paths[key]) && regular(paths[key]))) fail('视频工具路径须指向普通可执行文件。');
  const ffmpegPath = realpathSync(paths.ffmpegPath), ffprobePath = realpathSync(paths.ffprobePath);
  for (const [name, file] of [['ffmpeg', ffmpegPath], ['ffprobe', ffprobePath]]) {
    const result = await run(file, ['-version']);
    const output = result.stdout + result.stderr;
    if (result.status !== 0 || !(new RegExp('^' + name + ' version n?9\\.0\\.2(?:[-.\\s]|$)', 'm')).test(output)
      || /--enable-(?:gpl|nonfree)\b/.test(output)) fail('视频工具须为 FFmpeg 9.0.2 LGPL 构建。');
  }
  const license = await run(ffmpegPath, ['-L']);
  if (license.status !== 0 || !/GNU Lesser General Public License/i.test(license.stdout + license.stderr)) fail('FFmpeg 未声明 LGPL 许可。');
  const decoders = await run(ffmpegPath, ['-hide_banner', '-decoders']);
  if (decoders.status !== 0 || !/^\s*V\S*\s+h264\s/m.test(decoders.stdout) || !/^\s*A\S*\s+aac\s/m.test(decoders.stdout)) fail('视频工具缺少 H.264 或 AAC 解码器。');
  const encoders = await run(ffmpegPath, ['-hide_banner', '-encoders']);
  if (encoders.status !== 0 || !/^\s*V\S*\s+mjpeg\s/m.test(encoders.stdout) || !/^\s*A\S*\s+pcm_s16le\s/m.test(encoders.stdout)) fail('视频工具缺少JPEG或PCM16输出能力。');
  const demuxers = await run(ffmpegPath, ['-hide_banner', '-demuxers']);
  const muxers = await run(ffmpegPath, ['-hide_banner', '-muxers']);
  if (demuxers.status !== 0 || !/^\s*D\s+mov,mp4,/m.test(demuxers.stdout) || muxers.status !== 0
    || !['image2pipe', 's16le'].every(name => new RegExp('^\\s*E\\s+' + name + '\\s', 'm').test(muxers.stdout))) fail('视频工具缺少MP4分轨或本地图片、音频输出格式。');
  return { ffmpegPath, ffprobePath };
}

export function preparedVideoConfiguration(previous, paths) {
  if (previous === null) return { enabled: true, ...paths };
  if (!previous || typeof previous !== 'object' || Array.isArray(previous) || typeof previous.enabled !== 'boolean' || Object.keys(previous).some(key => !configKeys.includes(key))) fail('已有视频配置无效，未修改。');
  const present = configKeys.slice(1).filter(key => Object.hasOwn(previous, key));
  if (previous.enabled && !present.length || present.length && (present.length !== 2 || present.some(key => typeof previous[key] !== 'string' || !isAbsolute(previous[key])))) fail('已有视频工具路径不完整，未修改。');
  if (present.length && present.some(key => resolve(previous[key]) !== resolve(paths[key]))) fail('已有视频配置使用其他路径，未覆盖；请核对后显式指定原路径。');
  return { enabled: previous.enabled, ...paths };
}
function removeStage(path, parent) {
  const actual = realpathSync(path), allowed = realpathSync(parent);
  if (dirname(actual) !== allowed || !basename(actual).startsWith('.video-stage-') || !directory(path)) fail('临时工具目录变化，未删除未知目录。');
  function inspect(folder) { for (const item of readdirSync(folder, { withFileTypes: true })) { if (item.isSymbolicLink()) fail('临时目录出现链接，未删除。'); if (item.isDirectory()) inspect(join(folder, item.name)); } }
  inspect(actual); rmSync(actual, { recursive: true });
}
async function cachedTools(folder, asset, platform) {
  if (!directory(folder) || !regular(join(folder, receiptName))) fail('已有工具目录缺少完整校验记录，未覆盖。');
  const receipt = JSON.parse(readFileSync(join(folder, receiptName), 'utf8'));
  if (receipt.schemaVersion !== 1 || receipt.archiveSha256 !== asset.sha256 || !receipt.files || typeof receipt.files !== 'object' || Array.isArray(receipt.files)) fail('已有工具校验记录无效，未覆盖。');
  const selected = selection(new Set(Object.keys(receipt.files)), asset, platform);
  if (Object.keys(receipt.files).length !== selected.length) fail('已有工具记录包含未知文件，未覆盖。');
  const all = [];
  function walk(path, relative = '') { for (const item of readdirSync(path, { withFileTypes: true })) { if (item.isSymbolicLink()) fail('已有工具目录含链接。'); const name = relative ? relative + '/' + item.name : item.name; if (item.isDirectory()) walk(join(path, item.name), name); else all.push(name); } }
  walk(folder);
  if (all.sort().join('\n') !== [...selected, receiptName].sort().join('\n')) fail('已有工具目录含未知或缺失文件，未覆盖。');
  for (const file of selected) if (!regular(join(folder, ...file.split('/'))) || !/^[a-f0-9]{64}$/.test(receipt.files[file]) || await digest(join(folder, ...file.split('/'))) !== receipt.files[file]) fail('已有视频工具完整性校验失败，未覆盖。');
  return { ffmpegPath: join(folder, ...selected[0].split('/')), ffprobePath: join(folder, ...selected[1].split('/')) };
}

export async function prepareVideo({ dataDir, ffmpegPath, ffprobePath, fetcher = fetch, run = runCommand, log = console.log }) {
  if (!isAbsolute(dataDir) || !lstatSync(dataDir, { throwIfNoEntry: false })?.isDirectory()) fail('数据目录须为已存在的绝对路径。');
  if (Boolean(ffmpegPath) !== Boolean(ffprobePath)) fail('请同时指定 FFmpeg 与 ffprobe 的绝对路径。');
  dataDir = realpathSync(dataDir); if (dataDir === dirname(dataDir)) fail('不能使用文件系统根目录。');
  const configurationPath = join(dataDir, 'video-runtime.json');
  if (existsSync(configurationPath) && !regular(configurationPath)) fail('已有视频配置必须是普通文件。');
  const before = existsSync(configurationPath) ? readFileSync(configurationPath, 'utf8') : null;
  const previous = before === null ? null : JSON.parse(before.replace(/^\uFEFF/, ''));
  let paths, downloaded = 0, reused = false;
  log('FFmpeg 使用固定 LGPL 构建；来源与许可：https://github.com/BtbN/FFmpeg-Builds ，https://ffmpeg.org/legal.html');
  if (ffmpegPath) {
    preparedVideoConfiguration(previous, { ffmpegPath, ffprobePath });
    paths = await inspectVideoTools({ ffmpegPath, ffprobePath }, { run });
  } else {
    const asset = videoToolAssets[process.platform]; if (!asset) fail('当前平台未提供固定视频工具。');
    const toolsRoot = join(dataDir, 'video-tools');
    if (!existsSync(toolsRoot)) mkdirSync(toolsRoot, { mode: 0o700 });
    if (!directory(toolsRoot)) fail('视频工具缓存目录不能是链接。');
    const folder = join(toolsRoot, 'btbn-' + build + '-' + process.platform);
    const extension = process.platform === 'win32' ? '.exe' : '';
    const defaults = { ffmpegPath: join(folder, asset.archiveRoot, 'bin', 'ffmpeg' + extension), ffprobePath: join(folder, asset.archiveRoot, 'bin', 'ffprobe' + extension) };
    preparedVideoConfiguration(previous, defaults);
    if (existsSync(folder)) { paths = await cachedTools(folder, asset, process.platform); reused = true; }
    else {
      const downloads = join(toolsRoot, 'downloads'); if (!existsSync(downloads)) mkdirSync(downloads, { mode: 0o700 });
      if (!directory(downloads)) fail('视频工具下载目录不能是链接。');
      const archive = join(downloads, asset.name);
      downloaded = await downloadVideoArchive(asset, archive, { fetcher, log }) === 'downloaded' ? 1 : 0;
      const staging = mkdtempSync(join(toolsRoot, '.video-stage-')); let cleanupSafe = true;
      try {
        const result = await extractVideoArchive(asset, archive, staging, { run });
        await inspectVideoTools(result, { run });
        const files = Object.fromEntries(await Promise.all(result.selected.map(async name => [name, await digest(join(staging, ...name.split('/')))])));
        writeFileSync(join(staging, receiptName), JSON.stringify({ schemaVersion: 1, archiveSha256: asset.sha256, files }, null, 2), { flag: 'wx', mode: 0o600 });
        if (existsSync(folder)) fail('工具目录在准备期间出现，未替换。');
        renameSync(staging, folder); paths = defaults;
      } catch (error) { if (error.cleanupUnsafe) cleanupSafe = false; throw error; }
      finally { if (existsSync(staging) && cleanupSafe) removeStage(staging, toolsRoot); }
    }
    paths = await inspectVideoTools(paths, { run });
  }
  const configuration = preparedVideoConfiguration(previous, paths);
  if ((existsSync(configurationPath) ? readFileSync(configurationPath, 'utf8') : null) !== before) fail('准备期间视频配置已变化，完整工具保留，未覆盖配置。');
  const configurationUpdated = before === null || configKeys.some(key => previous[key] !== configuration[key]);
  if (configurationUpdated) {
    const temporary = join(dataDir, '.video-runtime-' + randomUUID() + '.tmp');
    try {
      writeFileSync(temporary, JSON.stringify(configuration, null, 2), { flag: 'wx', mode: 0o600 });
      if ((existsSync(configurationPath) ? readFileSync(configurationPath, 'utf8') : null) !== before) fail('视频配置已变化，未覆盖。');
      renameSync(temporary, configurationPath);
    } finally { if (existsSync(temporary)) { if (!regular(temporary) || dirname(realpathSync(temporary)) !== dataDir) fail('临时配置路径变化，未删除。'); rmSync(temporary); } }
  }
  return { prepared: true, enabled: configuration.enabled, configurationUpdated, downloaded, reused, build, resources: ['ffmpeg', 'ffprobe'] };
}

async function main() {
  const args = process.argv.slice(2), options = {};
  if (args.length === 1 && args[0] === '--help') { console.log(help); return; }
  for (let index = 0; index < args.length; index += 2) {
    if (!['--data-dir', '--ffmpeg', '--ffprobe'].includes(args[index]) || !args[index + 1] || Object.hasOwn(options, args[index])) fail(help);
    options[args[index]] = args[index + 1];
  }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || major === 22 && minor < 16 || !['win32', 'linux'].includes(process.platform) || process.arch !== 'x64') fail('视频工具准备需要 Node.js 22.16+，当前目标为 Windows x64 或 Linux glibc x64。');
  if (options['--data-dir'] && !isAbsolute(options['--data-dir'])) fail(help);
  console.log(JSON.stringify(await prepareVideo({ dataDir: resolve(options['--data-dir'] || process.env.PERSONA_DATA_DIR || join(root, 'data')), ffmpegPath: options['--ffmpeg'], ffprobePath: options['--ffprobe'] })));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.validation ? error.message : '视频工具准备未完成，请检查目录、网络与固定构建。'); process.exitCode = 1; });
