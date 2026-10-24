import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, realpathSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pins = { client: '7f4c02f597322a69b997666172a74317d3dff3aaac8bb1353b6f97d2e94038b6',
  server: '06d077b95fd12b26802545c4dc690fff81a651c86f53c57c911f22516ee6dd51' };
const controller = new AbortController(), pending = new Map();
let sequence = 0, client, server, python;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fields = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const send = message => new Promise((accept, reject) => process.send(message, error => error ? reject(error) : accept()));
function abort() { controller.abort(); for (const item of pending.values()) item.reject(new Error('CANCELLED')); pending.clear(); }
process.on('disconnect', abort);
process.on('SIGTERM', abort);
process.on('SIGINT', abort);
const start = new Promise((accept, reject) => {
  process.on('message', message => {
    if (message?.type === 'cancel') return abort();
    if (message?.type === 'network-result') {
      const item = pending.get(message.id);
      if (!item || !fields(message, ['type', 'id', 'result'])) return abort();
      pending.delete(message.id); item.accept(message.result); return;
    }
    if (message?.type === 'start') accept(message);
    else reject(new Error('INVALID_START'));
  });
});

async function main(input) {
  if (Number(process.versions.node.split('.')[0]) !== 24 || !fields(input, ['type', 'operation', 'hostDirectory', 'pythonPath', 'workspace', 'notice', 'text'])
    || !['inbox', 'reply', 'post'].includes(input.operation)) throw new Error('INVALID_START');
  const workspace = realpathSync(input.workspace);
  if (workspace !== realpathSync(process.cwd()) || lstatSync(input.workspace).isSymbolicLink()) throw new Error('INVALID_WORKSPACE');
  const packagePath = join(realpathSync(input.hostDirectory), 'node_modules', 'dsh-bili-subagent');
  const manifest = JSON.parse(readFileSync(join(packagePath, 'package.json'), 'utf8'));
  const clientPath = join(packagePath, 'lib', 'mcp.mjs'), script = join(workspace, 'mcp_server.py');
  if (manifest.name !== 'dsh-bili-subagent' || manifest.version !== '0.7.7' || hash(clientPath) !== pins.client
    || hash(join(packagePath, 'vendor', 'bilibili-mcp', 'mcp_server.py')) !== pins.server || hash(script) !== pins.server) throw new Error('PACKAGE_MISMATCH');
  const { McpClient } = await import(pathToFileURL(clientPath).href);
  const token = randomBytes(32).toString('hex');
  server = createServer(async (request, response) => {
    try {
      if (controller.signal.aborted || request.method !== 'POST' || request.url !== '/network'
        || request.headers.authorization !== `Bearer ${token}`) throw new Error();
      let size = 0; const chunks = [];
      for await (const chunk of request) { size += chunk.length; if (size > 16384) throw new Error(); chunks.push(chunk); }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!fields(value, ['method', 'url', 'params', 'data', 'json'])) throw new Error();
      const id = ++sequence;
      if (id > 16) throw new Error();
      const result = await new Promise((accept, reject) => { pending.set(id, { accept, reject });
        send({ type: 'network', id, request: value }).catch(reject); });
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result));
    } catch { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"error":"BROKER_REFUSED"}'); }
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  controller.signal.throwIfAborted();
  client = new McpClient({ command: input.pythonPath,
    args: ['-I', '-B', fileURLToPath(new URL('./bili-social-mcp.py', import.meta.url)), script], cwd: workspace,
    env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', BILI_MCP_TOOLS: 'bili_received_replies,bili_received_at_and_likes,bili_reply,bili_send_dynamic',
      MEMORIA_BILI_BROKER_PORT: String(server.address().port), MEMORIA_BILI_BROKER_TOKEN: token } });
  const resultPromise = (async () => {
    if (input.operation === 'post') return client.call('bili_send_dynamic', { text: input.text }, { timeoutMs: 110000 });
    if (input.operation !== 'inbox') return client.call('bili_reply', {
      bvid: input.notice.bvid, text: input.text, rpid: Number(input.notice.rpid), root: Number(input.notice.root) }, { timeoutMs: 110000 });
    const replies = await client.call('bili_received_replies', {}, { timeoutMs: 110000 });
    const mentions = await client.call('bili_received_at_and_likes', {}, { timeoutMs: 110000 });
    if (replies?.error || !Array.isArray(replies?.items) || mentions?.at_error || !Array.isArray(mentions?.items)) throw new Error('INBOX_FAILED');
    return { items: [...replies.items, ...mentions.items] };
  })();
  python = client.proc;
  const result = await Promise.race([resultPromise, new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('CANCELLED')), { once: true }))]);
  controller.signal.throwIfAborted();
  if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) throw new Error('RESULT_TOO_LARGE');
  return result;
}

let reply, code = 0;
try { reply = { type: 'result', result: await main(await start) }; }
catch { code = 1; reply = { type: 'failure', code: 'BILI_MCP_FAILED' }; }
finally {
  abort();
  python ||= client?.proc;
  client?.stop();
  if (python && python.exitCode === null) await new Promise(accept => {
    const timer = setTimeout(() => { python.kill('SIGKILL'); }, 1000);
    const hard = setTimeout(accept, 2000);
    python.once('close', () => { clearTimeout(timer); clearTimeout(hard); accept(); });
  });
  if (server) await new Promise(accept => { server.closeAllConnections(); server.close(accept); });
}
try { await send(reply); } catch { code = 1; }
if (process.connected) process.disconnect();
process.exitCode = code;
