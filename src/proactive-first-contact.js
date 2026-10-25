const type = 'proactive_qq_authorization';
const id = value => typeof value === 'string' && /^[1-9]\d{4,19}$/.test(value);
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const snapshot = store => {
  const config = store.getSetting('qq', {});
  const accounts = store.listAccounts().filter(account => account.platform === 'qq' && account.personId === 'owner');
  if (!config.enabled || !id(config.botId) || accounts.length !== 1) return null;
  const account = accounts[0];
  if (!id(account.userId) || account.userId === config.botId || !instant(account.updatedAt)) return null;
  return { schemaVersion: 1, accountId: account.id, userId: account.userId, botId: config.botId,
    bindingUpdatedAt: account.updatedAt };
};

// Only trusted creator configuration code may issue this authorization.
// It never creates a user message or repairs a missing historical conversation origin.
export function authorizeInitialQQContact(store) {
  if (store.getSetting('proactive', {}).enabled !== true) return null;
  const target = snapshot(store);
  if (!target) return null;
  const ownerCursor = store.latestOwnerMessage()?.id ?? null;
  const event = store.addEvent({ type, scope: 'owner', actor: 'owner', sourceRef: target.accountId,
    content: '已允许向当前绑定的创建人QQ进行一次初始主动问候。', metadata: { ...target, ownerCursor } });
  const grant = { ...target, eventId: event.id, createdAt: event.createdAt, ownerCursor };
  store.setSetting('proactiveInitialQQ', grant);
  return { authorizationId: event.id };
}

export function initialQQContact(store, { authorizationId, now = Date.now() } = {}) {
  try {
    if (!Number.isSafeInteger(now) || store.getSetting('proactive', {}).enabled !== true) return null;
    const grant = store.getSetting('proactiveInitialQQ', null), target = snapshot(store);
    if (!grant || !target || Array.isArray(grant) || Object.keys(grant).length !== 8
      || !instant(grant.createdAt) || Date.parse(grant.createdAt) > now || now - Date.parse(grant.createdAt) > 7 * 86400000
      || authorizationId !== undefined && grant.eventId !== authorizationId) return null;
    const { eventId, createdAt, ownerCursor, ...savedTarget } = grant;
    if ((store.latestOwnerMessage()?.id ?? null) !== ownerCursor || Date.parse(target.bindingUpdatedAt) > now) return null;
    if (JSON.stringify(savedTarget) !== JSON.stringify(target)) return null;
    const event = store.listEvents({ type, scope: 'owner', actor: 'owner', limit: 100 }).find(item => item.id === eventId);
    if (!event || event.createdAt !== createdAt || event.sourceRef !== target.accountId
      || JSON.stringify(event.metadata) !== JSON.stringify({ ...target, ownerCursor })) return null;
    return { authorizationId: eventId, recipient: { platform: 'qq', accountId: target.accountId,
      userId: target.userId, botId: target.botId, bindingUpdatedAt: target.bindingUpdatedAt } };
  } catch { return null; }
}
