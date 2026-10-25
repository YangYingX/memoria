function id(value, message = false) {
  if (typeof value !== 'string' && !Number.isSafeInteger(value)) return null;
  const result = String(value);
  return (message ? /^(?:0|-?[1-9]\d{0,19})$/ : /^[1-9]\d{0,19}$/).test(result) ? result : null;
}

export function normalizeQQDisplayName(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 80 || !value.isWellFormed()
    || /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(value)) throw new Error('QQ 显示称呼无效。');
  return value;
}

function qqDisplayName(event) {
  const userId = id(event.user_id);
  if (event.post_type !== 'message' || !userId || id(event.sender?.user_id) !== userId
    || !['private', 'group'].includes(event.message_type)
    || (event.message_type === 'group' ? !id(event.group_id) : event.group_id !== undefined)) return undefined;
  const names = event.message_type === 'group' ? [event.sender.card, event.sender.nickname] : [event.sender.nickname];
  for (const value of names) {
    if (typeof value !== 'string') continue;
    let name = value.trim().slice(0, 80);
    if (/[\uD800-\uDBFF]/.test(name.at(-1))) name = name.slice(0, -1);
    name = name.trim();
    try { if (name) return normalizeQQDisplayName(name); } catch { /* Invalid labels cannot replace the account identity. */ }
  }
  return undefined;
}

export function parseQQMessage(event) {
  const segments = Array.isArray(event.message) ? event.message : [];
  const message = segments.length
    ? segments.filter(segment => segment?.type === 'text' && typeof segment.data?.text === 'string').map(segment => segment.data.text).join('').trim()
    : String(event.raw_message || '').replace(/\[CQ:[^\]]*\]/g, '').trim();
  const mentions = [...new Set(segments.filter(segment => segment?.type === 'at').map(segment => segment.data?.qq === 'all' ? 'all' : id(segment.data?.qq)).filter(Boolean))].slice(0, 20);
  const replies = segments.filter(segment => segment?.type === 'reply');
  const replyId = replies.length === 1 ? id(replies[0].data?.id, true) : null;
  const displayName = qqDisplayName(event);
  return { message, imageUrls: segments.filter(segment => segment?.type === 'image').map(segment => segment.data?.url),
    ...(displayName ? { displayName } : {}),
    ...(mentions.length ? { mentions } : {}), ...(replyId !== null ? { replyId } : replies.length ? { replyUnavailable: true } : {}) };
}

// IDs come only from structured protocol segments; raw CQ-looking text is never a lookup request.
export function verifiedQQReply(value, { replyId, botId, userId, groupId = '', actorFor }) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || id(value.message_id, true) !== replyId
    || (value.self_id !== undefined && id(value.self_id) !== botId) || typeof actorFor !== 'function') throw new Error('QQ 引用无法核对。');
  const sender = id(value.sender?.user_id);
  if (!sender || (value.user_id !== undefined && id(value.user_id) !== sender)) throw new Error('QQ 引用发言者无法核对。');
  if (groupId) {
    if (value.message_type !== 'group' || id(value.group_id) !== groupId) throw new Error('QQ 引用不属于当前群聊。');
  } else if (value.message_type !== 'private' || value.group_id !== undefined || sender !== userId) {
    // Standard get_msg has no recipient field. A bot-authored private message cannot prove its peer.
    throw new Error('QQ 引用不属于当前私聊。');
  }
  const parsed = parseQQMessage({ message: value.message, raw_message: typeof value.message === 'string' ? value.message : value.raw_message });
  let text = parsed.message.slice(0, 1200);
  if (text.length < parsed.message.length && /[\uD800-\uDBFF]/.test(text.at(-1))) text = text.slice(0, -1);
  if (text.includes('\0')) throw new Error('QQ 引用正文无效。');
  return { status: 'verified', actor: actorFor(sender), text, truncated: text.length < parsed.message.length || parsed.imageUrls.length > 10, imageCount: Math.min(10, parsed.imageUrls.length) };
}

export function normalizeQQReplyContext(value, text) {
  if (value === undefined) return undefined;
  const fail = () => { throw new Error('QQ 引用与点名上下文无效。'); };
  const object = item => item && typeof item === 'object' && !Array.isArray(item)
    && [Object.prototype, null].includes(Object.getPrototypeOf(item));
  const actor = item => typeof item === 'string' && /^(?:owner|agent|all|qq:[1-9]\d{0,19})$/.test(item);
  if (typeof text !== 'string' || !Array.isArray(value) || value.length < 1 || value.length > 3) fail();
  let previous = -1;
  return value.map(part => {
    if (!object(part) || Object.keys(part).some(key => !['startOffset', 'endOffset', 'mentions', 'reply'].includes(key))
      || !Number.isSafeInteger(part.startOffset) || !Number.isSafeInteger(part.endOffset) || part.startOffset < 0
      || part.startOffset <= previous || part.endOffset < part.startOffset || part.endOffset > text.length
      || !Array.isArray(part.mentions) || part.mentions.length > 20 || !part.mentions.every(actor)
      || new Set(part.mentions).size !== part.mentions.length) fail();
    previous = part.endOffset;
    const result = { startOffset: part.startOffset, endOffset: part.endOffset, mentions: [...part.mentions] };
    if (part.reply !== undefined) {
      const reply = part.reply;
      if (!object(reply)) fail();
      if (reply.status === 'unavailable' && Object.keys(reply).length === 1) result.reply = { status: 'unavailable' };
      else {
        if (Object.keys(reply).length !== 5 || Object.keys(reply).some(key => !['status', 'actor', 'text', 'truncated', 'imageCount'].includes(key))
          || reply.status !== 'verified' || !actor(reply.actor) || reply.actor === 'all' || typeof reply.text !== 'string'
          || reply.text.length > 1200 || reply.text.includes('\0') || typeof reply.truncated !== 'boolean'
          || !Number.isSafeInteger(reply.imageCount) || reply.imageCount < 0 || reply.imageCount > 10) fail();
        result.reply = { status: 'verified', actor: reply.actor, text: reply.text, truncated: reply.truncated, imageCount: reply.imageCount };
      }
    }
    return result;
  });
}
