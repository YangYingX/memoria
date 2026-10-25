import { normalizeHeyboxCredentials } from './heybox-credentials.js';
import { normalizeHeyboxComment, heyboxCommentKey, heyboxId } from './heybox-thread.js';
import { createMemoryAccess, memoryPage, withConversationSource, companionShelfMemories } from './memory-access.js';

// Only a registered, verified own post can become an autonomous reply opportunity.
export function createHeyboxSocialDiscussion({ store, getCredentials, readDiscussion, onReplyDelivered = () => {} }) {
  let recovered = false;
  const credentials = () => {
    const value = getCredentials();
    return value ? normalizeHeyboxCredentials(value) : null;
  };
  return async ({ signal } = {}) => {
    signal?.throwIfAborted();
    if (!recovered) { store.recoverHeyboxReplies(); recovered = true; }
    const account = credentials();
    if (!account) return null;
    const credentialSnapshot = JSON.stringify(account);
    const threads = store.listHeyboxThreads(account.accountId);
    if (!threads.length) return null;
    const cursor = store.getSetting('heyboxSocialCursor', ''), index = threads.findIndex(item => item.key === cursor);
    const thread = threads[(index + 1) % threads.length], threadSnapshot = JSON.stringify(thread);
    store.setSetting('heyboxSocialCursor', thread.key);
    const data = await readDiscussion(thread.url, { signal });
    signal?.throwIfAborted();
    const threadCurrent = () => JSON.stringify(credentials()) === credentialSnapshot
      && JSON.stringify(store.getHeyboxThread(thread.key)) === threadSnapshot;
    if (!threadCurrent()) return null;
    const fields = ['accountId', 'postId', 'url', 'title', 'authorId', 'text', 'comments', 'readAt', 'truncated'];
    if (!data || typeof data !== 'object' || Array.isArray(data) || ![Object.prototype, null].includes(Object.getPrototypeOf(data))
      || Object.keys(data).length !== fields.length || Object.keys(data).some(key => !fields.includes(key))
      || data.accountId !== thread.accountId || data.postId !== thread.postId || data.url !== thread.url || data.title !== thread.title
      || data.authorId !== thread.accountId || typeof data.text !== 'string' || !data.text.trim() || data.text.length > 30000 || data.text.includes('\0') || data.text !== thread.postText
      || data.truncated !== true || typeof data.readAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(data.readAt)
      || !Number.isFinite(Date.parse(data.readAt)) || new Date(data.readAt).toISOString() !== data.readAt
      || !Array.isArray(data.comments) || data.comments.length > 20) throw new Error('小黑盒讨论账号、本人帖子或评论数据无法核对。');
    const comments = data.comments.map(normalizeHeyboxComment), visible = new Set(comments.map(comment => heyboxCommentKey(thread, comment)));
    if (visible.size !== comments.length) throw new Error('小黑盒评论真实标识重复，未采用本次数据。');
    if (store.completeHeyboxBaseline(thread.key, { accountId: account.accountId, comments }).initialized) return null;
    for (const comment of comments) store.receiveHeyboxComment({ threadKey: thread.key, comment });
    const candidate = store.listHeyboxComments(account.accountId).find(item => item.threadKey === thread.key && visible.has(item.key));
    if (!candidate) return null;
    const record = store.beginHeyboxReply(candidate.key, { accountId: account.accountId });
    if (!record) return null;
    try {
      const scopes = [record.scope, 'public'];
      const history = store.getHeyboxReplyContext(record.key);
      if (!history) throw new Error('小黑盒同话题来源已失效。');
      const binding = () => store.findAccount('heybox', record.comment.authorId);
      const creatorBinding = binding();
      const evidence = [history.root, history.parent, ...history.recent].filter(Boolean);
      const conversationIds = new Set(evidence.filter(item => item.kind === 'peer').map(item => item.message.id));
      const userMessageIds = new Set([record.messageId, ...conversationIds]);
      const historyMessageIds = new Set(evidence.filter(item => item.kind === 'self').map(item => item.message.id));
      const memoryVersions = new Map(), ownExpressionVersions = new Map(), conversations = new Map();
      let invalidated = false;
      function invalidSource() {
        invalidated = true;
        throw new Error('小黑盒回复引用的资料已变化或超过保存上限，本次未继续。');
      }
      function references() {
        const result = { memoryIds: [...memoryVersions.keys()], conversationIds: [...conversationIds], historyMessageIds: [...historyMessageIds],
          userMessageIds: [...userMessageIds], memoryVersions: [...memoryVersions].map(([memoryId, signature]) => ({ memoryId, signature })),
          ownExpressionVersions: [...ownExpressionVersions].map(([expressionId, signature]) => ({ expressionId, signature })) };
        if (2 * memoryVersions.size + conversationIds.size + historyMessageIds.size + userMessageIds.size + ownExpressionVersions.size > 100
          || JSON.stringify(result).length > 14000) invalidSource();
        return result;
      }
      const readingEvidence = memory => memory.scope === 'public' && ['webpage', 'reflection'].includes(memory.sourceType)
        ? store.getCompanionMemoryEvidence(memory.id) : undefined;
      const memoryCurrent = memory => {
        if (readingEvidence(memory) === null) return false;
        if (memory.sourceType !== 'conversation') return true;
        try { return !store.isConversationSourceBlocked(memory.scope, memory.sourceRef); }
        catch { return false; }
      };
      function trackConversation(id) {
        const turn = store.getConversation(id, scopes, record.messageId), snapshot = turn && JSON.stringify(turn);
        if (!turn || conversations.has(id) && conversations.get(id) !== snapshot) invalidSource();
        conversations.set(id, snapshot);
        (turn.assistantHidden ? userMessageIds : conversationIds).add(id);
        references();
      }
      function trackOwnExpression(id, expected) {
        const proof = store.getOwnExpressionEvidence(id);
        if (!proof || expected && expected !== proof.signature || ownExpressionVersions.has(id) && ownExpressionVersions.get(id) !== proof.signature) invalidSource();
        ownExpressionVersions.set(id, proof.signature);
        references();
      }
      function trackMemory(id, expected, optional = false) {
        const source = store.getMemoryVersionEvidence(id, scopes), memory = source?.memory;
        if (!memory || expected && JSON.stringify(memory) !== JSON.stringify(expected) || !memoryCurrent(memory)) {
          if (optional) return null;
          invalidSource();
        }
        const entries = new Map([[memory.id, memory]]), queue = [readingEvidence(memory)];
        for (const part of queue) if (part) {
          if (part.memory?.id) entries.set(part.memory.id, part.memory);
          queue.push(...(part.parts || []));
          if (entries.size > 100) { if (optional) return null; invalidSource(); }
        }
        const projected = new Set([...memoryVersions.keys(), ...entries.keys()]).size;
        if (2 * projected + conversationIds.size + historyMessageIds.size + userMessageIds.size + ownExpressionVersions.size > 100) {
          if (optional) return null;
          invalidSource();
        }
        const versions = [];
        for (const entry of entries.values()) {
          const version = store.getMemoryVersionEvidence(entry.id, scopes);
          if (!version || !memoryCurrent(version.memory) || JSON.stringify(version.memory) !== JSON.stringify(entry)
            || memoryVersions.has(entry.id) && memoryVersions.get(entry.id) !== version.signature) invalidSource();
          versions.push(version);
        }
        for (const version of versions) memoryVersions.set(version.memory.id, version.signature);
        const selfView = memory.category === 'self-view' ? store.getSelfViewMemoryEvidence(memory.id, scopes) : null;
        if (selfView) trackConversation(selfView.conversationId);
        references();
        return memory;
      }
      function trackMemoryResult(result) {
        trackMemory(result.id || result.memoryId);
        for (const part of result.readingParts || []) trackMemory(part.id);
      }
      const memoryAccess = createMemoryAccess({ store, scope: record.scope, actor: record.actor, excludeMessageId: record.messageId });
      const emotionContext = memoryAccess.currentEmotionContext();
      for (const id of emotionContext.memoryIds) trackMemory(id);
      for (const id of emotionContext.conversationIds) trackConversation(id);
      const selfIndex = memoryAccess.selfConversationIndex(record.comment.text, [...userMessageIds, ...historyMessageIds]);
      for (const item of selfIndex.items) trackConversation(item.id);
      const ownIndex = memoryAccess.ownExpressionIndex(record.comment.text);
      for (const version of ownIndex.versions) trackOwnExpression(version.id, version.signature);
      const memories = [];
      for (const item of store.searchMemories(record.comment.text, scopes, 6)) {
        const selected = trackMemory(item.id, item, true);
        if (selected) memories.push(selected);
      }
      for (const item of companionShelfMemories(store, record.scope, record.actor, memories.map(memory => memory.id))) {
        const selected = trackMemory(item.id, item, true);
        if (selected) memories.push(selected);
      }
      const memoryContext = memories.map(memory => {
        const page = withConversationSource(store, memoryPage(memory, 0, 1800), record.scope);
        trackMemoryResult(page);
        return page;
      });
      references();
      const snapshot = JSON.stringify({ record, history, binding: creatorBinding });
      function sourcesCurrent() {
        try {
          const current = store.getHeyboxComment(record.key);
          if (invalidated || !current || !threadCurrent() || !emotionContext.sourcesCurrent() || !selfIndex.sourcesCurrent()
            || ![...memoryVersions].every(([id, signature]) => {
              const proof = store.getMemoryVersionEvidence(id, scopes);
              return proof?.signature === signature && memoryCurrent(proof.memory);
            }) || ![...ownExpressionVersions].every(([id, signature]) => store.getOwnExpressionEvidence(id)?.signature === signature)
            || ![...conversations].every(([id, value]) => JSON.stringify(store.getConversation(id, scopes, record.messageId)) === value)) return false;
          const original = { ...current, state: record.state, updatedAt: record.updatedAt };
          for (const key of ['confirmation', 'replyId', 'replyHash', 'replyDependenciesHash']) delete original[key];
          return JSON.stringify({ record: original, history: store.getHeyboxReplyContext(record.key), binding: binding() }) === snapshot;
        } catch { return false; }
      }
      const current = () => {
          try { return !signal?.aborted && store.getHeyboxComment(record.key)?.state === 'processing' && sourcesCurrent(); }
          catch { return false; }
      };
      const memory = Object.freeze({
        current,
        execute(name, args) {
          if (!current()) invalidSource();
          const fields = { search_own_expressions: ['query', 'offset', 'start_date', 'end_date'], read_own_expression: ['id', 'offset'],
            search_emotions: ['query', 'offset', 'start_date', 'end_date'], search_memory: ['query', 'offset'], read_memory: ['id', 'offset'],
            read_memory_source: ['id', 'offset'], search_conversations: ['query', 'offset', 'role', 'speaker'], read_conversation: ['id', 'offset'] };
          if (typeof name !== 'string' || !Object.hasOwn(fields, name) || !args || typeof args !== 'object' || Array.isArray(args)
            || Object.keys(args).some(key => !fields[name].includes(key))) throw new Error('小黑盒记忆工具或参数无效，不能更改范围或回复目标。');
          const result = memoryAccess.execute(name, args);
          if (name === 'search_own_expressions' || name === 'read_own_expression') {
            for (const item of name === 'search_own_expressions' ? result.items : [result]) trackOwnExpression(item.id);
          } else if (name === 'search_conversations' || name === 'read_conversation') {
            for (const item of name === 'search_conversations' ? result.items : [result]) trackConversation(item.id);
          } else if (name === 'search_memory' || name === 'search_emotions') {
            for (const item of result.items) trackMemoryResult(item);
          } else trackMemoryResult(result);
          references();
          if (!current()) invalidSource();
          return structuredClone(result);
        },
      });
      let notifiedReplyId;
      return {
        record: structuredClone(record), memory, current,
        context: { url: thread.url, title: thread.title, postText: thread.postText,
          comment: { key: record.key, speaker: record.actor, author: record.comment.author, text: record.comment.text, isCreator: creatorBinding?.personId === 'owner' },
          root: history.root ? { status: 'available', ...excerpt(history.root, 1200) } : { status: 'missing' },
          parent: record.comment.parentId === '0' ? { status: 'none' }
            : history.parent ? { status: 'available', ...excerpt(history.parent, 1200) } : { status: 'missing' },
          recentMessages: history.recent.map(item => ({ role: item.message.role, ...excerpt(item) })),
          memories: memoryContext,
          ...(selfIndex.items.length ? { selfConversationIndex: selfIndex.items } : {}),
          ...(ownIndex.items.length ? { ownExpressionIndex: ownIndex.items } : {}),
          ...(emotionContext.items.length ? { currentEmotionContext: emotionContext.items } : {}),
          note: '这是已核验在专用账号下的既有公开帖子及其中一条真实评论；账号归属不证明帖子由本系统创作或发布，不凭帖正文补编亲身经历。只提供本帖和公开书架资料，未提供创建人私聊或其他群聊。不表示读过全部评论。可以保持安静。' },
        finish(state, options = {}) {
          if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['text', 'confirmation', 'replyId'].includes(key))) throw new Error('小黑盒回复结果参数无效。');
          if (state === 'sent' && (options.confirmation !== 'reply_receipt' || typeof options.replyId !== 'string' || heyboxId(options.replyId) !== options.replyId)) throw new Error('小黑盒回复尚未取得真实平台编号。');
          const permitted = state === 'sent' && !signal?.aborted && sourcesCurrent();
          const saved = store.finishHeyboxReply(record.key, state, { ...options, sourceEventId: record.sourceEventId, sourceHash: record.sourceHash,
            ...(state === 'sent' ? { ...references(), archive: permitted } : {}) });
          if (saved?.state === 'sent' && saved.archived === true && typeof saved.assistantMessageId === 'string' && notifiedReplyId !== saved.assistantMessageId) {
            notifiedReplyId = saved.assistantMessageId;
            try { onReplyDelivered(record.scope, saved.assistantMessageId); } catch { /* Sampling must not discard a confirmed reply. */ }
          }
          return saved;
        },
      };
    } catch (error) {
      store.finishHeyboxReply(record.key, 'failed', { sourceEventId: record.sourceEventId, sourceHash: record.sourceHash });
      throw error;
    }
  };
}

function excerpt(item, limit = 800) {
  return { speaker: item.actor, author: item.kind === 'self' ? '自己' : item.source.metadata.heyboxComment.comment.author,
    text: item.message.content.slice(0, limit), truncated: item.message.content.length > limit };
}
