import { moodSnapshot } from './mood.js';

export const proactiveQuery = '根据父程序核验的近期创建人对话，必要时只读核对旧兴趣和约定，决定现在是否有自然的话题可主动说一句。只返回严格 JSON {"text":"拟说的话，或空字符串表示安静"}。';

export function createDshProactiveContext({ store, messageId, now = Date.now() }) {
  if (typeof messageId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,127}$/.test(messageId)) throw new Error('主动拟聊需要有效的创建人消息。');
  const seed = () => store.listConversationHistory('owner', 100).findLast(item => item.role === 'user' && item.actor === 'owner');
  const originalSeed = seed();
  const fresh = (item, time) => item?.id === messageId && item.scope === 'owner' && Number.isFinite(Date.parse(item.createdAt))
    && Date.parse(item.createdAt) <= time && time - Date.parse(item.createdAt) <= 7 * 86400000;
  if (!fresh(originalSeed, now)) throw new Error('主动拟聊只使用最近七天内仍可见的创建人最新消息。');
  const history = store.listConversationHistory('owner', 6);
  const persona = store.getSetting('persona', {}), moodState = store.getSetting('moodState', null);
  const initial = JSON.stringify({ seed: originalSeed, history, persona, moodState });
  const conversationIds = new Set([messageId, ...history.filter(item => item.role === 'user').map(item => item.id)]);
  const historyMessageIds = history.filter(item => item.role === 'assistant').map(item => item.id);
  const validReference = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,127}$/.test(value);
  for (const item of history.filter(item => item.role === 'assistant')) if (validReference(item.metadata.replyTo)) conversationIds.add(item.metadata.replyTo);
  const memories = new Map(), conversations = new Map();
  const forbiddenIds = new Set([messageId, ...history.map(item => item.id), ...conversationIds]);
  let invalidated = false;
  const memory = id => ({ memory: store.getMemory(id), source: store.getMemorySource(id, ['owner', 'public']), parts: store.getReadingParts(id, ['owner', 'public']) });
  const conversation = id => store.getConversation(id, ['owner', 'public']);
  function remember(map, id, value) {
    const encoded = JSON.stringify(value);
    if (map.has(id) && map.get(id) !== encoded) invalidated = true;
    else map.set(id, encoded);
    forbiddenIds.add(id);
    for (const reference of [value?.source?.eventId, value?.memory?.sourceRef, ...(value?.parts || []).map(part => part.id)]) {
      if (validReference(reference)) forbiddenIds.add(reference);
    }
  }
  function sourcesCurrent() {
    try {
      const currentSeed = seed();
      return !invalidated && fresh(currentSeed, Date.now())
        && JSON.stringify({ seed: currentSeed, history: store.listConversationHistory('owner', 6), persona: store.getSetting('persona', {}), moodState: store.getSetting('moodState', null) }) === initial
        && [...memories].every(([id, value]) => JSON.stringify(memory(id)) === value)
        && [...conversations].every(([id, value]) => JSON.stringify(conversation(id)) === value);
    } catch { return false; }
  }
  return {
    query: proactiveQuery,
    input: { now: new Date(now).toISOString(), mood: moodSnapshot(store, now),
      seed: { recordedAt: originalSeed.createdAt, text: originalSeed.content.slice(0, 3000) },
      recentMessages: history.map(({ role, actor, content, createdAt }) => ({ role, actor, recordedAt: createdAt, text: content.slice(0, 600) })) },
    conversationIds: [...conversationIds], historyMessageIds,
    track(name, args, result) {
      if (result.error) return;
      if (name === 'search_memory') for (const item of result.items) remember(memories, item.id, memory(item.id));
      else if (name === 'search_conversations') for (const item of result.items) remember(conversations, item.id, conversation(item.id));
      else if (name === 'read_conversation') remember(conversations, args.id, conversation(args.id));
      else remember(memories, args.id, memory(args.id));
      if (!sourcesCurrent()) throw new Error('主动拟聊的资料已变化。');
    },
    validateText(text) {
      let value;
      try { value = JSON.parse(text); } catch { throw new Error('主动拟聊须返回严格 JSON。'); }
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'text')
        || typeof value.text !== 'string' || value.text.length > 600 || value.text.includes('\0') || /https?:\/\/|www\./i.test(value.text)
        || [...forbiddenIds].some(id => id.length >= 12 && value.text.includes(id))) throw new Error('主动拟聊正文格式无效。');
    },
    sourcesCurrent,
  };
}
