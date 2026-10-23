import { normalizeQQMergeWindow } from './qq-chat-batch.js';
import { normalizeQQChatLimit } from './qq-chat-budget.js';
import { normalizeQQGroupAttentionSettings } from './qq-group-attention.js';

class QQContextCanceled extends Error {
  constructor() { super('QQ 对话身份或配置已变化，本次处理已取消。'); }
}

export function isQQContextCanceled(error) { return error instanceof QQContextCanceled; }

export function qqConfigSignature(config) {
  return JSON.stringify({ enabled: config.enabled, botId: config.botId, apiBaseUrl: config.apiBaseUrl,
    accessToken: config.accessToken, webhookSecret: config.webhookSecret,
    allowedUsers: config.allowedUsers, allowedGroups: config.allowedGroups,
    dailyChatLimit: normalizeQQChatLimit(config.dailyChatLimit), mergeWindowMs: normalizeQQMergeWindow(config.mergeWindowMs),
    ...normalizeQQGroupAttentionSettings(config) });
}

function route(store, config, userId, groupId) {
  if (!config.enabled || !config.botId || userId === config.botId) return null;
  const account = store.findAccount('qq', userId);
  if (groupId ? !config.allowedGroups.includes(groupId) : !account && !config.allowedUsers.includes(userId)) return null;
  const scope = groupId ? `group:${groupId}` : account?.personId === 'owner' ? 'owner' : `person:qq:${userId}`;
  return { scope, actor: account?.personId === 'owner' ? 'owner' : `qq:${userId}`,
    target: groupId ? { group_id: groupId } : { user_id: userId },
    origin: `qq:${groupId ? 'group' : 'private'}:${groupId || userId}`, account };
}

export function captureQQContext({ store, config, userId, groupId = '', getEpoch }) {
  const selected = route(store, config, userId, groupId);
  if (!selected) return null;
  const epoch = getEpoch();
  const signature = () => JSON.stringify({ qq: qqConfigSignature(store.getSetting('qq')),
    model: store.getSetting('model'), persona: store.getSetting('persona'),
    account: store.findAccount('qq', userId),
    ownerAccounts: selected.scope === 'owner' ? store.listAccounts().filter(account => account.personId === 'owner') : undefined });
  const expected = signature();
  if (qqConfigSignature(store.getSetting('qq')) !== qqConfigSignature(config)) return null;
  return { ...selected, config, epoch,
    conversation: `qq:${config.botId}:${groupId ? `group:${groupId}` : `private:${userId}`}`,
    mergeKey: `${userId}:${epoch}`,
    assertActive() {
      if (getEpoch() !== epoch) throw new QQContextCanceled();
      const current = store.getSetting('qq');
      if (!current.enabled || current.botId !== config.botId || signature() !== expected) throw new QQContextCanceled();
      const live = route(store, current, userId, groupId);
      if (!live || live.scope !== selected.scope || live.actor !== selected.actor || live.origin !== selected.origin) throw new QQContextCanceled();
    },
  };
}
