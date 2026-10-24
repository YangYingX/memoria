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
  if (value?.resource === 'dynamic') return normalizeDynamicNotice(value);
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
export const biliNoticeKey = (accountId, notice) => hash([notice.kind === 'at' ? 'bili-at-notice-v1' : 'bili-notice-v1', biliSocialId(accountId), (notice.resource === 'dynamic' ? biliDynamicId(notice.id) : biliSocialId(notice.id)), ...(notice.resource === 'dynamic' ? ['dynamic'] : [])]);
export const biliCommentKey = (accountId, notice) => notice.resource === 'dynamic'
  ? hash(['bili-dynamic-comment-v1', biliSocialId(accountId), notice.commentType, biliDynamicId(notice.oid), biliDynamicId(notice.rpid)])
  : hash(['bili-comment-v1', biliSocialId(accountId), biliSocialId(notice.aid), biliSocialId(notice.rpid)]);
export const biliNoticeHash = (accountId, notice) => hash(['bili-notice-content-v1', biliSocialId(accountId), normalizeNotice(notice)]);
export const biliNoticeScope = (accountId, notice) => notice.resource === 'dynamic'
  ? `group:bilibili:${biliSocialId(accountId)}:dynamic:${notice.commentType}:${biliDynamicId(notice.oid)}:${biliDynamicId(notice.root, true) === '0' ? biliDynamicId(notice.rpid) : biliDynamicId(notice.root)}`
  : `group:bilibili:${biliSocialId(accountId)}:${biliSocialId(notice.aid)}:${biliSocialId(notice.root, true) === '0' ? biliSocialId(notice.rpid) : biliSocialId(notice.root)}`;
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

export function biliDynamicId(value, zero = false) {
  if (typeof value === 'number') { if (!Number.isSafeInteger(value)) invalid(); value = String(value); }
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,19})$/.test(value) || (!zero && value === '0')) invalid();
  return value;
}

function normalizeDynamicNotice(value) {
  const required = ['id', 'mid', 'nickname', 'title', 'content', 'rpid', 'root', 'at', 'resource', 'dynamicId', 'oid', 'commentType'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...required, 'kind'].includes(key))
    || value.resource !== 'dynamic' || ![11, 17].includes(value.commentType) || (value.kind !== undefined && !['reply', 'at'].includes(value.kind))) invalid();
  const dynamicId = biliDynamicId(value.dynamicId), oid = biliDynamicId(value.oid);
  if (value.commentType === 17 && dynamicId !== oid) invalid();
  let at = value.at;
  if (typeof at === 'number' || typeof at === 'string' && /^[1-9]\d*$/.test(at)) {
    const seconds = Number(at); if (!Number.isSafeInteger(seconds) || seconds <= 0 || !Number.isSafeInteger(seconds * 1000)) invalid();
    try { at = new Date(seconds * 1000).toISOString(); } catch { invalid(); }
  }
  if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at)
    || !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) invalid();
  return { id: biliDynamicId(value.id), mid: biliSocialId(value.mid), nickname: string(value.nickname, 120),
    title: string(value.title, 300), content: string(value.content, 4000), rpid: biliDynamicId(value.rpid), root: biliDynamicId(value.root, true), at,
    resource: 'dynamic', dynamicId, oid, commentType: value.commentType, ...(value.kind === 'at' ? { kind: 'at' } : {}) };
}

export const biliNoticeUrl = notice => notice.resource === 'dynamic' ? 'https://t.bilibili.com/' + biliDynamicId(notice.dynamicId)
  : 'https://www.bilibili.com/video/' + notice.bvid;

export function parseBiliJson(text) {
  return JSON.parse(text, (key, value, context) => {
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      if (!context || typeof context.source !== 'string' || !/^-?\d+$/.test(context.source)) invalid();
      return context.source;
    }
    return value;
  });
}

export function biliDynamicFeed(kind, body) {
  if (!['reply', 'at'].includes(kind) || body?.code !== 0 || !Array.isArray(body.data?.items)) return [];
  const feed = kind === 'at' ? biliMentionFeed(body) : body;
  return feed.data.items.slice(0, 100).flatMap(item => {
    try {
      const source = item?.item, type = Number(source?.business_id);
      if (![11, 17].includes(type)) return [];
      const oid = biliDynamicId(source.subject_id); let dynamicId;
      if (source.uri) {
        const url = new URL(source.uri.startsWith('//') ? 'https:' + source.uri : source.uri);
        if (url.username || url.password || url.protocol !== 'https:') return [];
        const match = url.hostname === 't.bilibili.com' ? url.pathname.match(/^\/([1-9]\d{0,19})\/?$/)
          : url.hostname === 'www.bilibili.com' ? url.pathname.match(/^\/opus\/([1-9]\d{0,19})\/?$/) : null;
        if (!match) return []; dynamicId = match[1];
      } else if (type === 17) dynamicId = oid;
      else return [];
      return [normalizeDynamicNotice({ id: item.id, mid: item.user?.mid, nickname: item.user?.nickname,
        title: source.title?.trim() || '动态讨论', content: source.source_content, rpid: source.source_id, root: source.root_id || '0',
        at: item.reply_time || item.at_time, resource: 'dynamic', dynamicId, oid, commentType: type, kind })];
    } catch { return []; }
  });
}
