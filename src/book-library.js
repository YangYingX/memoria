import { parseHTML } from 'linkedom';
import { fetchPublicResource } from './public-fetch.js';

const HOME = 'https://zh.wikisource.org';
const API = HOME + '/w/api.php';
const MAX_RESPONSE = 4 * 1024 * 1024;
const MAX_TEXT_BYTES = 3 * 1024 * 1024;
const MAX_TEXT_CHARS = 1000000;
const MAX_PAGES = 150;
const FALLBACK = ['阿Q正傳', '東坡志林', '狂人日記', '西遊記'];
const USER_AGENT = 'MemoriaBookBot/0.3 (https://github.com/YangYingX/memoria; public book discovery)';
const fields = ['id', 'title', 'author', 'sourceRef', 'description'];
const object = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function fail(message) { throw new Error(message); }
function validText(value, limit, empty = false) {
  return typeof value === 'string' && value.length <= limit && value.isWellFormed()
    && !/[\x00-\x1f\x7f]/.test(value) && (empty || Boolean(value.trim()));
}
const validTitle = value => validText(value, 200) && !/[|#<>\[\]{}]/.test(value);
function pageId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) fail('公共书源返回的页面或修订编号无效。');
  return value;
}
const sourceRef = title => HOME + '/wiki/' + encodeURIComponent(title.replace(/ /g, '_')).replace(/%2F/g, '/');
const plain = value => value.replace(/[\t\r ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
function snippet(html) {
  if (typeof html !== 'string' || html.length > 20000) fail('公共书目简介格式无效。');
  const { document } = parseHTML('<html><body>' + html + '</body></html>');
  for (const node of document.querySelectorAll('script,style,template,iframe,object,embed')) node.remove();
  return document.body.textContent.replace(/\s+/g, ' ').trim().slice(0, 800);
}
function parsedPage(value, expected) {
  const page = value.parse;
  if (!object(page) || pageId(page.pageid) !== expected.pageid || !validTitle(page.title)
    || expected.title !== undefined && page.title !== expected.title || pageId(page.revid) !== (expected.revid ?? page.revid)
    || typeof page.text !== 'string' || page.text.length > MAX_RESPONSE || !Array.isArray(page.links) || page.links.length > 10000)
    fail('公共书籍页面的真实标识或正文无法核验。');
  const { document } = parseHTML('<html><body>' + page.text + '</body></html>');
  const root = document.querySelector('.mw-parser-output') || document.body;
  const authors = [];
  for (const anchor of root.querySelectorAll('a[href]')) {
    let url;
    try { url = new URL(anchor.getAttribute('href'), HOME); } catch { continue; }
    if (url.origin !== HOME || !url.pathname.startsWith('/wiki/Author:')) continue;
    const header = anchor.closest('table'), text = anchor.textContent.replace(/\s+/g, ' ').trim();
    if (header && /(?:作者|譯者|译者|編者|编者)[：:]/.test(header.textContent) && header.textContent.length < 2000
      && validText(text, 200)) { if (!authors.includes(text)) authors.push(text); }
  }
  const author = authors.join('、');
  if (!validText(author, 200, true)) fail('公共书籍作者字段无效。');
  const headerTables = [...root.querySelectorAll('a[href]')].filter(anchor => {
    try { return new URL(anchor.getAttribute('href'), HOME).pathname.startsWith('/wiki/Author:'); } catch { return false; }
  }).map(anchor => anchor.closest('table')).filter(table => table && table.textContent.length < 2000
    && /(?:作者|譯者|译者|編者|编者)[：:]/.test(table.textContent));
  for (const node of root.querySelectorAll('script,style,noscript,template,iframe,object,embed,.ws-noexport,.noprint,.mw-editsection,.licenseContainer,.licensetpl,.sistersitebox,.sisterproject,.ws-header,#toc,.toc,.printfooter,.catlinks')) node.remove();
  for (const table of headerTables) table.remove();
  const known = new Map();
  for (const link of page.links) {
    if (!object(link) || !Number.isInteger(link.ns) || typeof link.title !== 'string') fail('公共书籍目录格式无效。');
    if (link.ns === 0 && validTitle(link.title)) known.set(link.title, link);
  }
  const allChildren = [], listed = new Set(), directories = [];
  let children = [];
  let flatDirectory = false, mixedDirectory = false;
  for (const anchor of root.querySelectorAll('a[href]')) {
    let url, title;
    try {
      url = new URL(anchor.getAttribute('href'), HOME);
      if (url.origin !== HOME || !url.pathname.startsWith('/wiki/')) continue;
      title = decodeURIComponent(url.pathname.slice('/wiki/'.length)).replace(/_/g, ' ');
    } catch { continue; }
    if (title.startsWith(page.title + '/')) {
      if (!validTitle(title) || known.get(title)?.exists !== true) fail('公共书籍目录有缺失页面。');
      if (!listed.has(title)) { listed.add(title); allChildren.push(title); }
    }
  }
  for (const list of root.querySelectorAll('ul,ol,table,dl')) {
    const linked = [...list.querySelectorAll('a[href]')].map(anchor => {
      try {
        const url = new URL(anchor.getAttribute('href'), HOME), title = decodeURIComponent(url.pathname.slice('/wiki/'.length)).replace(/_/g, ' ');
        return url.origin === HOME && url.pathname.startsWith('/wiki/') && known.has(title) && title !== page.title
          ? { title, label: anchor.textContent.trim() } : null;
      } catch { return null; }
    }).filter(Boolean);
    if (linked.length >= 2 || linked.some(link => link.title.startsWith(page.title)
      || /(?:第[〇零一二三四五六七八九十百千\d]+[章節节卷回部篇]|^[序跋]|楔子|附[錄录]|^[上中下][篇卷部集]$|^正文$)/.test(link.label))) flatDirectory = true;
    const titles = [...new Set(linked.filter(link => link.title.startsWith(page.title + '/')).map(link => link.title))];
    if (titles.length) directories.push({ node: list, titles, anchors: list.querySelectorAll('a[href]').length,
      mixed: linked.some(link => !link.title.startsWith(page.title + '/')) });
  }
  if (allChildren.length) {
    const complete = directories.filter(directory => directory.titles.length === allChildren.length
      && allChildren.every(title => directory.titles.includes(title))).sort((a, b) => a.anchors - b.anchors);
    if (!complete.length) {
      const error = new Error('公共书籍的完整目录结构尚无法核验。');
      error.code = 'BOOK_LAYOUT_UNSUPPORTED';
      throw error;
    }
    children = complete[0].titles;
    mixedDirectory = directories.some(directory => directory.mixed && directory.node.contains(complete[0].node));
  }
  const prose = root.cloneNode(true);
  for (const node of prose.querySelectorAll('a,ul,ol,table,dl')) node.remove();
  const proseLength = prose.textContent.replace(/\s+/g, '').length;
  for (const node of root.querySelectorAll('br')) node.replaceWith('\n');
  for (const node of root.querySelectorAll('p,div,li,blockquote,h1,h2,h3,h4,pre,tr')) node.append('\n');
  const text = plain(root.textContent);
  if (!text || !text.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) fail('公共书籍正文无效。');
  return { pageid: page.pageid, revid: page.revid, title: page.title, author, text, children, mixedDirectory,
    readable: proseLength >= 200 && !flatDirectory };
}

export function createPublicBookLibrary({ request = fetchPublicResource } = {}) {
  if (typeof request !== 'function') fail('公共书源请求器无效。');
  let busy = false, lastRequestAt = -Infinity;
  const cache = new Map();
  const active = signal => signal?.throwIfAborted();
  async function pause(milliseconds, signal) {
    active(signal);
    if (milliseconds <= 0) return;
    await new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(); };
      const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason || new Error('找书已取消。')); };
      const timer = setTimeout(done, milliseconds);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    active(signal);
  }
  function signalValue(value) { if (value !== undefined && !(value instanceof AbortSignal)) fail('公共书源取消信号无效。'); return value; }
  async function api(params, signal) {
    active(signal); await pause(Math.max(0, lastRequestAt + 1000 - Date.now()), signal); active(signal);
    const url = API + '?' + new URLSearchParams({ ...params, format: 'json', formatversion: '2', maxlag: '5' });
    lastRequestAt = Date.now();
    const response = await request(url, { signal, maxBytes: MAX_RESPONSE, timeoutMs: 20000, maxRedirects: 0, proxyDns: true,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, allowUrl: target => target.href === url });
    active(signal);
    if (!response || response.url !== url || response.status !== 200 || !Buffer.isBuffer(response.bytes) || response.bytes.length > MAX_RESPONSE
      || !/^application\/json(?:\s*;|$)/i.test(response.headers?.['content-type'] || '')) fail('公共书源返回格式无效。');
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.bytes)); } catch { fail('公共书源返回格式无效。'); }
    if (!object(value) || value.error || value.warnings || value.continue && !(params.action === 'query' && params.list === 'search'))
      fail('公共书源暂不可用或结果不完整，本轮未收录。');
    return value;
  }
  async function parse(pageid, signal, expected = {}) {
    const params = expected.revid ? { oldid: String(expected.revid) } : { pageid: String(pageid) };
    return parsedPage(await api({ action: 'parse', ...params, prop: 'text|displaytitle|revid|links' }, signal), { pageid, ...expected });
  }
  async function metadata(titles, signal) {
    const results = new Map();
    for (let start = 0; start < titles.length; start += 50) {
      const batch = titles.slice(start, start + 50), value = await api({ action: 'query', titles: batch.join('|'), prop: 'info|revisions',
        inprop: 'url', rvprop: 'ids' }, signal);
      if (!Array.isArray(value.query?.pages) || value.query.pages.length !== batch.length) fail('公共书籍目录有缺失页面。');
      for (const item of value.query.pages) {
        if (!object(item) || item.ns !== 0 || item.missing || item.invalid || item.redirect || !batch.includes(item.title)
          || sourceRef(item.title) !== item.canonicalurl || pageId(item.pageid) < 1 || !Array.isArray(item.revisions)
          || item.revisions.length !== 1 || pageId(item.revisions[0].revid) !== pageId(item.lastrevid) || results.has(item.title)
          || [...results.values()].some(previous => previous.pageid === item.pageid))
          fail('公共书籍目录的页面或修订编号无法核验。');
        results.set(item.title, { pageid: item.pageid, revid: item.lastrevid, title: item.title });
      }
    }
    return results;
  }
  return {
    async discover({ interests = '', signal } = {}) {
      signal = signalValue(signal); active(signal);
      if (typeof interests !== 'string' || interests.length > 1000 || !interests.isWellFormed() || /[\x00-\x1f\x7f]/.test(interests)) fail('找书兴趣格式无效。');
      if (busy) fail('公共书源正在处理另一轮任务。');
      busy = true;
      try {
        cache.clear();
        const query = Array.from(interests.trim()).slice(0, 100).join('') || '小說';
        const value = await api({ action: 'query', list: 'search', srsearch: query, srnamespace: '0', srlimit: '5' }, signal);
        if (!Array.isArray(value.query?.search) || value.query.search.length > 5) fail('公共书目搜索结果无效。');
        const found = value.query.search.map(item => {
          if (!object(item) || item.ns !== 0 || !validTitle(item.title)) fail('公共书目搜索结果无效。');
          return { pageid: pageId(item.pageid), title: item.title, description: snippet(item.snippet) };
        });
        const next = new Map(), checked = new Map();
        async function addCandidates(items) {
          for (const item of items) {
            if (checked.has(item.pageid)) {
              if (checked.get(item.pageid) !== item.title) fail('公共书目标识与标题不一致。');
              continue;
            }
            checked.set(item.pageid, item.title);
            let page;
            try { page = await parse(item.pageid, signal, { title: item.title }); }
            catch (error) {
              if (error?.code === 'BOOK_LAYOUT_UNSUPPORTED' && !signal?.aborted) continue;
              throw error;
            }
            if (!page.author || page.mixedDirectory || (!page.children.length && !page.readable)) continue;
            const candidate = { id: String(page.pageid), title: page.title, author: page.author, sourceRef: sourceRef(page.title),
              description: item.description || '正文或目录节选：' + page.text.replace(/\s+/g, ' ').slice(0, 600) };
            next.set(candidate.id, { candidate, pageid: page.pageid, revid: page.revid });
          }
        }
        await addCandidates(found);
        if (!next.size) await addCandidates([...(await metadata(FALLBACK, signal)).values()].map(item => ({ ...item, description: '' })));
        active(signal); cache.clear(); for (const [id, value] of next) cache.set(id, value);
        return [...cache.values()].map(item => ({ ...item.candidate }));
      } finally { busy = false; }
    },
    async load(candidate, { signal } = {}) {
      signal = signalValue(signal); active(signal);
      if (!object(candidate) || Reflect.ownKeys(candidate).length !== fields.length || fields.some(key => !Object.hasOwn(candidate, key))) fail('请使用本轮实际发现的完整书目标识。');
      const entry = cache.get(candidate.id);
      if (!entry || fields.some(key => candidate[key] !== entry.candidate[key])) fail('书目已失效或来源字段已变化。');
      if (busy) fail('公共书源正在处理另一轮任务。');
      busy = true;
      try {
        const current = (await metadata([candidate.title], signal)).get(candidate.title);
        if (!current || current.pageid !== entry.pageid || current.revid !== entry.revid) fail('公共书籍版本已变化，请重新发现后再选书。');
        const root = await parse(entry.pageid, signal, current);
        if (root.author !== candidate.author) fail('公共书籍作者已变化，本轮未收录。');
        const seen = new Set(), pieces = [];
        let totalCharacters = 0, totalBytes = 0;
        async function collect(page) {
          active(signal);
          if (seen.has(page.pageid)) return;
          if (seen.size >= MAX_PAGES || page.title !== root.title && !page.title.startsWith(root.title + '/')) fail('公共书籍目录超出同书或页数范围。');
          if (page.mixedDirectory) fail('公共书籍目录包含无法完整收录的平级章节。');
          if (page.author && page.author !== root.author) fail('公共书籍子页作者与本书不一致。');
          seen.add(page.pageid);
          const text = page.title + '\n\n' + page.text;
          totalCharacters += text.length; totalBytes += Buffer.byteLength(text, 'utf8') + (pieces.length ? 2 : 0);
          if (totalCharacters > MAX_TEXT_CHARS || totalBytes > MAX_TEXT_BYTES) fail('公共书籍超过整书大小上限，本轮未收录。');
          pieces.push(text);
          if (!page.children.length) { if (!page.readable) fail('该页面只有目录或说明，尚未取得完整作品。'); return; }
          if (seen.size + page.children.length > MAX_PAGES) fail('公共书籍目录超过页数上限，本轮未收录。');
          const pages = await metadata(page.children, signal);
          for (const title of page.children) {
            const target = pages.get(title);
            if (!target) fail('公共书籍目录有缺失页面。');
            if (!seen.has(target.pageid)) await collect(await parse(target.pageid, signal, target));
          }
        }
        await collect(root); active(signal);
        return { title: candidate.title, text: pieces.join('\n\n'), sourceRef: candidate.sourceRef };
      } finally { busy = false; }
    },
  };
}
