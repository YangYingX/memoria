import { biliNoticeUrl } from './bili-social-notice.js';
import { createMemoryAccess, memoryPage, withConversationSource, companionShelfMemories } from './memory-access.js';

// Platform notices stay in Memoria; the optional plugin runtime only reads and submits actions.
export function createBiliSocialDiscussion({ store, runtime, getCredentials, onReplyDelivered = () => {} }) {
  let recovered = false;
  return async ({ signal }) => {
    signal?.throwIfAborted();
    if (!recovered) { store.recoverBiliReplies(); recovered = true; }
    const credentials = getCredentials();
    if (!credentials) return null;
    const credentialSnapshot = JSON.stringify(credentials);
    const inbox = await runtime.inbox({ signal });
    signal?.throwIfAborted();
    if (inbox.accountId !== credentials.accountId || !Array.isArray(inbox.notices) || inbox.notices.length > 20) throw new Error('B站通知账号或返回格式无法核对。');
    for (const notice of inbox.notices) store.receiveBiliNotice({ accountId: credentials.accountId, notice });
    const candidate = store.listBiliNotices(credentials.accountId, { limit: 1 })[0];
    if (!candidate) return null;
    const record = store.beginBiliReply(candidate.key);
    if (!record) return null;
    try {
      const scopes = [record.scope, 'public'];
      const history = store.listConversationHistory(record.scope, 6).filter(item => item.id !== record.messageId);
      const memoryVersions = new Map(), conversations = new Map(), ownExpressionVersions = new Map();
      const conversationIds = new Set(), userMessageIds = new Set([record.messageId, ...history.filter(item => item.role === 'user').map(item => item.id)]);
      const historyMessageIds = new Set(history.filter(item => item.role === 'assistant').map(item => item.id));
      let invalidated = false;
      function invalidSource() {
        invalidated = true;
        throw new Error('B站回复引用的资料已变化或超过保存上限，本次未继续。');
      }
      function assistantMetadata() {
        const result = { mode: 'live', platform: 'bilibili', replyTo: record.messageId, sourceNoticeKey: record.key,
          userMessageIds: [...userMessageIds], memoryIds: [...memoryVersions.keys()], conversationIds: [...conversationIds],
          ...(ownExpressionVersions.size ? { ownExpressionVersions: [...ownExpressionVersions].map(([expressionId,signature])=>({expressionId,signature})) } : {}),
          memoryVersions: [...memoryVersions].map(([memoryId, signature]) => ({ memoryId, signature })), historyMessageIds: [...historyMessageIds] };
        if (userMessageIds.size + memoryVersions.size + conversationIds.size + historyMessageIds.size + ownExpressionVersions.size > 100
          || JSON.stringify({ ...result, replyId: '9'.repeat(20) }).length > 16000) invalidSource();
        return result;
      }
      function trackOwnExpression(id) {
        const evidence=store.getOwnExpressionEvidence(id);
        if (!evidence || ownExpressionVersions.has(id) && ownExpressionVersions.get(id)!==evidence.signature) invalidSource();
        ownExpressionVersions.set(id,evidence.signature);
      }
      function trackMemory(id, expected) {
        const evidence = store.getMemoryVersionEvidence(id, scopes);
        if (!evidence || (expected && JSON.stringify(evidence.memory) !== JSON.stringify(expected))
          || (memoryVersions.has(id) && memoryVersions.get(id) !== evidence.signature)) invalidSource();
        memoryVersions.set(id, evidence.signature);
        return evidence.memory;
      }
      function trackMemoryResult(result) {
        trackMemory(result.id || result.memoryId);
        for (const part of result.readingParts || []) trackMemory(part.id);
      }
      function trackConversation(item) {
        const turn = store.getConversation(item.id, scopes, record.messageId);
        const snapshot = turn && JSON.stringify(turn);
        if (!turn || (conversations.has(item.id) && conversations.get(item.id) !== snapshot)) invalidSource();
        conversations.set(item.id, snapshot);
        (turn.assistantHidden === true ? userMessageIds : conversationIds).add(item.id);
      }
      const memoryAccess = createMemoryAccess({ store, scope: record.scope, actor: record.actor, excludeMessageId: record.messageId });
      const emotionContext = memoryAccess.currentEmotionContext();
      for (const id of emotionContext.memoryIds) trackMemory(id);
      for (const id of emotionContext.conversationIds) trackConversation({ id });
      const selfIndex = memoryAccess.selfConversationIndex(record.notice.content, history.flatMap(item => [item.id, ...(typeof item.metadata?.replyTo === 'string' ? [item.metadata.replyTo] : [])]));
      for (const item of selfIndex.items) trackConversation(item);
      const memories = store.searchMemories(record.notice.content, scopes, 6).flatMap(memory => {
        const evidence = store.getMemoryVersionEvidence(memory.id, scopes);
        if (!evidence || JSON.stringify(evidence.memory) !== JSON.stringify(memory)) return [];
        trackMemory(memory.id, memory);
        return [memory];
      });
      for (const memory of companionShelfMemories(store, record.scope, record.actor, memories.map(item => item.id))) {
        trackMemory(memory.id, memory); memories.push(memory);
      }
      const memoryContext = memories.map(memory => {
        const page = withConversationSource(store, memoryPage(memory, 0, 1800), record.scope);
        trackMemoryResult(page);
        return page;
      });
      assistantMetadata();
      const snapshot = JSON.stringify({ record, history, memories });
      const url = biliNoticeUrl(record.notice) + (record.notice.resource === 'dynamic' ? '' : '/');
      function sourcesCurrent() {
        try {
          const current = store.getBiliNotice(record.key);
          if (invalidated || ![...ownExpressionVersions].every(([id,signature])=>store.getOwnExpressionEvidence(id)?.signature===signature) || !emotionContext.sourcesCurrent() || !selfIndex.sourcesCurrent() || !current || ![...memoryVersions].every(([id, signature]) => store.getMemoryVersionEvidence(id, scopes)?.signature === signature)
            || ![...conversations].every(([id, snapshot]) => JSON.stringify(store.getConversation(id, scopes, record.messageId)) === snapshot)) return false;
          // Only our own delivery state may change while the request is in flight.
          const original = { ...current, state: record.state, updatedAt: record.updatedAt };
          delete original.replyId;
          return JSON.stringify(getCredentials()) === credentialSnapshot
            && JSON.stringify({ record: original,
              history: store.listConversationHistory(record.scope, 6).filter(item => item.id !== record.messageId),
              memories: memories.map(memory => store.getMemory(memory.id)) }) === snapshot;
        } catch { return false; }
      }
      const current = () => {
        try { return !signal?.aborted && store.getBiliNotice(record.key)?.state === 'processing' && sourcesCurrent(); }
        catch { return false; }
      };
      const memory = Object.freeze({
        current,
        execute(name, args) {
          if (!current()) invalidSource();
          const fields = { search_own_expressions: ['query','offset','start_date','end_date'], read_own_expression: ['id','offset'], search_emotions: ['query', 'offset', 'start_date', 'end_date'], search_memory: ['query', 'offset'], read_memory: ['id', 'offset'], read_memory_source: ['id', 'offset'],
            search_conversations: ['query', 'offset', 'role', 'speaker'], read_conversation: ['id', 'offset'] };
          if (typeof name !== 'string' || !Object.hasOwn(fields, name) || !args || typeof args !== 'object' || Array.isArray(args)
            || Object.keys(args).some(key => !fields[name].includes(key))) throw new Error('B站记忆工具或参数无效，不能更改范围或回复目标。');
          const result = memoryAccess.execute(name, args);
          if (name === 'search_own_expressions' || name === 'read_own_expression') {
            for (const item of name === 'search_own_expressions' ? result.items : [result]) trackOwnExpression(item.id);
          } else if (name === 'search_conversations' || name === 'read_conversation') {
            for (const item of name === 'search_conversations' ? result.items : [result]) trackConversation(item);
          } else if (name === 'search_memory' || name === 'search_emotions') {
            for (const item of result.items) trackMemoryResult(item);
          } else trackMemoryResult(result);
          assistantMetadata();
          if (!current()) invalidSource();
          return JSON.parse(JSON.stringify(result));
        },
      });
      return {
        record,
        memory,
        current: () => memory.current(),
        context: { url, title: record.notice.title, comment: { key: record.key, author: record.notice.nickname, speaker: record.actor, text: record.notice.content, at: record.notice.at },
          recentMessages: history.map(({ role, actor, content }) => ({ role, actor: actor === 'agent' ? '自己' : '评论区发言者', speaker: actor,
            isCurrentSpeaker: role === 'user' && actor === record.actor, text: content.slice(0, 800) })),
          ...(selfIndex.items.length ? { selfConversationIndex: selfIndex.items } : {}),
          ...(emotionContext.items.length ? { currentEmotionContext: emotionContext.items } : {}),
          memories: memoryContext,
          note: '这是当前公开评论线程及公开书架的有限资料；未提供创建人私聊或其他群聊。只回应这条评论。' + (record.notice.resource === 'dynamic' ? '本轮通知未提供动态全文或图片；可按当前权限核对已保存公开资料，不补齐未知内容。' : '不表示读过完整视频。') },
        finish(state, { replyId, text } = {}) {
          const saved = store.finishBiliReply(record.key, state, replyId ? { replyId } : {});
          if (state !== 'sent' || !text) return true;
          if (saved?.state !== 'sent' || signal?.aborted || !sourcesCurrent()) return false;
          try {
            const assistant = store.addMessage({ scope: record.scope, role: 'assistant', actor: 'agent', content: text,
              metadata: { ...assistantMetadata(), replyId } });
            try { onReplyDelivered(record.scope, assistant.id); } catch { /* Sampling must not discard a confirmed reply. */ }
            store.saveMemory({ title: `评论区交流：${record.notice.title || record.notice.content.slice(0, 40)}`.slice(0, 200), scope: record.scope, category: 'event',
              content: `【B站公开评论；已回复并取得平台编号，不代表已通过所有审核】\n对方写道：${record.notice.content}\n来源：${url}`,
              sourceType: 'conversation', sourceRef: record.sourceEventId });
            return true;
          } catch { return false; }
        },
      };
    } catch {
      try { store.finishBiliReply(record.key, signal?.aborted ? 'interrupted' : 'failed'); } catch {}
      throw new Error('B站评论记忆初始化未完成，本次不自动重试。');
    }
  };
}
