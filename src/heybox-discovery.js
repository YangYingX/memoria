import { normalizeHeyboxCredentials } from './heybox-credentials.js';
import { heyboxId, normalizeHeyboxComment } from './heybox-thread.js';

const incomplete = () => new Error('本次小黑盒本人帖登记未完成，下次需重新核对当前公开来源。');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function postId(url) {
  const match = typeof url === 'string' && url.match(/^https:\/\/www\.xiaoheihe\.cn\/app\/bbs\/link\/([1-9]\d{0,19})$/);
  if (!match) throw new Error('小黑盒本人帖子列表包含无法核验的规范地址。');
  return heyboxId(match[1]);
}

// Discovery records a current authenticated public read, never a new publication.
export function createHeyboxThreadDiscovery({ store, getCredentials, reader }) {
  const credentials = () => {
    const value = getCredentials();
    return value ? normalizeHeyboxCredentials(value) : null;
  };
  return async ({ signal } = {}) => {
    signal?.throwIfAborted();
    const account = credentials();
    if (!account) return null;
    const snapshot = JSON.stringify(account);
    const check = () => {
      signal?.throwIfAborted();
      if (JSON.stringify(credentials()) !== snapshot) throw new Error('小黑盒专用账号已变化，未登记本次本人帖子。');
    };
    const list = await reader.readOwnPostUrls({ signal });
    check();
    if (!exact(list, ['accountId', 'readAt', 'urls']) || list.accountId !== account.accountId || !timestamp(list.readAt)
      || !Array.isArray(list.urls) || list.urls.length > 30 || new Set(list.urls).size !== list.urls.length) throw new Error('小黑盒本人帖子列表无法核对。');
    const candidates = list.urls.map(url => ({ url, postId: postId(url) }));
    const eligible = item => store.canDiscoverHeyboxThread(account.accountId, item.postId) === true;
    const candidate = candidates.find(eligible);
    if (!candidate) return null;
    const data = await reader.readDiscussion(candidate.url, { signal });
    check();
    if (!exact(data, ['accountId', 'postId', 'url', 'title', 'authorId', 'text', 'comments', 'readAt', 'truncated'])
      || data.accountId !== account.accountId || data.authorId !== account.accountId || data.postId !== candidate.postId || data.url !== candidate.url
      || typeof data.title !== 'string' || !data.title || data.title !== data.title.trim() || data.title.length > 500 || /[\x00-\x1f\x7f]/.test(data.title)
      || typeof data.text !== 'string' || !data.text || data.text !== data.text.trim() || data.text.length > 30000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(data.text)
      || !timestamp(data.readAt) || data.truncated !== true || !Array.isArray(data.comments) || data.comments.length > 20) throw new Error('小黑盒本人公开帖的作者、正文或来源无法核对。');
    const comments = data.comments.map(normalizeHeyboxComment);
    if (new Set(comments.map(item => item.commentId)).size !== comments.length) throw new Error('小黑盒本人帖子评论的真实编号重复。');
    check();
    if (!eligible(candidate)) return null;
    try {
      const event = store.addEvent({ type: 'heybox_post', scope: 'owner', actor: 'scheduler', sourceRef: data.url, content: data.text,
        metadata: { platform: 'heybox', action: 'inspect', outcome: 'success', confirmed: true, confirmation: 'published_view',
          accountId: account.accountId, postId: data.postId, url: data.url, title: data.title, readAt: data.readAt, coverage: 'text_only' } });
      check();
      const memory = store.saveMemory({ title: data.title.slice(0, 200), content: data.text, scope: 'owner', category: 'event', sourceType: 'heybox-post', sourceRef: event.id });
      check();
      const thread = store.registerHeyboxThread({ accountId: account.accountId, postId: data.postId, url: data.url, title: data.title,
        sourceEventId: event.id, sourceMemoryId: memory.id });
      check();
      store.completeHeyboxBaseline(thread.key, { accountId: account.accountId, comments });
      return thread;
    } catch { throw incomplete(); }
  };
}
