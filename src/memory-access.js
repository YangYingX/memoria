import { queryTokens } from './store.js';

export function allowedScopes(scope) {
  return [scope, 'public'];
}

export function withConversationSource(store, memory, scope) {
  const source = store.getMemorySource(memory.id, allowedScopes(scope));
  const parts = store.getReadingParts(memory.id, allowedScopes(scope));
  return { ...memory, ...(source ? { conversationSource: { actor: source.actor, recordedAt: source.createdAt,
    ...(source.qqBatchCount ? { qqBatchCount: source.qqBatchCount } : {}) } } : {}),
    ...(parts?.length ? { readingParts: parts } : {}) };
}

export function memoryPage(memory, offset, size) {
  const end = Math.min(offset + size, memory.content.length);
  return { ...memory, content: memory.content.slice(offset, end), offset,
    totalLength: memory.content.length, nextOffset: end < memory.content.length ? end : null };
}

export function memoryExcerpt(memory, query) {
  const tokens = queryTokens(query);
  let bestOffset = 0, bestScore = -1;
  for (let offset = 0; offset < memory.content.length; offset += 900) {
    const fragment = memory.content.slice(offset, offset + 1800).normalize('NFKC').toLowerCase();
    const before = memory.content.slice(Math.max(0, offset - 1), offset).normalize('NFKC').toLowerCase();
    const after = memory.content.slice(offset + 1800, offset + 1801).normalize('NFKC').toLowerCase();
    const words = new Set([...(before + fragment + after).matchAll(/[a-z0-9_]+/g)]
      .filter(match => match.index >= before.length && match.index + match[0].length <= before.length + fragment.length)
      .map(match => match[0]));
    const score = tokens.reduce((sum, token) => sum + Number(/^[a-z0-9_]+$/.test(token) ? words.has(token) : fragment.includes(token)), 0);
    if (score > bestScore) { bestScore = score; bestOffset = offset; }
  }
  return memoryPage(memory, bestOffset, 1800);
}

// The caller supplies verified Memoria identity. A DSH session or tool argument cannot widen it.
export function createMemoryAccess({ store, scope, actor, excludeMessageId = '' }) {
  if (typeof scope !== 'string' || !/^(owner|public|(?:group|person):[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,127})$/.test(scope)
    || typeof actor !== 'string' || !actor.trim() || actor.length > 160 || (scope === 'owner' && actor !== 'owner')) {
    throw new Error('记忆访问需要已验证的场合与发言者。');
  }
  const scopes = allowedScopes(scope);
  if (typeof excludeMessageId !== 'string' || (excludeMessageId && !/^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,127}$/.test(excludeMessageId))) throw new Error('当前消息标识无效。');
  return Object.freeze({
    execute(name, args) {
      const definitions = { search_memory: ['query', 'offset'], read_memory: ['id', 'offset'], read_memory_source: ['id', 'offset'],
        search_conversations: ['query', 'offset'], read_conversation: ['id', 'offset'] };
      const fields = typeof name === 'string' && Object.hasOwn(definitions, name) ? definitions[name] : null;
      if (!fields || !args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !fields.includes(key))) {
        throw new Error('记忆工具或参数无效，不能更改身份、范围或会话。');
      }
      if (name === 'search_memory' || name === 'search_conversations') {
        if (typeof args.query !== 'string' || args.query.length > 500) throw new Error('查询无效。');
        if (name === 'search_conversations') return store.searchConversationPage(args.query, scopes, 6, args.offset === undefined ? 0 : args.offset, excludeMessageId);
        const page = store.searchMemoryPage(args.query, scopes, 6, args.offset === undefined ? 0 : args.offset);
        return { ...page, items: page.items.map(memory => withConversationSource(store, memoryExcerpt(memory, args.query), scope)) };
      }
      if (typeof args.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,127}$/.test(args.id)) throw new Error('记忆 ID 无效。');
      const offset = args.offset === undefined ? 0 : args.offset;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('记忆正文位置无效。');
      if (name === 'read_conversation') {
        const turn = store.getConversation(args.id, scopes, excludeMessageId);
        if (!turn) throw new Error('对话不存在、未完成或当前场合不可检索。');
        const userHeader = `用户原话（${turn.createdAt}，发言者 ${turn.actor}${turn.qqBatchCount ? `，${turn.qqBatchCount}条QQ消息合并` : ''}）：\n`;
        const assistantHeader = turn.assistantHidden ? '\n\n助手历史回复因引用了已更正或忘记的来源而不提供。\n'
          : `\n\n助手历史回复（${turn.replyAt}，可能有误，不代表用户事实）：\n`;
        const content = userHeader + turn.user + assistantHeader + turn.assistant;
        if (offset >= content.length) throw new Error('对话正文位置超出范围。');
        return memoryPage({ id: turn.id, scope: turn.scope, actor: turn.actor, createdAt: turn.createdAt, replyAt: turn.replyAt, assistantHidden: turn.assistantHidden, content,
          ...(turn.qqBatchCount ? { qqBatchCount: turn.qqBatchCount, qqBatchNotice: turn.qqBatchNotice } : {}),
          sections: [{ role: 'user', startOffset: userHeader.length, endOffset: userHeader.length + turn.user.length },
            { role: 'assistant', startOffset: userHeader.length + turn.user.length + assistantHeader.length, endOffset: content.length }] }, offset, 4000);
      }
      if (name === 'read_memory') {
        const memory = store.getMemory(args.id);
        if (!memory || memory.deletedAt || !scopes.includes(memory.scope)) throw new Error('记忆不存在或当前场合不可用。');
        if (offset >= memory.content.length) throw new Error('记忆正文位置超出范围。');
        return withConversationSource(store, memoryPage(memory, offset, 4000), scope);
      }
      const source = store.getMemorySource(args.id, scopes);
      if (!source) throw new Error('对话来源不存在或当前场合不可用。');
      if (offset >= source.content.length) throw new Error('对话原话位置超出范围。');
      const end = Math.min(offset + 4000, source.content.length);
      return { memoryId: args.id, eventId: source.eventId, actor: source.actor, recordedAt: source.createdAt,
        ...(source.qqBatchCount ? { qqBatchCount: source.qqBatchCount, qqBatchNotice: source.qqBatchNotice } : {}),
        content: source.content.slice(offset, end), offset, totalLength: source.content.length,
        nextOffset: end < source.content.length ? end : null };
    },
  });
}
