import { createHash } from 'node:crypto';

export const HEYBOX_REPLY_STATES = Object.freeze(['received', 'processing', 'sending', 'sent', 'unknown', 'quiet', 'failed', 'invalidated', 'interrupted']);
export const HEYBOX_REPLY_TERMINAL = Object.freeze(['sent', 'unknown', 'quiet', 'failed', 'invalidated', 'interrupted']);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = () => { const error = new Error('小黑盒线程、评论来源或真实标识无效。'); error.validation = true; throw error; };
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) fail();
  return value;
}
function string(value, max) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail();
  return value;
}
export function heyboxId(value, zero = false) {
  if (typeof value !== 'string' || !(zero ? /^(?:0|[1-9]\d{0,19})$/ : /^[1-9]\d{0,19}$/).test(value)) fail();
  return value;
}
export function heyboxKey(value) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(); return value; }
export function heyboxReference(value) { if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,127}$/.test(value)) fail(); return value; }
export function normalizeHeyboxThread(value) {
  object(value, ['accountId', 'postId', 'url', 'title', 'sourceEventId', 'sourceMemoryId']);
  const accountId = heyboxId(value.accountId), postId = heyboxId(value.postId);
  if (value.url !== `https://www.xiaoheihe.cn/app/bbs/link/${postId}`) fail();
  return { accountId, postId, url: value.url, title: string(value.title, 500), sourceEventId: heyboxReference(value.sourceEventId), sourceMemoryId: heyboxReference(value.sourceMemoryId) };
}
export function normalizeHeyboxComment(value) {
  object(value, ['commentId', 'authorId', 'author', 'text', 'rootId', 'parentId']);
  const commentId = heyboxId(value.commentId), authorId = heyboxId(value.authorId), rootId = heyboxId(value.rootId), parentId = heyboxId(value.parentId, true);
  if (parentId === '0' ? rootId !== commentId : parentId === commentId || rootId === commentId) fail();
  return { commentId, authorId, author: string(value.author, 200), text: string(value.text, 1200), rootId, parentId };
}
export const heyboxThreadIdentityKey = (accountId, postId) => hash(['heybox-thread-v1', heyboxId(accountId), heyboxId(postId)]);
export const heyboxThreadKey = value => { const thread = normalizeHeyboxThread(value); return heyboxThreadIdentityKey(thread.accountId, thread.postId); };
export const heyboxThreadHash = value => hash(['heybox-thread-content-v1', normalizeHeyboxThread(value)]);
export const heyboxThreadScope = value => `group:heybox:${heyboxId(value.accountId)}:${heyboxId(value.postId)}`;
export const heyboxCommentKey = (thread, comment) => hash(['heybox-comment-v1', heyboxId(thread.accountId), heyboxId(thread.postId), heyboxId(comment.commentId)]);
export const heyboxCommentHash = (thread, comment) => hash(['heybox-comment-content-v1', heyboxId(thread.accountId), heyboxId(thread.postId), normalizeHeyboxComment(comment)]);
export const heyboxCommentActor = value => `heybox:${heyboxId(value.authorId)}`;
export function normalizeHeyboxConfirmation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  if (value.confirmation === 'reply_view' && value.replyId === undefined && Object.keys(value).length === 1) return { confirmation: 'reply_view' };
  if (value.confirmation === 'reply_receipt' && Object.keys(value).length === 2) return { confirmation: 'reply_receipt', replyId: heyboxId(value.replyId) };
  fail();
}
