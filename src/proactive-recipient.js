import { initialQQContact, qqCompanionship } from './proactive-first-contact.js';

// Delivery destinations come from paired application records, never from model output.
export function createProactiveRecipientResolver({ store, getFeishuStatus }) {
  return function getRecipient({ messageId, sourceEventId, allowLegacyQQ = false, legacyAccountId, initialAuthorizationId, companionAuthorizationId } = {}) {
    let origin;
    try {
      if (companionAuthorizationId !== undefined) {
        if (messageId !== undefined || sourceEventId !== undefined || initialAuthorizationId !== undefined
          || allowLegacyQQ !== false || legacyAccountId !== undefined) return null;
        return qqCompanionship(store, { authorizationId: companionAuthorizationId })?.recipient || null;
      }
      if (initialAuthorizationId !== undefined) return initialQQContact(store, { authorizationId: initialAuthorizationId })?.recipient || null;
      if (sourceEventId) origin = store.getConversationOriginByEvent(sourceEventId);
      else origin = store.getConversationOrigin(messageId || store.latestOwnerMessage()?.id);
      if (origin === null) return null;
      if (origin === undefined && !allowLegacyQQ) return null;
      if (origin === undefined || origin.platform === 'qq') {
        const config = store.getSetting('qq', {});
        if (!config.enabled || !/^[1-9]\d{4,19}$/.test(config.botId || '')) return null;
        if (origin && origin.botId !== config.botId) return null;
        const account = store.listAccounts().find(item => item.platform === 'qq' && item.personId === 'owner'
          && /^[1-9]\d{4,19}$/.test(item.userId) && item.userId !== config.botId && (!origin || item.userId === origin.userId)
          && (origin || !legacyAccountId || item.id === legacyAccountId));
        return account ? { platform: 'qq', accountId: account.id, userId: account.userId, botId: config.botId,
          bindingUpdatedAt: account.updatedAt } : null;
      }
      if (origin.platform !== 'feishu') return null;
      const config = store.getSetting('feishu', {}), connection = getFeishuStatus();
      const account = store.listAccounts().find(item => item.id === origin.accountId && item.platform === 'feishu' && item.personId === 'owner');
      if (!account || !config.enabled || config.botId !== origin.botId || config.expectedFingerprint !== origin.fingerprint
        || !connection.connected || connection.proactiveReady !== true || !connection.epoch
        || connection.botId !== origin.botId || connection.fingerprint !== origin.fingerprint) return null;
      return { platform: 'feishu', accountId: account.id, botId: origin.botId, fingerprint: origin.fingerprint,
        conversationId: origin.conversationId, actorId: origin.actorId, sourceInboxKey: origin.inboxKey,
        epoch: connection.epoch, bindingUpdatedAt: account.updatedAt };
    } catch { return null; }
  };
}
