import { queryTokens } from './store.js';
import { biliReadingPage } from './bili-reading.js';

export async function browseBiliVideos({ store, runtime, reader, interests, failedUrls = [], signal, background = false, onYield, random = Math.random }) {
  if (typeof background !== 'boolean') throw new Error('B站浏览任务来源无效。');
  const tokens = queryTokens(`${interests || ''} ${store.getSetting('persona', {}).description || ''}`);
  const excluded = new Set(failedUrls);
  const unreadableUrls = [];
  let unreadableError;
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    let selectedUrl = '', selectionReason = '';
    try {
      const payload = await runtime.execute({ scope: 'owner', actor: 'scheduler', name: 'browse_bili', signal,
        priority: background ? 'background' : 'normal', ...(onYield === undefined ? {} : { onYield }),
        selectVideo(candidates) {
          signal?.throwIfAborted();
          const unread = candidates.filter(item => !excluded.has(item.url) && !store.hasReadUrl(item.url, 'owner')).map(item => {
            const text = `${item.title} ${item.author}`.normalize('NFKC').toLowerCase();
            const words = new Set(text.match(/[a-z0-9_]+/g) || []);
            return { ...item, score: tokens.filter(token => /^[a-z0-9_]+$/.test(token) ? words.has(token) : text.includes(token)).length };
          });
          if (!unread.length) return null;
          const best = Math.max(...unread.map(item => item.score));
          const choices = unread.filter(item => item.score === best);
          const value = Math.min(0.999999999, Math.max(0, Number(random()) || 0));
          selectedUrl = choices[Math.floor(value * choices.length)].url;
          selectionReason = best ? `配置话题与人格关键词命中 ${best} 项，在未读最高分候选中选择。` : '未命中配置话题与人格关键词，从未读热门候选中随机选择。';
          return selectedUrl;
        },
      });
      if (payload?.skipped === 'no_unread_videos') {
        if (unreadableError) throw unreadableError;
        return { skipped: 'no_unread_videos' };
      }
      signal?.throwIfAborted();
      const page = reader ? await reader.read(selectedUrl, { scope: 'owner', actor: 'scheduler', signal, background, onYield, textPayload: payload }) : biliReadingPage(payload, selectedUrl);
      return { ...page, source: page.evidence.plugin, selectionReason: `${unreadableUrls.length ? '前一候选无可用资料，改选不同视频。' : ''}${selectionReason}`,
        ...(unreadableUrls.length ? { unreadableUrls: [...unreadableUrls] } : {}) };
    } catch (error) {
      if (selectedUrl) error.sourceUrl = selectedUrl;
      if (error.code === 'NO_READABLE_TEXT' && selectedUrl && reader?.status().enabled) {
        try {
          const page = await reader.read(selectedUrl, { scope: 'owner', actor: 'scheduler', signal, background, onYield, textPayload: null });
          return { ...page, source: page.evidence.plugin, selectionReason,
            ...(unreadableUrls.length ? { unreadableUrls: [...unreadableUrls] } : {}) };
        } catch (mediaError) { mediaError.sourceUrl = selectedUrl; throw mediaError; }
      }
      if (error.code === 'NO_READABLE_TEXT' && selectedUrl) {
        excluded.add(selectedUrl); unreadableUrls.push(selectedUrl); unreadableError = error;
      }
      if (unreadableUrls.length) error.unreadableUrls = [...unreadableUrls];
      if (attempt === 0 && error.code === 'NO_READABLE_TEXT' && selectedUrl && !signal?.aborted) continue;
      throw error;
    }
  }
}
