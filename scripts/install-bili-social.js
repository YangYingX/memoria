import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { biliSocialPins } from '../src/bili-social-runtime.js';

const help = '用法：Node.js 24 scripts/install-bili-social.js --directory <独立新目录> --python <Python命令或路径>\n仅安装独立运行依赖，输出关闭状态的配置，不修改栖忆配置或登录账号。';
const args = process.argv.slice(2), options = {};
function fail(message) { throw new Error(message); }
function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { ...options, windowsHide: true, encoding: 'utf8', timeout: 300000 });
  if (result.error || result.status !== 0) fail('依赖命令未完成，请检查 Python、venv、pip、tar 和网络连接。');
  return result.stdout.trim();
}
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
async function download(url, path, expected) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (!response.ok) fail('无法下载固定版依赖归档。');
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) fail('依赖归档超过安装上限。'); chunks.push(chunk); }
  const contents = Buffer.concat(chunks);
  if (createHash('sha256').update(contents).digest('hex') !== expected) fail('固定版依赖归档校验失败，未安装。');
  writeFileSync(path, contents, { flag: 'wx' });
}

try {
  if (args.includes('--help')) { console.log(help); process.exit(0); }
  for (let index = 0; index < args.length; index += 2) {
    if (!['--directory', '--python'].includes(args[index]) || !args[index + 1] || Object.hasOwn(options, args[index])) fail(help);
    options[args[index]] = args[index + 1];
  }
  if (Number(process.versions.node.split('.')[0]) !== 24 || !options['--directory'] || !options['--python']) fail(help);
  const directory = resolve(options['--directory']), python = options['--python'];
  if (!isAbsolute(options['--directory']) || directory === dirname(directory) || existsSync(directory)
    || !lstatSync(dirname(directory)).isDirectory() || realpathSync(dirname(directory)) !== dirname(directory)) fail('安装目标必须是现有真实父目录下尚不存在的绝对路径。');
  if (!isAbsolute(python) && !/^[a-zA-Z0-9_.-]+$/.test(python)) fail('Python 必须为可执行命令名或绝对路径。');
  const version = JSON.parse(command(python, ['-I', '-c', 'import json,sys;print(json.dumps(list(sys.version_info[:2])))']));
  if (version[0] !== 3 || version[1] < 10) fail('需要 Python 3.10 或更新版本。');
  command('tar', ['--version']);
  mkdirSync(directory, { mode: 0o700 });
  const host = join(directory, 'host'), downloads = join(directory, 'downloads'), packagePath = join(host, 'node_modules', 'dsh-bili-subagent');
  mkdirSync(packagePath, { recursive: true }); mkdirSync(downloads);
  const archive = join(downloads, `dsh-bili-subagent-${biliSocialPins.version}-${biliSocialPins.commit.slice(0, 8)}.tar.gz`);
  await download(`https://codeload.github.com/Yuuyuko-uu/dsh-bili-subagent/tar.gz/${biliSocialPins.commit}`, archive, biliSocialPins.archive);
  command('tar', ['-xzf', archive, '--strip-components=1', '-C', packagePath]);
  const manifest = JSON.parse(readFileSync(join(packagePath, 'package.json'), 'utf8'));
  if (manifest.name !== 'dsh-bili-subagent' || manifest.version !== biliSocialPins.version
    || hash(join(packagePath, 'lib', 'mcp.mjs')) !== biliSocialPins.client
    || hash(join(packagePath, 'vendor', 'bilibili-mcp', 'mcp_server.py')) !== biliSocialPins.server) fail('原版 MCP 模块校验失败。');
  writeFileSync(join(host, 'package.json'), JSON.stringify({ name: 'memoria-bili-social-host', private: true, type: 'module' }, null, 2));
  const venv = join(directory, 'venv');
  console.log('正在创建独立 Python 环境并安装固定版本依赖…');
  command(python, ['-m', 'venv', '--without-pip', venv]);
  const pythonPath = join(venv, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
  const requirements = fileURLToPath(new URL('../deploy/bili-social/requirements.txt', import.meta.url));
  const pip = join(downloads, 'pip-25.1.1-py3-none-any.whl');
  await download('https://files.pythonhosted.org/packages/29/a2/d40fb2460e883eca5199c62cfc2463fd261f760556ae6290f88488c362c0/pip-25.1.1-py3-none-any.whl', pip,
    '2913a38a2abf4ea6b64ab507bd9e967f3b53dc1ede74b01b0931e1ce548751af');
  command(pythonPath, ['-I', '-c', 'import runpy,sys;sys.path.insert(0,sys.argv[1]);sys.argv=sys.argv[2:];runpy.run_module("pip",run_name="__main__")',
    pip, 'pip', 'install', '--disable-pip-version-check', '--no-input', 'pip==25.1.1', '-r', requirements]);
  const installed = JSON.parse(command(pythonPath, ['-I', '-c', 'import importlib.metadata as m,json;print(json.dumps({n:m.version(n) for n in ["bilibili-api-python","mcp","httpx"]}))']));
  if (installed['bilibili-api-python'] !== '17.4.2' || installed.mcp !== '1.26.0' || installed.httpx !== '0.28.1') fail('Python 依赖版本核对失败。');
  const configuration = { enabled: false, nodePath: realpathSync(process.execPath), hostDirectory: host, pythonPath };
  writeFileSync(join(directory, '.memoria-bili-social-install.json'), JSON.stringify({ version: 1, directory, plugin: biliSocialPins, dependencies: installed }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ installed: true, configuration }, null, 2));
} catch (error) {
  console.error(error instanceof Error && !error.code ? error.message : '安装未完成；请检查独立目录与运行环境。');
  process.exitCode = 1;
}
