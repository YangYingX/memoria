import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { matePins, verifyMatePackage } from '../src/mate-runtime.js';

const help = '用法：Node.js 24 scripts/install-mate.js --directory <独立新目录>\n下载并校验完整原版内核，输出关闭状态配置，不改栖忆配置或现有 DSH 宿主。';
function fail() { throw new Error('陪伴内核安装未完成，请检查新目录、tar 和网络连接。'); }
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(help); process.exit(0); }
  if (Number(process.versions.node.split('.')[0]) !== 24 || args.length !== 2 || args[0] !== '--directory' || !isAbsolute(args[1])) throw new Error(help);
  const directory = resolve(args[1]);
  if (directory === dirname(directory) || existsSync(directory) || !lstatSync(dirname(directory)).isDirectory() || realpathSync(dirname(directory)) !== dirname(directory)) fail();
  if (directory.split(/[\\/]/).includes('node_modules')) throw new Error('原生 TypeScript 内核必须安装在 node_modules 以外。');
  const tar = spawnSync('tar', ['--version'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
  if (tar.error || tar.status !== 0) fail();
  const response = await fetch(`https://codeload.github.com/m-rui001/dsh-mate-companion/tar.gz/${matePins.commit}`, { redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (!response.ok) fail();
  const parts = []; let bytes = 0;
  for await (const part of response.body) { bytes += part.length; if (bytes > 4 * 1024 * 1024) fail(); parts.push(part); }
  const archive = Buffer.concat(parts);
  if (createHash('sha256').update(archive).digest('hex') !== matePins.archive) throw new Error('固定版原包校验失败，未安装。');
  mkdirSync(directory, { mode: 0o700 });
  const archivePath = join(directory, `dsh-mate-companion-${matePins.version}-${matePins.commit.slice(0, 8)}.tar.gz`);
  writeFileSync(archivePath, archive, { flag: 'wx' });
  const packageDirectory = join(directory, 'package'); mkdirSync(packageDirectory);
  const extracted = spawnSync('tar', ['-xzf', archivePath, '--strip-components=1', '-C', packageDirectory], { windowsHide: true, stdio: 'ignore', timeout: 60000 });
  if (extracted.error || extracted.status !== 0) fail();
  verifyMatePackage(packageDirectory);
  writeFileSync(join(directory, '.memoria-mate-install.json'), JSON.stringify({ version: 1, directory, commit: matePins.commit, archiveSha256: matePins.archive }), { flag: 'wx' });
  console.log(JSON.stringify({ installed: true, configuration: { enabled: false, nodePath: realpathSync(process.execPath), packageDirectory } }, null, 2));
} catch (error) {
  console.error(error instanceof Error && !error.code ? error.message : '陪伴内核安装未完成。');
  process.exitCode = 1;
}
