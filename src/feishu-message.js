import { createHash } from 'node:crypto';

export const defaultFeishuSettings = { enabled: false, botId: '', expectedFingerprint: '', allowedUsers: [], allowedGroups: [], dailyChatLimit: 200 };

function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new Error('飞书文本资料格式无效。');
  }
  return value;
}

function text(value, max, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error('飞书文本资料长度或格式无效。');
  }
  return value;
}

function id(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value)) throw new Error('飞书账号或消息标识无效。');
  return value;
}

function fingerprint(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('飞书账号指纹无效。');
  return value;
}

const hash = parts => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

export function normalizeFeishuSettings(input = defaultFeishuSettings) {
  object(input, Object.keys(defaultFeishuSettings));
  const settings = { ...defaultFeishuSettings, ...input };
  if (typeof settings.enabled !== 'boolean' || !Number.isSafeInteger(settings.dailyChatLimit)
    || settings.dailyChatLimit < 0 || settings.dailyChatLimit > 1000) throw new Error('飞书每日聊天上限须为 0–1000 的整数，开关须为布尔值。');
  for (const key of ['allowedUsers', 'allowedGroups']) {
    if (!Array.isArray(settings[key]) || settings[key].length > 50) throw new Error('飞书白名单最多包含 50 个标识。');
    settings[key] = [...new Set(settings[key].map(id))];
  }
  if (settings.botId !== '') id(settings.botId);
  if (settings.expectedFingerprint !== '') fingerprint(settings.expectedFingerprint);
  if (settings.enabled && (!settings.botId || !settings.expectedFingerprint)) throw new Error('启用飞书前须核对机器人和账号指纹。');
  return settings;
}

export function normalizeFeishuEvent(input, settings) {
  object(input, ['version', 'channel', 'botId', 'fingerprint', 'eventId', 'messageId', 'actor', 'conversation', 'mentions', 'mentionedAccount', 'at', 'text', 'reply', 'replay']);
  if (input.version !== 1 || input.channel !== 'feishu' || input.botId !== settings.botId
    || input.fingerprint !== settings.expectedFingerprint) throw new Error('飞书消息不属于当前机器人账号。');
  id(input.botId); fingerprint(input.fingerprint); id(input.eventId); id(input.messageId);
  object(input.actor, ['kind', 'id', 'name']);
  if (input.actor.kind !== 'user') throw new Error('仅处理飞书用户的文本消息。');
  const actor = { kind: 'user', id: id(input.actor.id) };
  if (input.actor.name !== undefined) actor.name = text(input.actor.name, 200, true);
  object(input.conversation, ['kind', 'id']);
  if (!['dm', 'group'].includes(input.conversation.kind)) throw new Error('此飞书会话类型尚未接入。');
  const conversation = { kind: input.conversation.kind, id: id(input.conversation.id) };
  if (!Array.isArray(input.mentions) || input.mentions.length > 100 || typeof input.mentionedAccount !== 'boolean') throw new Error('飞书提及资料无效。');
  const mentions = input.mentions.map(item => {
    object(item, ['id', 'key', 'name']);
    const result = { id: id(item.id) };
    if (item.key !== undefined) result.key = text(item.key, 128, true);
    if (item.name !== undefined) result.name = text(item.name, 200, true);
    return result;
  });
  if (typeof input.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.at)
    || !Number.isFinite(Date.parse(input.at)) || new Date(input.at).toISOString() !== input.at) throw new Error('飞书消息时间无效。');
  object(input.reply, ['messageId', 'conversationId', 'actorId', 'threadId', 'rootId', 'parentId']);
  if (input.reply.messageId !== input.messageId || input.reply.conversationId !== conversation.id || input.reply.actorId !== actor.id) {
    throw new Error('飞书回复位置与原消息不一致。');
  }
  const reply = { messageId: input.messageId, conversationId: conversation.id, actorId: actor.id };
  for (const key of ['threadId', 'rootId', 'parentId']) if (input.reply[key] !== undefined) reply[key] = id(input.reply[key]);
  object(input.replay, ['kind', 'resumeCursor', 'gapPossible']);
  if (input.replay.kind !== 'provider-redelivery' || input.replay.resumeCursor !== false || input.replay.gapPossible !== true) throw new Error('飞书重投资料无效。');
  // Delivery metadata can change on provider redelivery; identity, text and the original reply route cannot.
  const event = { version: 1, channel: 'feishu', botId: input.botId, fingerprint: input.fingerprint, messageId: input.messageId,
    actor, conversation, mentions, mentionedAccount: input.mentionedAccount, at: input.at, text: text(input.text, 8000), reply };
  if (Buffer.byteLength(JSON.stringify(event), 'utf8') > 32768) throw new Error('飞书单条消息资料不能超过 32 KiB。');
  return event;
}

export function feishuConversation(event, { store, allowedUsers, allowedGroups }) {
  const digest = hash(['feishu-sender-v1', event.fingerprint, event.actor.id]);
  const accountId = `im1:${digest}`;
  const account = store.findAccount('feishu', accountId);
  let scope, actor = `feishu:${digest}`;
  if (event.conversation.kind === 'group') {
    if (!allowedGroups.includes(event.conversation.id) || !event.mentionedAccount) return null;
    scope = `group:feishu:${hash(['feishu-group-v1', event.fingerprint, event.conversation.id])}`;
  } else {
    if (!account && !allowedUsers.includes(event.actor.id)) return null;
    if (account?.personId === 'owner') { scope = 'owner'; actor = 'owner'; }
    else scope = `person:feishu:${digest}`;
  }
  return { key: hash(['feishu-message-v1', event.fingerprint, event.messageId]), accountId, scope, actor };
}
