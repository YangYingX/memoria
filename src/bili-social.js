// Platform notices stay in Memoria; the optional plugin runtime only reads and submits actions.
export function createBiliSocialDiscussion({ store, runtime, getCredentials }) {
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
    const scopes = [record.scope, 'public'];
    const history = store.listConversationHistory(record.scope, 6).filter(item => item.id !== record.messageId);
    const memoryVersions = new Map();
    const memories = store.searchMemories(record.notice.content, scopes, 6).flatMap(memory => {
      const evidence = store.getMemoryVersionEvidence(memory.id, scopes);
      if (!evidence || JSON.stringify(evidence.memory) !== JSON.stringify(memory)) return [];
      memoryVersions.set(memory.id, evidence.signature);
      return [memory];
    });
    const assistantMetadata = { mode: 'live', platform: 'bilibili', replyTo: record.messageId, sourceNoticeKey: record.key,
      userMessageIds: [record.messageId, ...history.filter(item => item.role === 'user').map(item => item.id)],
      memoryIds: memories.map(item => item.id), memoryVersions: [...memoryVersions].map(([memoryId, signature]) => ({ memoryId, signature })),
      historyMessageIds: history.filter(item => item.role === 'assistant').map(item => item.id) };
    if (JSON.stringify({ ...assistantMetadata, replyId: '9'.repeat(16) }).length > 16000) throw new Error('B站回复来源索引超过保存大小上限。');
    const snapshot = JSON.stringify({ record, history, memories });
    const url = `https://www.bilibili.com/video/${record.notice.bvid}/`;
    function sourcesCurrent() {
      try {
        const current = store.getBiliNotice(record.key);
        if (!current || ![...memoryVersions].every(([id, signature]) => store.getMemoryVersionEvidence(id, scopes)?.signature === signature)) return false;
        // Only our own delivery state may change while the request is in flight.
        const original = { ...current, state: record.state, updatedAt: record.updatedAt };
        delete original.replyId;
        return JSON.stringify(getCredentials()) === credentialSnapshot
          && JSON.stringify({ record: original,
            history: store.listConversationHistory(record.scope, 6).filter(item => item.id !== record.messageId),
            memories: memories.map(memory => store.getMemory(memory.id)) }) === snapshot;
      } catch { return false; }
    }
    return {
      record,
      current() {
        try {
          return !signal?.aborted && store.getBiliNotice(record.key)?.state === 'processing' && sourcesCurrent();
        } catch { return false; }
      },
      context: { url, title: record.notice.title, comment: { key: record.key, author: record.notice.nickname, text: record.notice.content, at: record.notice.at },
        recentMessages: history.map(({ role, actor, content }) => ({ role, actor: actor === 'agent' ? '自己' : '评论区发言者', text: content.slice(0, 800) })),
        memories: memories.map(({ title, content }) => ({ title, text: content.slice(0, 1800) })),
        note: '这是当前公开评论线程及公开书架的有限资料；未提供创建人私聊或其他群聊。只回应这条评论，不表示读过完整视频。' },
      finish(state, { replyId, text } = {}) {
        const saved = store.finishBiliReply(record.key, state, replyId ? { replyId } : {});
        if (state !== 'sent' || !text) return true;
        if (saved?.state !== 'sent' || signal?.aborted || !sourcesCurrent()) return false;
        try {
          store.addMessage({ scope: record.scope, role: 'assistant', actor: 'agent', content: text,
            metadata: { ...assistantMetadata, replyId } });
          store.saveMemory({ title: `评论区交流：${record.notice.title || record.notice.content.slice(0, 40)}`.slice(0, 200), scope: record.scope, category: 'event',
            content: `【B站公开评论；已回复并取得平台编号，不代表已通过所有审核】\n对方写道：${record.notice.content}\n来源：${url}`,
            sourceType: 'conversation', sourceRef: record.sourceEventId });
          return true;
        } catch { return false; }
      },
    };
  };
}
