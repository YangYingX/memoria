import { parseHTML } from 'linkedom';
import { heyboxId, normalizeHeyboxComment } from './heybox-thread.js';

const API = 'https://api.xiaoheihe.cn';
const HOME = 'https://www.xiaoheihe.cn';
const MAX_BYTES = 4 * 1024 * 1024;
const POST_ID = /^(?:[1-9]\d{0,19}|[a-f0-9]{12})$/;
function failure(code, message) { const error = new Error(message); error.code = code; return error; }

export function heyboxPlainText(value, max = 30000) {
  const invalid = () => failure('HEYBOX_RESPONSE', '小黑盒文字格式无法核验。');
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_BYTES || !Number.isSafeInteger(max) || max < 1 || max > 30000) throw invalid();
  let parts = [value];
  if (/^\s*\[\s*\{/.test(value)) {
    let segments;
    try { segments = JSON.parse(value); } catch { throw invalid(); }
    if (!Array.isArray(segments) || segments.length > 500 || segments.some(item => !item || typeof item !== 'object' || Array.isArray(item) || typeof item.type !== 'string')) throw invalid();
    // Image segments contain local file paths as text; only text segments are prose.
    parts = segments.filter(item => item.type === 'text').map(item => {
      if (typeof item.text !== 'string') throw invalid();
      return item.text;
    });
  }
  const result = parts.map(part => {
    const { document } = parseHTML(`<html><body>${part}</body></html>`);
    for (const node of document.querySelectorAll('script,style,iframe,object,embed,template')) node.remove();
    for (const node of document.querySelectorAll('br')) node.replaceWith('\n');
    for (const node of document.querySelectorAll('p,div,li,blockquote,h1,h2,h3,pre')) node.append('\n');
    return document.body.textContent;
  }).join('\n').replace(/\r\n?/g, '\n').trim();
  if (!result || result.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(result)) throw invalid();
  return result;
}

function platformId(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) throw failure('HEYBOX_RESPONSE', '小黑盒返回的真实编号无效。');
    value = String(value);
  }
  try { return heyboxId(value); } catch { throw failure('HEYBOX_RESPONSE', '小黑盒返回的真实编号无效。'); }
}
function authorId(value) {
  const nested = platformId(value?.user?.userid);
  if (platformId(value?.userid) !== nested) throw failure('HEYBOX_RESPONSE', '小黑盒作者编号不一致。');
  return nested;
}

export function normalizeHeyboxDiscussion(value) {
  const invalid = () => failure('HEYBOX_RESPONSE', '小黑盒没有返回可核验的公开讨论。');
  if (!value || typeof value !== 'object' || typeof value.readAt !== 'string' || !Number.isFinite(Date.parse(value.readAt))
    || new Date(value.readAt).toISOString() !== value.readAt) throw invalid();
  const reference = heyboxPostReference(value.url), link = value.tree?.link, groups = value.tree?.comments;
  const accountId = platformId(value.accountId), postId = platformId(link?.linkid);
  let shareMatches = false;
  try {
    const share = new URL(link.share_url);
    shareMatches = share.origin === API && !share.username && !share.password && share.pathname === '/v3/bbs/app/api/web/share'
      && share.searchParams.getAll('link_id').length === 1 && share.searchParams.get('link_id') === reference.postRef;
  } catch { /* Numeric canonical URLs do not need a short-code alias. */ }
  if (value.postRef !== reference.postRef || (reference.postRef !== postId && !shareMatches)
    || link.is_only_me_view !== false || link.view_limit !== 1 || !Array.isArray(groups) || groups.length > 100
    || typeof link.title !== 'string' || !link.title.trim() || link.title.length > 500 || /[\x00-\x1f\x7f]/.test(link.title)) throw invalid();
  const comments = new Map();
  let count = 0;
  for (const group of groups) {
    if (!Array.isArray(group?.comment) || !group.comment.length || group.comment.length > 200) throw invalid();
    const root = group.comment[0], rootId = platformId(root.commentid);
    if (root.replyid !== undefined) throw invalid();
    for (let index = 0; index < group.comment.length; index++) {
      if (++count > 200) throw invalid();
      const item = group.comment[index];
      let comment;
      try {
        if (typeof item.user?.username !== 'string' || /[\x00-\x1f\x7f]/.test(item.user.username)) throw invalid();
        comment = normalizeHeyboxComment({ commentId: platformId(item.commentid), authorId: authorId(item),
          author: item.user.username, text: heyboxPlainText(item.text, 1200), rootId,
          parentId: index === 0 ? '0' : platformId(item.replyid) });
      } catch { throw invalid(); }
      const previous = comments.get(comment.commentId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(comment)) throw invalid();
      comments.set(comment.commentId, comment);
    }
  }
  return { accountId, postId, url: `${HOME}/app/bbs/link/${postId}`, title: link.title.trim(), authorId: authorId(link),
    text: heyboxPlainText(link.text), comments: [...comments.values()].slice(0, 20), readAt: value.readAt, truncated: true };
}

export function heyboxPostReference(value) {
  let url;
  try { url = new URL(value); } catch { throw failure('HEYBOX_URL', '请提供有效的小黑盒公开帖子地址。'); }
  const match = url.pathname.match(/^\/app\/bbs\/link\/([^/]+)$/);
  if (url.origin !== HOME || url.username || url.password || url.search || url.hash || !match || !POST_ID.test(match[1])) {
    throw failure('HEYBOX_URL', '仅支持小黑盒已核对的公开帖子地址。');
  }
  return { postRef: match[1], url: url.href };
}

