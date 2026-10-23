export function normalizeConversationOrigin(value) {
  if (value === undefined) return undefined;
  const fail = () => { throw new Error('私聊来源格式无效。'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const fields = value.platform === 'qq' ? ['version', 'platform', 'accountId', 'botId', 'userId']
    : value.platform === 'feishu' ? ['version', 'platform', 'accountId', 'inboxKey', 'botId', 'fingerprint', 'conversationId', 'actorId'] : [];
  const identifier = item => typeof item === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,127}$/.test(item);
  const providerId = item => typeof item === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(item);
  const qqId = item => typeof item === 'string' && /^[1-9]\d{0,19}$/.test(item);
  const digest = item => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item);
  if (!fields.length || Reflect.ownKeys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))
    || value.version !== 1 || !identifier(value.accountId)) fail();
  if (value.platform === 'qq' ? !qqId(value.botId) || !qqId(value.userId) || value.botId === value.userId
    : !digest(value.inboxKey) || !digest(value.fingerprint) || ![value.botId, value.conversationId, value.actorId].every(providerId)) fail();
  return Object.fromEntries(fields.map(key => [key, value[key]]));
}
