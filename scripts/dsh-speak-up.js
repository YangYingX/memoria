import { writeFileSync, unlinkSync, lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Readable } from 'node:stream';

// The host verifies the pinned original package before this adapter loads it.
// Only its single-shot route is used; no HTTP listener or plugin timer is opened.
export async function triggerSpeakUp({ ctx, load, agent, query, signal }) {
  const home = process.env.DSH_HOME;
  if (typeof home !== 'string' || !isAbsolute(home) || !lstatSync(home).isDirectory() || lstatSync(home).isSymbolicLink()
    || typeof agent?.id !== 'string' || !agent.id || typeof query !== 'string' || !query.trim() || query.length > 500 || query.includes('\0')) {
    throw new Error('DSH_SPEAK_UP_INVALID_INPUT');
  }
  const path = join(home, 'speak-up-config.json');
  let scope, owned = false, disposed = false, roll, used = false, suppressed = 0;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try { await scope?.dispose(); }
    finally { if (owned) { owned = false; unlinkSync(path); } }
  };
  try {
    signal?.throwIfAborted();
    const plugin = await load('dsh-speak-up');
    signal?.throwIfAborted();
    if (plugin?.name !== 'speak-up' || typeof plugin.apply !== 'function') throw new Error('DSH_SPEAK_UP_INVALID_PLUGIN');
    writeFileSync(path, JSON.stringify({ 总开关: false, 试运行: true, 目标会话: [agent.id], 间隔分钟: 1440,
      角色: 'user', 触发文案: query }), { flag: 'wx' });
    owned = true;
    const webServer = {
      register(route) {
        if (route.kind !== 'exact' || route.path !== '/dsh-speak-up/roll') return () => {};
        if (roll || typeof route.handler !== 'function') throw new Error('DSH_SPEAK_UP_INVALID_ROUTE');
        const handler = async (req, res) => {
          signal?.throwIfAborted();
          if (used) throw new Error('DSH_SPEAK_UP_ALREADY_TRIGGERED');
          used = true;
          return route.handler(req, res);
        };
        roll = handler;
        return () => { if (roll === handler) roll = undefined; };
      },
    };
    // The one temporary agent is never archived; other Workspace actions stay unavailable.
    const officialWorkspace = ctx.get('workspaceRegistry');
    const workspaceRegistry = { archivedSessionIds: new Set(officialWorkspace?.archivedSessionIds?.has(agent.id) ? [agent.id] : []) };
    const loading = ctx.isolate('webServer').isolate('workspaceRegistry').plugin({
      name: 'memoria-speak-up-adapter',
      async apply(adapterCtx) {
        adapterCtx.provide('webServer', webServer);
        adapterCtx.provide('workspaceRegistry', workspaceRegistry);
        await adapterCtx.extend({ interval: () => { suppressed++; return () => {}; } }).plugin(plugin);
      },
    });
    scope = loading;
    await loading;
    signal?.throwIfAborted();
    if (scope.state !== 2 || suppressed !== 1 || typeof roll !== 'function') throw new Error('DSH_SPEAK_UP_NOT_READY');
    let status, body;
    await roll(Readable.from([JSON.stringify({ 模式: '真发' })]), {
      writeHead(code) { status = code; },
      end(value) {
        if (body !== undefined || typeof value !== 'string' || value.length > 64000) throw new Error('DSH_SPEAK_UP_INVALID_RESULT');
        body = value;
      },
    });
    signal?.throwIfAborted();
    if (!used || status !== 200 || JSON.parse(body)?.ok !== true) throw new Error('DSH_SPEAK_UP_TRIGGER_FAILED');
    return dispose;
  } catch (error) {
    await dispose();
    throw error;
  }
}
