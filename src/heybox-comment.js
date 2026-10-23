import { createHash } from 'node:crypto';

const prefix = 'com.max.xiaoheihe:id/';
const pages = ['PicturePostPageActivityV2', 'WebNewsPostPageActivityV2'].map(name => `com.max.xiaoheihe/.module.bbs.post.ui.activitys.v2.${name}`);
const box = value => typeof value === 'string' ? value.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/)?.slice(1).map(Number) : null;
const contains = (outer, inner) => outer && inner && outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
export const commentKey = (author, text) => createHash('sha256').update(JSON.stringify([author, text])).digest('hex');

export function validateHeyboxComment(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['url', 'title', 'text', 'replyTo'].includes(key))) throw new Error('评论参数无效。');
  let url;
  try { url = new URL(input.url); } catch { throw new Error('评论来源地址无效。'); }
  if (url.origin !== 'https://www.xiaoheihe.cn' || !/^\/app\/bbs\/link\/\d{1,20}$/.test(url.pathname)
    || url.username || url.password || url.search || url.hash) throw new Error('评论仅支持已核对的小黑盒公开帖子。');
  const clean = (value, limit) => {
    if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\x00-\x08\x0b-\x1f\x7f]/.test(value)) throw new Error('评论文字或目标长度无效。');
    return value.trim();
  };
  const title = clean(input.title, 500), text = clean(input.text, 200);
  let replyTo = null;
  if (input.replyTo != null) {
    const target = input.replyTo;
    if (typeof target !== 'object' || Array.isArray(target) || Object.keys(target).some(key => !['key', 'author', 'text'].includes(key))) throw new Error('回复目标无效。');
    replyTo = { key: target.key, author: clean(target.author, 200), text: clean(target.text, 1200) };
    if (replyTo.key !== commentKey(replyTo.author, replyTo.text)) throw new Error('回复标识与已读取的作者、正文不一致。');
  }
  return { url: url.href, title, text, replyTo };
}

export function verifyHeyboxComment(view, input, nickname) {
  const comment = validateHeyboxComment(input);
  if (typeof nickname !== 'string' || !nickname.trim()) return false;
  const comments = parseHeyboxComments(view);
  if (!comment.replyTo) return comments.filter(item => item.author === nickname && item.text === comment.text).length === 1;
  const parent = comments.find(item => item.key === comment.replyTo.key);
  if (!parent) return false;
  const rows = view.nodes.filter(node => node.id === prefix + 'vg_comments_detail' && contains(box(node.bounds), box(parent.bounds)));
  if (rows.length !== 1) return false;
  const expected = `${nickname}: ${comment.text}`;
  const replies = view.nodes.filter(node => node.id === prefix + 'tv_sub_comment_content' && !node.truncated && contains(box(rows[0].bounds), box(node.bounds)));
  return replies.filter(node => node.text.startsWith(expected) && /^ (?:刚刚|\d+秒前|\d+分钟前)(?:·[^\r\n]{1,30})?\uFEFF?$/.test(node.text.slice(expected.length))).length === 1;
}

export function parseHeyboxComments(view) {
  if (!pages.includes(view?.activity) || !Array.isArray(view.nodes)
    || view.nodes.filter(node => node.id === prefix + 'tv_all_comment').length !== 1) throw new Error('尚未核对到小黑盒评论列表。');
  const rows = view.nodes.filter(node => node.id === prefix + 'vg_main_comment');
  const comments = rows.flatMap(row => {
    const bounds = box(row.bounds);
    const fields = id => view.nodes.filter(node => node.id === prefix + id && contains(bounds, box(node.bounds)));
    const authors = fields('bbs_name'), bodies = fields('tv_comment');
    if (authors.length !== 1 || bodies.length !== 1 || !authors[0].text?.trim() || !bodies[0].text?.trim()
      || authors[0].truncated || bodies[0].truncated || authors[0].text.length > 200 || bodies[0].text.length > 1200
      || [authors[0].text, bodies[0].text].some(value => value.includes('[手机号已隐藏]') || /[\x00-\x08\x0b-\x1f\x7f]/.test(value))) return [];
    const author = authors[0].text.trim(), text = bodies[0].text.trim();
    return [{ key: commentKey(author, text), author, text, bounds: bodies[0].bounds }];
  });
  return comments.filter(comment => comments.filter(other => other.key === comment.key).length === 1).slice(0, 6);
}
