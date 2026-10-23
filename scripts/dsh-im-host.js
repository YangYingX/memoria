import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const imVersion = '5.4.0';
const imEntryHash = '26272ce2f75828f25eb212db717dec4c9b71346912a8cf9c9cfe190eb710e185';
const lifecycle = new AbortController();
const acknowledgements = new Map();
const routes = new Map();
const replies = new Map();
const replyCodes = new Set(['account-changed', 'account-unverified', 'bot-not-connected', 'stale-route', 'bad-request', 'capability-unavailable', 'consumer-unavailable', 'cancelled']);
const proactiveCodes = new Set([...replyCodes, 'target-changed', 'unknown-target', 'target-conflict', 'invalid-target', 'history-permission-denied', 'history-unavailable']);
let input, runtime, registration, directory, directoryParent, bootPromise, stopping;
let ready = false, closing = false, sequence = 0, lastReplyId = 0;

// SDK diagnostics can contain authenticated request details. IPC carries only bounded public results.
for (const method of ['log', 'info', 'warn', 'error', 'debug']) console[method] = () => {};

function failure(code) { throw Object.assign(new Error(code), { code }); }
function fields(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
}
function identifier(value) { return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value); }
function fingerprint(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function id(value) { return Number.isSafeInteger(value) && value > 0; }
function active() { if (closing || lifecycle.signal.aborted) failure('DSH_IM_STOPPED'); }
function folder(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096) failure('DSH_IM_INVALID_PATH');
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) failure('DSH_IM_INVALID_PATH');
  return path;
}
function credential(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) failure('DSH_IM_CREDENTIAL_INVALID');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384 || realpathSync(path) !== path) failure('DSH_IM_CREDENTIAL_INVALID');
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!fields(value, ['appId', 'appSecret', 'domain', 'botOpenId']) || !identifier(value.appId) || !identifier(value.botOpenId)
    || !['feishu', 'lark'].includes(value.domain) || typeof value.appSecret !== 'string' || !value.appSecret.trim()
    || value.appSecret.length > 1024 || /[\s\u0000-\u001f\u007f]/u.test(value.appSecret)) failure('DSH_IM_CREDENTIAL_INVALID');
  return value;
}
function send(message) {
  return new Promise((resolve, reject) => {
    if (!process.connected || typeof process.send !== 'function') return reject(new Error('IPC_DISCONNECTED'));
    process.send(message, error => error ? reject(new Error('IPC_DISCONNECTED')) : resolve());
  });
}
function routeKey(route) {
  if (!fields(route, ['messageId', 'conversationId', 'actorId', 'threadId', 'rootId', 'parentId'])
    || !['messageId', 'conversationId', 'actorId'].every(key => identifier(route[key]))
    || ['threadId', 'rootId', 'parentId'].some(key => route[key] !== undefined && !identifier(route[key]))) failure('bad-request');
  return JSON.stringify(['messageId', 'conversationId', 'actorId', 'threadId', 'rootId', 'parentId'].map(key => route[key] ?? null));
}
function descriptor(value) {
  if (value?.version !== 1 || value.botId !== input.botId || value.channel !== 'feishu' || value.connected !== true
    || value.account?.fingerprint !== input.expectedFingerprint || !Array.isArray(value.capabilities)
    || !['exclusive-text-consumer', 'reply-text-checked'].every(item => value.capabilities.includes(item))) failure('DSH_IM_ACCOUNT_UNVERIFIED');
  return { version: 1, botId: input.botId, channel: 'feishu', account: { fingerprint: input.expectedFingerprint }, connected: true,
    capabilities: ['exclusive-text-consumer', 'reply-text-checked', 'proactive-text-checked', 'proactive-receipt-checked', 'history-text-checked']
      .filter(item => value.capabilities.includes(item)) };
}
function accept(event, { signal }) {
  active();
  if (!ready) failure('consumer-unavailable');
  if (event?.version !== 1 || event.channel !== 'feishu' || event.botId !== input.botId || event.fingerprint !== input.expectedFingerprint
    || event.actor?.kind !== 'user' || !identifier(event.actor.id) || !identifier(event.messageId)
    || !identifier(event.conversation?.id) || !['group', 'dm'].includes(event.conversation.kind)
    || typeof event.text !== 'string' || !event.text.trim() || event.text.length > 8000
    || Buffer.byteLength(JSON.stringify(event), 'utf8') > 32768 || acknowledgements.size >= 100) failure('bad-request');
  const key = routeKey(event.reply);
  if (event.reply.actorId !== event.actor.id || event.reply.messageId !== event.messageId || event.reply.conversationId !== event.conversation.id) failure('bad-request');
  if (!routes.has(key) && routes.size >= 1000) {
    for (const [oldKey, entry] of routes) if (!entry.pending) { routes.delete(oldKey); if (routes.size < 1000) break; }
    if (routes.size >= 1000) failure('consumer-unavailable');
  }
  return new Promise((resolve, reject) => {
    const requestId = ++sequence;
    const entry = routes.get(key) ?? { route: structuredClone(event.reply), accepted: false, used: false, pending: 0 };
    routes.set(key, entry); entry.pending++;
    const finish = (error, accepted) => {
      if (!acknowledgements.delete(requestId)) return;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      entry.pending--;
      if (error || accepted !== true || closing) {
        if (!entry.accepted && !entry.pending && routes.get(key) === entry) routes.delete(key);
        return reject(Object.assign(new Error('ingress-not-accepted'), { code: 'ingress-not-accepted' }));
      }
      entry.accepted = true; routes.set(key, entry); resolve({ accepted: true });
    };
    const abort = () => finish('cancelled');
    const timer = setTimeout(() => finish('timeout'), 10000);
    acknowledgements.set(requestId, { finish });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    send({ type: 'inbound', epoch: input.epoch, id: requestId, event }).catch(() => finish('disconnected'));
  });
}
async function reply(message) {
  if (!id(message.id) || message.id <= lastReplyId) return;
  lastReplyId = message.id;
  let task;
  const result = async value => {
    if (task?.reported || closing) return;
    if (task) task.reported = true;
    await send({ type: 'reply-result', epoch: input.epoch, id: message.id, ...value }).catch(() => {});
  };
  try {
    active();
    if (!ready || replies.size >= 4
      || !fields(message, ['type', 'epoch', 'id', 'route', 'text', 'recovered'])
      || (message.recovered !== undefined && typeof message.recovered !== 'boolean') || typeof message.text !== 'string'
      || !message.text.trim() || message.text.length > 4000 || /\0/u.test(message.text)) failure('bad-request');
    const key = routeKey(message.route);
    let entry = routes.get(key);
    // Only the parent ledger can authorize an unprocessed source from an earlier epoch.
    if (!entry && message.recovered === true) {
      if (routes.size >= 1000) {
        for (const [oldKey, previous] of routes) if (!previous.pending) { routes.delete(oldKey); if (routes.size < 1000) break; }
        if (routes.size >= 1000) failure('consumer-unavailable');
      }
      entry = { route: structuredClone(message.route), accepted: true, used: false, pending: 0 };
      routes.set(key, entry);
    }
    if (!entry?.accepted || entry.used) failure('stale-route');
    entry.used = true;
    const controller = new AbortController();
    task = { controller, entry, reported: false, result };
    entry.pending++;
    replies.set(message.id, task);
    const signal = AbortSignal.any([controller.signal, lifecycle.signal]);
    signal.throwIfAborted();
    const receipt = await runtime.ctx.get('dshIm').replyChecked(input.botId, entry.route, message.text,
      { expectedFingerprint: input.expectedFingerprint, signal });
    if (signal.aborted) return result({ outcome: 'unknown', code: 'cancelled' });
    if (receipt?.sent !== true || !identifier(receipt.messageId)) failure('reply-result-unknown');
    await result({ outcome: 'sent', receipt: { sent: true, messageId: receipt.messageId } });
  } catch (error) {
    const code = replyCodes.has(error?.code) ? error.code : 'reply-result-unknown';
    await result({ outcome: code === 'reply-result-unknown' || code === 'cancelled' ? 'unknown' : 'failed', code });
  } finally {
    if (task) task.entry.pending--;
    if (replies.get(message.id) === task) replies.delete(message.id);
  }
}
async function proactive(message) {
  if (!id(message.id) || message.id <= lastReplyId) return;
  lastReplyId = message.id;
  let task;
  const result = async value => {
    if (task?.reported || closing) return;
    if (task) task.reported = true;
    await send({ type: 'proactive-result', epoch: input.epoch, id: message.id, ...value }).catch(() => {});
  };
  try {
    active();
    if (!ready || replies.size >= 4 || !fields(message, ['type', 'epoch', 'id', 'route', 'text'])
      || !message.route || message.route.kind !== 'dm' || typeof message.text !== 'string' || !message.text.trim()
      || message.text.length > 4000 || message.text.includes('\0')) failure('bad-request');
    const { kind, ...route } = message.route;
    routeKey(route);
    const controller = new AbortController();
    task = { kind: 'proactive', controller, reported: false, permitted: false, result };
    replies.set(message.id, task);
    const signal = AbortSignal.any([controller.signal, lifecycle.signal]);
    const check = () => { active(); signal.throwIfAborted(); };
    const api = runtime.ctx.get('dshIm');
    const account = descriptor(await api.describeBot(input.botId)); check();
    if (!['proactive-text-checked', 'proactive-receipt-checked', 'history-text-checked'].every(value => account.capabilities.includes(value))
      || typeof api.historyChecked !== 'function' || typeof api.sendChecked !== 'function') failure('capability-unavailable');
    // The parent proves this was an owner DM. The original checked read revalidates
    // its source sender/chat/thread; its nearby page is neither a new input nor a model prompt.
    await api.historyChecked(input.botId, route, { scope: 'group', limit: 1 }, { expectedFingerprint: input.expectedFingerprint, signal }); check();
    const targetId = `memoria_dm_${createHash('sha256').update(JSON.stringify([input.expectedFingerprint, route.conversationId, route.actorId])).digest('hex').slice(0, 40)}`;
    let targets = await api.listTargets(input.botId); check();
    if (!Array.isArray(targets) || targets.length > 1000) failure('capability-unavailable');
    if (!targets.some(value => value?.targetId === targetId)) {
      if (targets.length >= 1000) failure('capability-unavailable');
      // Native "group" means chat_id addressing here. The destination remains the
      // parent's verified private chat; it never enables unsolicited group sends.
      await api.createTarget(input.botId, { targetId, kind: 'group', route: { chatId: route.conversationId } }); check();
      targets = await api.listTargets(input.botId); check();
    }
    const target = targets.find(value => value?.targetId === targetId);
    if (!target || target.kind !== 'group' || !fields(target.route, ['chatId']) || Object.keys(target.route).length !== 1
      || target.route.chatId !== route.conversationId) failure('target-changed');
    const expectedTargetDigest = createHash('sha256').update(JSON.stringify({ kind: 'group', route: { chatId: route.conversationId } })).digest('hex');
    await new Promise((accept, reject) => {
      const finish = allowed => {
        if (!task.permit) return;
        task.permit = undefined; clearTimeout(timer); signal.removeEventListener('abort', abort);
        if (allowed !== true || signal.aborted || closing) reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
        else { task.permitted = true; accept(); }
      };
      const abort = () => finish(false);
      const timer = setTimeout(abort, 10000);
      task.permit = finish;
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) return abort();
      send({ type: 'proactive-prepared', epoch: input.epoch, id: message.id }).catch(abort);
    });
    check();
    const sent = await api.sendChecked(input.botId, targetId, message.text,
      { expectedFingerprint: input.expectedFingerprint, expectedTargetDigest, signal, format: 'plain', receipt: true });
    check();
    if (sent?.sent !== true || sent.receipt?.version !== 1 || !identifier(sent.receipt.messageId)
      || sent.receipt.conversationId !== route.conversationId) failure('send-result-unknown');
    await result({ outcome: 'sent', receipt: { sent: true, messageId: sent.receipt.messageId, conversationId: route.conversationId,
      botId: input.botId, fingerprint: input.expectedFingerprint } });
  } catch (error) {
    const code = proactiveCodes.has(error?.code) ? error.code : 'send-result-unknown';
    await result({ outcome: task?.permitted ? 'unknown' : 'failed', code });
  } finally {
    task?.permit?.(false);
    if (replies.get(message.id) === task) replies.delete(message.id);
  }
}
function removeDirectory() {
  if (!directory) return;
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory
    || dirname(directory) !== directoryParent || !basename(directory).startsWith('.memoria-feishu-')) failure('DSH_IM_CLEANUP_FAILED');
  process.chdir(directoryParent);
  rmSync(directory, { recursive: true, force: false }); directory = undefined;
}
function stop(code = 0) {
  if (stopping) return stopping;
  closing = true; ready = false; lifecycle.abort();
  for (const request of [...acknowledgements.values()]) request.finish('stopped');
  for (const task of replies.values()) task.controller.abort();
  try { registration?.(); } catch {}
  stopping = (async () => {
    // If profile boot is still in flight, it checks closing before mounting the integration.
    if (!runtime) await bootPromise?.catch(() => {});
    try { await runtime?.shutdown.shutdown(code); }
    catch { code = 1; }
    try { await bootPromise?.catch(() => {}); removeDirectory(); }
    catch { code = 1; }
    await send({ type: 'stopped', epoch: input?.epoch || '', code }).catch(() => {});
    if (process.connected) process.disconnect();
    process.exit(code);
  })();
  return stopping;
}
async function boot(value) {
  if (!fields(value, ['type', 'protocol', 'epoch', 'hostDirectory', 'profileDirectory', 'credentialPath', 'botId', 'expectedFingerprint'])
    || value.protocol !== 1 || !identifier(value.epoch) || !identifier(value.botId) || !fingerprint(value.expectedFingerprint)
    || process.versions.node.split('.')[0] !== '24') failure('DSH_IM_INVALID_START');
  input = value;
  const host = folder(value.hostDirectory);
  directoryParent = folder(value.profileDirectory);
  const require = createRequire(join(host, 'package.json'));
  const dsh = JSON.parse(readFileSync(require.resolve('@deepseek-ai/dsh/package.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(require.resolve('@xmanrui/dsh-im/package.json'), 'utf8'));
  const entry = require.resolve('@xmanrui/dsh-im');
  if (dsh.name !== '@deepseek-ai/dsh' || dsh.version !== '0.2.1-rc.2' || manifest.name !== '@xmanrui/dsh-im'
    || manifest.version !== imVersion || createHash('sha256').update(readFileSync(entry)).digest('hex') !== imEntryHash) failure('DSH_IM_PACKAGE_MISMATCH');
  const secret = credential(value.credentialPath);
  const expected = createHash('sha256').update(JSON.stringify({ provider: 'feishu', domain: secret.domain, appId: secret.appId, botOpenId: secret.botOpenId })).digest('hex');
  if (expected !== input.expectedFingerprint) failure('DSH_IM_ACCOUNT_UNVERIFIED');
  directory = realpathSync(mkdtempSync(join(directoryParent, '.memoria-feishu-')));
  const home = join(directory, 'home');
  for (const key of Object.keys(process.env)) if (!['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'SystemDrive', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'].includes(key)) delete process.env[key];
  // Load the installed native addon directly: Windows locks a copied .node cache until exit.
  Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'localappdata'), TEMP: join(home, 'tmp'), TMP: join(home, 'tmp'), DSH_HOME: directory, DSH_TELEMETRY: '0', NARB_DISABLE_NATIVE_CACHE: '1' });
  for (const path of [home, process.env.APPDATA, process.env.LOCALAPPDATA, process.env.TEMP]) mkdirSync(path, { recursive: true });
  process.chdir(directory);
  const load = name => import(pathToFileURL(require.resolve(name)).href);
  const { initProfile, resolveProfileDir, loadLayeredEnv } = await load('@deepseek-ai/dsh-app-boot'); active();
  const { runProfile } = await load('@deepseek-ai/dsh/profile-boot'); active();
  initProfile(resolveProfileDir('memoria-feishu'), ['@deepseek-ai/dsh-base']);
  const overlay = join(directory, 'transport.yml');
  writeFileSync(overlay, ['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai'].map(name => `- id: ${name}\n  disabled: true\n`).join(''), { flag: 'wx' });
  runtime = await runProfile({ environment: loadLayeredEnv('dsh'), profile: 'memoria-feishu', patchFiles: [overlay], args: [] }); active();
  for (const name of ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-workspace', '@deepseek-ai/dsh-client-file-upload', '@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-api-workspace-controller']) {
    const module = await load(name); active(); const fork = runtime.ctx.plugin(module.default ?? module); await fork; active();
    if (fork.state !== 2) failure('DSH_IM_SERVICES_UNAVAILABLE');
  }
  const ctx = runtime.ctx;
  for (const name of ['credentials', 'connection', 'typertGateway', 'sessionController', 'workspaceController', 'workspaceRegistry']) if (!ctx.get(name)) failure('DSH_IM_SERVICES_UNAVAILABLE');
  const reference = 'MEMORIA_FEISHU_APP_SECRET';
  await ctx.credentials.set(reference, secret.appSecret); active(); secret.appSecret = '';
  const dataDir = join(directory, 'feishu'); mkdirSync(dataDir);
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ version: 2, bots: [{ id: input.botId, appId: secret.appId, secretRef: reference,
    domain: secret.domain, botOpenId: secret.botOpenId, ownerOpenIds: ['*'], consumerMode: 'external-consumer' }] }), { flag: 'wx' });
  const original = await import(pathToFileURL(entry).href); active();
  if (typeof original.createImHostPlugin !== 'function') failure('DSH_IM_PACKAGE_MISMATCH');
  const omitted = {};
  // Public composition seam: omit unrelated transports, never replace official Host services.
  for (const name of ['Weixin', 'Dingtalk', 'Wecom', 'WecomApp', 'Qq', 'Slack', 'Telegram', 'Discord', 'Office', 'Whatsapp', 'IMessage', 'Email', 'Matrix']) omitted[`apply${name}`] = async () => {};
  const fork = ctx.plugin(original.createImHostPlugin(omitted), { dshHome: directory, feishu: { dataDir, workspace: directory, slashCommands: false } });
  await fork; active(); if (fork.state !== 2) failure('DSH_IM_SERVICES_UNAVAILABLE');
  const api = ctx.get('dshIm');
  if (api?.contractVersion !== 1 || api.inboundVersion !== 1) failure('DSH_IM_SERVICES_UNAVAILABLE');
  const initial = await api.describeBot(input.botId); active();
  if (initial?.account?.fingerprint !== input.expectedFingerprint) failure('DSH_IM_ACCOUNT_UNVERIFIED');
  registration = await api.consumeInbound(input.botId, { expectedFingerprint: input.expectedFingerprint, signal: lifecycle.signal, onEvent: accept }); active();
  const verified = descriptor(await api.describeBot(input.botId)); active();
  ready = true;
  await send({ type: 'ready', protocol: 1, epoch: input.epoch, descriptor: verified });
}

process.on('message', message => {
  if (!message || typeof message !== 'object' || Buffer.byteLength(JSON.stringify(message), 'utf8') > 65536) return;
  if (message.type === 'start' && !bootPromise && !closing) {
    bootPromise = boot(message).catch(async error => {
      const known = new Set(['DSH_IM_INVALID_START', 'DSH_IM_INVALID_PATH', 'DSH_IM_CREDENTIAL_INVALID', 'DSH_IM_PACKAGE_MISMATCH', 'DSH_IM_ACCOUNT_UNVERIFIED', 'DSH_IM_SERVICES_UNAVAILABLE']);
      const code = known.has(error?.code) ? error.code : ['account-changed', 'account-unverified'].includes(error?.code) ? 'DSH_IM_ACCOUNT_UNVERIFIED' : 'DSH_IM_START_FAILED';
      if (!closing) await send({ type: 'failure', epoch: input?.epoch || message.epoch || '', code }).catch(() => {});
      void stop(1);
    });
    return;
  }
  if (!input || message.epoch !== input.epoch || closing) return;
  if (message.type === 'inbound-result' && fields(message, ['type', 'epoch', 'id', 'accepted']) && id(message.id) && typeof message.accepted === 'boolean') {
    acknowledgements.get(message.id)?.finish(null, message.accepted);
  } else if (message.type === 'reply' && id(message.id)) void reply(message);
  else if (message.type === 'proactive' && id(message.id)) void proactive(message);
  else if (message.type === 'proactive-permit' && fields(message, ['type', 'epoch', 'id', 'allowed']) && id(message.id) && typeof message.allowed === 'boolean') {
    const task = replies.get(message.id);
    if (task?.kind === 'proactive') task.permit?.(message.allowed);
  }
  else if (message.type === 'cancel' && fields(message, ['type', 'epoch', 'id']) && id(message.id)) {
    const task = replies.get(message.id);
    if (task) { task.controller.abort(); void task.result({ outcome: 'unknown', code: 'cancelled' }); }
  } else if (message.type === 'stop' && fields(message, ['type', 'epoch'])) void stop();
});
process.on('disconnect', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
