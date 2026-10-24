import { createMemoryAgentAccess } from './dsh-memory-agent-access.js';

// The same parent-authorized, read-only agent can run without a plugin host.
export async function composeProactive({ store, messageId, agendaId, memoryId, impulse, signal, assertActive, request }) {
  const check = () => { signal?.throwIfAborted(); assertActive?.(); };
  check();
  const access = createMemoryAgentAccess({ store, scope: 'owner', actor: 'owner', purpose: 'proactive',
    messageId, agendaId, memoryId, impulse, signal, ...(request ? { request } : {}) });
  for (let round = 0; round < 4; round++) {
    check();
    const { message } = await access.complete();
    check();
    for (const call of message.tool_calls || []) {
      check();
      access.execute({ callId: call.id, name: call.function.name.slice('memoria_'.length), args: JSON.parse(call.function.arguments) });
      check();
    }
    const result = access.finalResult();
    if (result) {
      const sourcesCurrent = () => {
        try { check(); return result.sourcesCurrent() === true; }
        catch { return false; }
      };
      check();
      return { ...result, sourcesCurrent };
    }
  }
  throw new Error('主动拟聊未在允许的模型请求次数内完成。');
}
