import { createHash } from 'node:crypto';

export const BILI_REPLY_STATES = Object.freeze(['received', 'processing', 'sending', 'sent', 'unknown', 'quiet', 'failed', 'invalidated', 'interrupted']);
export const BILI_REPLY_TERMINAL = Object.freeze(['sent', 'unknown', 'quiet', 'failed', 'invalidated', 'interrupted']);
const fields = ['id', 'mid', 'nickname', 'aid', 'bvid', 'title', 'content', 'rpid', 'root', 'at'];

function invalid() {
  const error = new Error('B站通知字段、视频来源或标识无效。');
  error.validation = true;
  throw error;
}

export function biliSocialId(value, zero = false) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) invalid();
    value = String(value);
  }
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,15})$/.test(value) || Number(value) > Number.MAX_SAFE_INTEGER || (!zero && value === '0')) invalid();
  return value;
}

function string(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) invalid();
  return value.trim();
}

export function normalizeNotice(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some(key => ![...fields, 'kind', 'business_id'].includes(key)) || fields.some(key => !Object.hasOwn(value, key))) invalid();
  if ((Object.hasOwn(value, 'kind') && !['reply', 'at'].includes(value.kind)) || (Object.hasOwn(value, 'business_id') && String(value.business_id) !== '1')) invalid();
  let at = value.at;
  if (typeof at === 'number' || (typeof at === 'string' && /^[1-9]\d*$/.test(at))) {
    const seconds = Number(at);
    if (!Number.isSafeInteger(seconds) || seconds <= 0 || !Number.isSafeInteger(seconds * 1000)) invalid();
    try { at = new Date(seconds * 1000).toISOString(); } catch { invalid(); }
  }
  if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at)
    || !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) invalid();
  const bvid = string(value.bvid, 12);
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) invalid();
  return { id: biliSocialId(value.id), mid: biliSocialId(value.mid), nickname: string(value.nickname, 120), aid: biliSocialId(value.aid), bvid,
    title: string(value.title, 300), content: string(value.content, 4000), rpid: biliSocialId(value.rpid), root: biliSocialId(value.root, true), at,
    ...(value.kind === 'at' ? { kind: 'at' } : {}) };
}

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const biliNoticeKey = (accountId, notice) => hash([notice.kind === 'at' ? 'bili-at-notice-v1' : 'bili-notice-v1', biliSocialId(accountId), biliSocialId(notice.id)]);
export const biliCommentKey = (accountId, notice) => hash(['bili-comment-v1', biliSocialId(accountId), biliSocialId(notice.aid), biliSocialId(notice.rpid)]);
export const biliNoticeHash = (accountId, notice) => hash(['bili-notice-content-v1', biliSocialId(accountId), normalizeNotice(notice)]);
export const biliNoticeScope = (accountId, notice) => `group:bilibili:${biliSocialId(accountId)}:${biliSocialId(notice.aid)}:${biliSocialId(notice.root, true) === '0' ? biliSocialId(notice.rpid) : biliSocialId(notice.root)}`;
export const biliNoticeActor = notice => `person:bilibili:${biliSocialId(notice.mid)}`;

// The pinned plugin reads `user`; mentions may supply one author in `users`.
// Ambiguous authors are discarded rather than attributed to an arbitrary account.
export function biliMentionFeed(body) {
  if (!body || !Array.isArray(body.data?.items)) return body;
  return { ...body, data: { ...body.data, items: body.data.items.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    let user = item.user;
    if (Object.hasOwn(item, 'users')) {
      if (!Array.isArray(item.users) || item.users.length !== 1 || !item.users[0] || typeof item.users[0] !== 'object') return [];
      if (user && String(user.mid) !== String(item.users[0].mid)) return [];
      user = item.users[0];
    }
    try { biliSocialId(user?.mid); } catch { return []; }
    return [{ ...item, user }];
  }) } };
}
