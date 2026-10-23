import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const memeVersion = '0.1.60';
const dshVersion = '0.2.1-rc.2';
const memeHash = '27a387bd6f267cfcd8b271966bff69e7e7594ed4ed6616bba35f765ebc9b49b9';
const toolsHash = '1e53932e7c4213ea24a7d87f06960b7a7702cb21f8a5741c97242b4a470a442a';

function fail(code) { throw Object.assign(new Error(code), { code }); }
function fields(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
}
function manifest(path, name, version) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (value.name !== name || value.version !== version) fail('DSH_MEME_PACKAGE_MISMATCH');
}
function digest(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function packageFile(hostDirectory) {
  try {
    if (typeof hostDirectory !== 'string' || !isAbsolute(hostDirectory)) fail('DSH_MEME_PACKAGE_MISMATCH');
    const require = createRequire(join(hostDirectory, 'package.json'));
    manifest(require.resolve('@deepseek-ai/dsh/package.json'), '@deepseek-ai/dsh', dshVersion);
    const packagePath = require.resolve('dsh-meme/package.json');
    manifest(packagePath, 'dsh-meme', memeVersion);
    const file = realpathSync(join(dirname(packagePath), 'memes.js'));
    if (digest(file) !== memeHash) fail('DSH_MEME_PACKAGE_MISMATCH');
    // Verify the real peer imported by this original file, including a possible nested install.
    const peer = createRequire(file);
    manifest(peer.resolve('@deepseek-ai/dsh-tools/package.json'), '@deepseek-ai/dsh-tools', dshVersion);
    if (digest(peer.resolve('@deepseek-ai/dsh-tools')) !== toolsHash) fail('DSH_MEME_PACKAGE_MISMATCH');
    return file;
  } catch { fail('DSH_MEME_PACKAGE_MISMATCH'); }
}

export function inspectMeme(hostDirectory) {
  packageFile(hostDirectory);
  return { engine: 'dsh-meme', version: memeVersion, packageVerified: true, searchExecuted: false };
}

export async function searchExpressions({ hostDirectory, query, items, signal }) {
  signal?.throwIfAborted();
  if (process.versions.node.split('.')[0] !== '24') fail('NODE_VERSION_MISMATCH');
  if (typeof query !== 'string' || !query.trim() || query.trim().length > 80 || query !== query.trim()
    || !Array.isArray(items) || items.length > 128 || items.some(item => !fields(item, ['id', 'name', 'description'])
      || typeof item.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(item.id)
      || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 80
      || typeof item.description !== 'string' || item.description.length > 500)
    || new Set(items.map(item => item.id)).size !== items.length) fail('DSH_MEME_INVALID_INPUT');
  const file = packageFile(hostDirectory);
  const original = await import(pathToFileURL(file).href);
  signal?.throwIfAborted();
  if (typeof original.searchRows !== 'function') fail('DSH_MEME_PACKAGE_MISMATCH');
  const rows = items.map(item => ({ id: item.id, caption: `${item.name} ${item.description}` }));
  const result = original.searchRows(rows, query, 6);
  if (!result || !Array.isArray(result.memes) || result.memes.length > 6
    || result.memes.some(row => !rows.includes(row)) || new Set(result.memes.map(row => row.id)).size !== result.memes.length) fail('DSH_MEME_INVALID_RESULT');
  const byId = new Map(items.map(item => [item.id, item]));
  const expressions = result.memes.map(row => {
    const item = byId.get(row.id);
    return { id: item.id, name: item.name, description: item.description };
  });
  signal?.throwIfAborted();
  return { expressions, engine: 'dsh-meme' };
}
