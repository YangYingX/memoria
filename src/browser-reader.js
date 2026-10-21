import { chromium } from 'playwright';
import { fetchPublicResource } from './public-fetch.js';

const HOME = 'https://www.xiaoheihe.cn/app/bbs/home';
const MAX_TEXT = 30000;
const MAX_REQUESTS = 100;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const POST_PATH = /^\/app\/bbs\/link\/(\d{1,20})$/;
const POST_BODY = '.hb-bbs-link__content .post__content';
const POST_LIST = '.bbs-home__content-list a.hb-cpt__bbs-list-content';

function postUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('请输入有效的小黑盒帖子地址。');
  let url;
  try { url = new URL(value); } catch { throw new Error('请输入有效的小黑盒帖子地址。'); }
  if (url.origin !== 'https://www.xiaoheihe.cn' || url.username || url.password || !POST_PATH.test(url.pathname)) {
    throw new Error('仅支持小黑盒公开帖子地址。');
  }
  url.search = ''; url.hash = '';
  return url.href;
}

export function isHeyboxPostUrl(value) {
  try { postUrl(value); return true; } catch { return false; }
}

async function visit(url, signal, extract) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), 50000);
  let browser, context, page, requests = 0, bytesRead = 0, verificationRequired = false;
  let downloads = Promise.resolve();
  const stop = () => { browser?.close().catch(() => {}); };
  combined.addEventListener('abort', stop, { once: true });
  const target = new URL(url);
  const linkId = target.pathname.match(POST_PATH)?.[1];
  const allowResource = candidate => {
    if (candidate.protocol !== 'https:' || candidate.username || candidate.password || candidate.port) return false;
    if (candidate.hostname === 'www.xiaoheihe.cn') return candidate.href === target.href;
    if (candidate.hostname === 'static.max-c.com') {
      return ['/static/heybox/webapp/', '/web/npm/', '/web/packages/hb-font/'].some(prefix => candidate.pathname.startsWith(prefix));
    }
    if (candidate.hostname !== 'api.xiaoheihe.cn') return false;
    return linkId
      ? candidate.pathname === '/bbs/app/link/tree' && candidate.searchParams.get('link_id') === linkId
      : candidate.pathname === '/bbs/app/feeds';
  };
  try {
    browser = await chromium.launch({
      headless: true, chromiumSandbox: true, timeout: 15000,
      // Every allowed resource is fulfilled by the DNS-pinned reader. Any uncaught
      // browser request fails at this unused proxy instead of reaching the network.
      proxy: { server: 'http://127.0.0.1:9', bypass: '<-loopback>' },
      args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
    });
    combined.throwIfAborted();
    context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, permissions: [] });
    await context.routeWebSocket('**/*', socket => socket.close());
    await context.route('**/*', async route => {
      const request = route.request();
      let candidate;
      try { candidate = new URL(request.url()); } catch { return route.abort(); }
      if (candidate.hostname === 'turing.captcha.qcloud.com') {
        verificationRequired = true;
        controller.abort();
        return route.abort().catch(() => {});
      }
      const navigation = request.isNavigationRequest();
      let mainFrame = false;
      try { mainFrame = request.frame() === page?.mainFrame(); } catch { /* Workers have no frame. */ }
      if (combined.aborted || request.method() !== 'GET' || !allowResource(candidate)
        || !['document', 'script', 'stylesheet', 'xhr', 'fetch'].includes(request.resourceType())
        || (navigation && (!mainFrame || candidate.href !== target.href))
        || ++requests > MAX_REQUESTS || bytesRead >= MAX_TOTAL_BYTES) {
        return route.abort().catch(() => {});
      }
      // Serialize the bounded resource downloads so the total limit also covers
      // bytes in flight, instead of allowing every concurrent script its own budget.
      const previous = downloads;
      let release;
      downloads = new Promise(resolve => { release = resolve; });
      await previous;
      try {
        if (combined.aborted || bytesRead >= MAX_TOTAL_BYTES) return route.abort().catch(() => {});
        const original = await request.allHeaders();
        const headers = Object.fromEntries(['accept', 'accept-language', 'user-agent', 'origin', 'referer']
          .filter(key => original[key]).map(key => [key, original[key]]));
        const resource = await fetchPublicResource(candidate.href, {
          signal: combined, timeoutMs: 12000, maxBytes: Math.min(4 * 1024 * 1024, MAX_TOTAL_BYTES - bytesRead),
          maxRedirects: 0, allowUrl: allowResource, headers,
        });
        bytesRead += resource.bytes.length;
        if (combined.aborted || bytesRead > MAX_TOTAL_BYTES) return route.abort().catch(() => {});
        const responseHeaders = Object.fromEntries(Object.entries(resource.headers).map(([key, value]) => [key, String(value)]));
        await route.fulfill({ status: resource.status, headers: responseHeaders, body: resource.bytes });
      } catch { await route.abort().catch(() => {}); }
      finally { release(); }
    });
    page = await context.newPage();
    context.on('page', opened => { if (opened !== page) opened.close().catch(() => {}); });
    page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
    page.on('download', download => download.cancel().catch(() => {}));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    const result = await extract(page);
    combined.throwIfAborted();
    return result;
  } catch (error) {
    if (verificationRequired) throw new Error('小黑盒要求访问验证，本次阅读已停止，未绕过验证。');
    if (combined.aborted) throw new Error('小黑盒阅读已取消或超时，未记录阅读经历。');
    if (/Executable doesn't exist|browserType\.launch/.test(error.message)) {
      throw new Error('独立阅读浏览器无法启动；请先运行 npm run browser:install，并检查 Linux 系统依赖。');
    }
    if (/^小黑盒/.test(error.message)) throw error;
    throw new Error('小黑盒公开内容未能加载，可能需要登录、页面已变更或暂时不可访问；未记录阅读经历。');
  } finally {
    clearTimeout(timer);
    combined.removeEventListener('abort', stop);
    controller.abort();
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

export async function discoverHeyboxPosts({ signal } = {}) {
  return visit(HOME, signal, async page => {
    await page.waitForSelector(POST_LIST, { state: 'attached', timeout: 20000 });
    const candidates = await page.locator(POST_LIST).evaluateAll(nodes => nodes.slice(0, 40).map(node => ({
      url: node.href,
      title: node.querySelector('.bbs-content__title')?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 500) || '',
      excerpt: node.querySelector('.bbs-content__content')?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 300) || '',
    })));
    const seen = new Set();
    const result = [];
    for (const candidate of candidates) {
      try {
        candidate.url = postUrl(candidate.url);
        if (candidate.title && !seen.has(candidate.url)) { seen.add(candidate.url); result.push(candidate); }
      } catch { /* Ignore unrelated links, never turn them into navigation targets. */ }
    }
    if (!result.length) throw new Error('小黑盒没有提供可读取的公开帖子，未记录阅读经历。');
    return result;
  });
}

export async function readHeyboxPost(value, { signal, maxText = MAX_TEXT } = {}) {
  if (!Number.isSafeInteger(maxText) || maxText < 1 || maxText > 1000000) throw new Error('正文长度限制无效。');
  const url = postUrl(value);
  return visit(url, signal, async page => {
    await page.waitForSelector(POST_BODY, { state: 'attached', timeout: 20000 });
    const article = await page.evaluate(({ selector, maxText }) => {
      const body = document.querySelector(selector);
      const title = document.querySelector('.hb-bbs-link__content .section-title__content')?.innerText || '';
      const text = body?.innerText?.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() || '';
      return {
        title: title.replace(/\s+/g, ' ').trim().slice(0, 500),
        text: text.slice(0, maxText), truncated: text.length > maxText, bodyLength: text.length,
      };
    }, { selector: POST_BODY, maxText });
    if (!article.title || article.bodyLength < 40) {
      throw new Error('小黑盒帖子没有足够的公开文字正文；图片、视频或登录页未作为已读内容保存。');
    }
    delete article.bodyLength;
    return { url, ...article, excerpt: article.text.replace(/\s+/g, ' ').slice(0, 300), readAt: new Date().toISOString() };
  });
}
