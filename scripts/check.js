import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const files = [...['src', 'public', 'scripts', 'extensions/bili-login-bridge'].flatMap(directory =>
  readdirSync(directory).filter(file => file.endsWith('.js')).map(file => resolve(directory, file))),
  resolve('src/vendor/dsh-im-humanize/send-delay.mjs')];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax OK: ${files.length} JavaScript files.`);
