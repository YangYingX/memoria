import { readFileSync, writeFileSync, renameSync, unlinkSync, lstatSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceHash = '6dabe5120372429d70f68cf4696458c1533a8239884150d6e57e5adedf4f0d6d';
class SetupError extends Error {}

export async function setupFeishuAccount({ hostDirectory, credentialPath, botId }) {
  if (typeof botId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(botId)
    || ![hostDirectory, credentialPath].every(value => typeof value === 'string' && isAbsolute(value))) throw new SetupError('请提供机器人标识、独立宿主目录和凭据文件的绝对路径。');
  const info = lstatSync(credentialPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw new SetupError('凭据须为不超过 8 KiB 的普通文件，不能使用链接。');
  const canonicalPath = realpathSync(credentialPath), original = readFileSync(canonicalPath);
  const saved = JSON.parse(original.toString('utf8').replace(/^\uFEFF/, ''));
  if (!saved || typeof saved !== 'object' || Array.isArray(saved) || Object.keys(saved).some(key => !['appId', 'appSecret', 'domain', 'botOpenId'].includes(key))
    || typeof saved.appId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(saved.appId)
    || typeof saved.appSecret !== 'string' || !saved.appSecret.trim() || saved.appSecret.length > 512 || /[\u0000-\u001f\u007f]/.test(saved.appSecret)
    || !['feishu', 'lark'].includes(saved.domain || 'feishu')) throw new SetupError('请在凭据文件中填写 appId、appSecret 和 domain。');
  const domain = saved.domain || 'feishu';
  const require = createRequire(join(realpathSync(hostDirectory), 'package.json'));
  const packagePath = require.resolve('@xmanrui/dsh-im/package.json');
  if (JSON.parse(readFileSync(packagePath, 'utf8')).version !== '5.4.0') throw new SetupError('此入口仅适配 dsh-im 5.4.0。');
  const sourcePath = join(dirname(packagePath), 'src', 'channels', 'feishu', 'feishu-app.mjs');
  if (createHash('sha256').update(readFileSync(sourcePath)).digest('hex') !== sourceHash) throw new SetupError('飞书账号核对模块与固定版本不一致。');
  const { verifyFeishuApp } = await import(pathToFileURL(sourcePath).href);
  const origin = domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
  let verified;
  try { verified = await verifyFeishuApp({ appId: saved.appId, appSecret: saved.appSecret, domain,
    httpInstance: { async request({ url, method, headers, data, signal }) {
      const target = new URL(url);
      if (target.origin !== origin || target.search || target.hash || ![
        ['POST', '/open-apis/auth/v3/tenant_access_token/internal'], ['GET', '/open-apis/bot/v3/info/'],
      ].some(([verb, path]) => method.toUpperCase() === verb && target.pathname === path)) throw new SetupError('飞书账号核对请求无效。');
      const response = await fetch(target, { method, headers, ...(data !== undefined ? { body: JSON.stringify(data) } : {}), redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]) });
      if (!response.ok) throw new SetupError('飞书账号核对未成功，请检查应用状态和凭据。');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 65536) throw new SetupError('飞书账号核对响应超过大小限制。');
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } } }); }
  catch { throw new SetupError('飞书账号核对未完成，请检查应用状态、凭据和平台响应。'); }
  if (!verified || typeof verified.openId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(verified.openId)
    || verified.appId !== saved.appId) throw new SetupError('飞书没有返回有效的机器人身份。');
  // Pin only the identity returned by the original verifier; an earlier file value cannot assert ownership.
  const credentials = { appId: saved.appId, appSecret: saved.appSecret, domain, botOpenId: verified.openId };
  if (lstatSync(credentialPath).isSymbolicLink() || realpathSync(credentialPath) !== canonicalPath || !readFileSync(canonicalPath).equals(original)) {
    throw new SetupError('核对期间凭据文件已变化，请保留当前文件并重新核对。');
  }
  const temporary = join(dirname(realpathSync(credentialPath)), `.memoria-feishu-${randomUUID()}.tmp`);
  let created = false;
  try {
    writeFileSync(temporary, `${JSON.stringify(credentials, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); created = true;
    renameSync(temporary, canonicalPath); created = false;
  } finally { if (created) unlinkSync(temporary); }
  return { botId, botOpenId: verified.openId, expectedFingerprint: createHash('sha256').update(JSON.stringify({ provider: 'feishu', domain,
    appId: saved.appId, botOpenId: verified.openId })).digest('hex'), name: String(verified.name || '').slice(0, 200),
    activationStatus: typeof verified.activated === 'boolean' || Number.isSafeInteger(verified.activated) ? verified.activated : null };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const values = {};
  try {
    if (args.length !== 6) throw new SetupError('用法：node scripts/feishu-setup.js --host-directory 绝对路径 --credential-path 绝对路径 --bot-id 机器人标识');
    for (let i = 0; i < args.length; i += 2) {
      const key = { '--host-directory': 'hostDirectory', '--credential-path': 'credentialPath', '--bot-id': 'botId' }[args[i]];
      if (!key || values[key]) throw new SetupError('飞书初始化参数无效。');
      values[key] = args[i + 1];
    }
    console.log(JSON.stringify(await setupFeishuAccount(values), null, 2));
  } catch (error) {
    console.error(error instanceof SetupError ? error.message : '飞书账号核对未完成，请检查本机依赖、凭据文件和平台响应。');
    process.exitCode = 1;
  }
}
