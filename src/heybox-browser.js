import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdirSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { normalizeHeyboxCredentials, readHeyboxCredentials } from './heybox-credentials.js';
import { heyboxId, normalizeHeyboxComment } from './heybox-thread.js';
import { heyboxPlainText, heyboxPostReference, normalizeHeyboxDiscussion } from './heybox-web.js';

const HOME = 'https://www.xiaoheihe.cn/app/bbs/home';
const ORIGIN = 'https://www.xiaoheihe.cn';
const API = 'https://api.xiaoheihe.cn';
const CREATE = '/bbs/app/comment/create';
const OWN = '/bbs/app/profile/events';
const TREE = '/bbs/app/link/tree';
const WRAPPER = '.link-comment__reply[data-reply_wrapper="true"]';
const EDITOR = `${WRAPPER} .link-reply__editor .ProseMirror[contenteditable="true"]`;
const SEND = `${WRAPPER} button.link-reply__menu-btn.hb-color__btn--confirm`;
const object = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const clean = value => value.replace(/\r\n?/g, '\n').trim();
function fail(code) { const error = new Error(code); error.code = code; throw error; }
const known = new Set(['INVALID_INPUT', 'BUSY', 'CANCELLED', 'PROFILE_UNAVAILABLE', 'ACCOUNT_CHANGED', 'SESSION_UNVERIFIED',
  'VERIFICATION_REQUIRED', 'SOURCE_CHANGED', 'DRAFT_PRESENT', 'COMMENT_UNAVAILABLE', 'REQUEST_REFUSED',
  'DUPLICATE_SUBMISSION', 'RECEIPT_UNCONFIRMED', 'READ_FAILED', 'BROWSER_FAILED', 'BROWSER_CLOSE_FAILED']);
const codeOf = error => known.has(error?.code) ? error.code : 'BROWSER_FAILED';
const decimal = value => heyboxId(typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value);

function inputValue(operation, value) {
  if (['readOwn', 'readDiscussion'].includes(operation)) {
    if (!object(value) || Reflect.ownKeys(value).some(key => !['signal', ...(operation === 'readDiscussion' ? ['url'] : [])].includes(key))
      || (value.signal !== undefined && !(value.signal instanceof AbortSignal))) fail('INVALID_INPUT');
    if (operation === 'readOwn') return { ...value };
    try { return { ...value, ...heyboxPostReference(value.url) }; } catch { fail('INVALID_INPUT'); }
  }
  const keys = ['accountId', 'postId', 'url', 'title', 'postText', 'postAuthorId', 'text', 'signal', 'beforeSend', ...(operation === 'reply' ? ['comment'] : [])];
  if (!object(value) || Reflect.ownKeys(value).some(key => !keys.includes(key)) || typeof value.beforeSend !== 'function') fail('INVALID_INPUT');
  let accountId, postId, postAuthorId, comment;
  try { accountId = heyboxId(value.accountId); postId = heyboxId(value.postId); if (value.postAuthorId !== undefined) postAuthorId = heyboxId(value.postAuthorId); if (operation === 'reply') comment = normalizeHeyboxComment(value.comment); }
  catch { fail('INVALID_INPUT'); }
  const url = `${ORIGIN}/app/bbs/link/${postId}`;
  if (value.url !== url || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 500
    || /[\x00-\x1f\x7f]/.test(value.title) || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 200
    || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.text)
    || value.postText !== undefined && (typeof value.postText !== 'string' || !value.postText.trim() || value.postText.length > 30000
      || clean(value.postText) !== value.postText || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.postText))
    || (value.signal !== undefined && !(value.signal instanceof AbortSignal))) fail('INVALID_INPUT');
  return { ...value, accountId, postId, url, title: value.title.trim(), text: clean(value.text), ...(postAuthorId ? { postAuthorId } : {}), ...(comment ? { comment } : {}) };
}

async function responseJson(response) {
  const headers = response.headers(), length = headers['content-length'];
  if (!response.ok() || !/^application\/json(?:\s*;|$)/i.test(headers['content-type'] || '')
    || (length !== undefined && (!/^\d+$/.test(length) || Number(length) > 1024 * 1024))) fail('RECEIPT_UNCONFIRMED');
  const bytes = await response.body();
  if (bytes.length > 1024 * 1024) fail('RECEIPT_UNCONFIRMED');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('RECEIPT_UNCONFIRMED'); }
}

function receiptId(value, input, operation) {
  if (value?.status === 'show_captcha') fail('VERIFICATION_REQUIRED');
  if (value?.status !== 'ok' || !object(value.result)) fail('RECEIPT_UNCONFIRMED');
  const result = Array.isArray(value.result.comment) ? value.result : value.result.comment;
  if (!object(result) || !Array.isArray(result.comment) || result.comment.length !== 1 || !object(result.comment[0])) fail('RECEIPT_UNCONFIRMED');
  const item = result.comment[0];
  let id;
  try {
    id = decimal(item.commentid);
    // The official UI accepts this ID as a submission receipt; optional echoed fields must agree.
    if (Object.hasOwn(item, 'userid') && decimal(item.userid) !== input.accountId) fail('RECEIPT_UNCONFIRMED');
    if (Object.hasOwn(item, 'user') && (!object(item.user)
      || Object.hasOwn(item.user, 'userid') && decimal(item.user.userid) !== input.accountId)) fail('RECEIPT_UNCONFIRMED');
    if (Object.hasOwn(item, 'text') && heyboxPlainText(item.text, 200) !== input.text) fail('RECEIPT_UNCONFIRMED');
    const parents = ['replyid', 'reply_id'].filter(key => Object.hasOwn(item, key));
    const roots = ['root_id', 'rootid'].filter(key => Object.hasOwn(item, key));
    if (operation === 'reply') {
      if (id === input.comment.commentId || id === input.comment.rootId || parents.some(key => decimal(item[key]) !== input.comment.commentId)
        || roots.some(key => decimal(item[key]) !== input.comment.rootId)) fail('RECEIPT_UNCONFIRMED');
    } else if (parents.some(key => !['0', '-1'].includes(String(item[key])))
      || roots.some(key => !['0', '-1', id].includes(String(item[key])))) fail('RECEIPT_UNCONFIRMED');
    if (['linkid', 'link_id'].some(key => Object.hasOwn(item, key) && decimal(item[key]) !== input.postId)) fail('RECEIPT_UNCONFIRMED');
    if (Object.hasOwn(item, 'imgs') && (Array.isArray(item.imgs) ? item.imgs.length !== 0 : ![null, ''].includes(item.imgs))) fail('RECEIPT_UNCONFIRMED');
  } catch { fail('RECEIPT_UNCONFIRMED'); }
  return id;
}

// The official page owns its session, request parameters and signing. No Cookie header is constructed here.
export function createHeyboxBrowserRuntime({ dataDir, getCredentials = () => readHeyboxCredentials({ dataDir }),
  contextFactory = (profile, options) => chromium.launchPersistentContext(profile, options) } = {}) {
  if (typeof dataDir !== 'string' || !dataDir.trim() || typeof getCredentials !== 'function' || typeof contextFactory !== 'function') fail('INVALID_INPUT');
  const profile = join(resolve(dataDir), 'heybox-browser');
  let context, closing, busy = false, stopped = false, blocked = false, controller, drained = Promise.resolve(), lastError = null;
  async function closeContext() {
    if (closing) return closing;
    if (!context) return;
    const owned = context;
    closing = (async () => {
      try { await owned.close(); if (context === owned) context = undefined; }
      catch { blocked = true; lastError = 'BROWSER_CLOSE_FAILED'; fail('BROWSER_CLOSE_FAILED'); }
    })().finally(() => { closing = undefined; });
    return closing;
  }
  function snapshot() {
    let value;
    try { value = normalizeHeyboxCredentials(getCredentials()); } catch { fail('ACCOUNT_CHANGED'); }
    return { accountId: value.accountId, signature: createHash('sha256').update(JSON.stringify(value)).digest('hex') };
  }
  async function run(operation, raw) {
    const reading = ['readOwn', 'readDiscussion'].includes(operation);
    if (stopped) { if (reading) fail('CANCELLED'); return { outcome: 'failed', code: 'CANCELLED' }; }
    if (busy) { if (reading) fail('BUSY'); return { outcome: 'failed', code: 'BUSY' }; }
    if (blocked) { if (reading) fail('BROWSER_CLOSE_FAILED'); return { outcome: 'failed', code: 'BROWSER_CLOSE_FAILED' }; }
    let input;
    try { input = inputValue(operation, raw); } catch { if (reading) fail('INVALID_INPUT'); return { outcome: 'failed', code: 'INVALID_INPUT' }; }
    busy = true;
    let finish;
    drained = new Promise(accept => { finish = accept; });
    const current = controller = new AbortController();
    const abort = () => { current.abort(); void closeContext().catch(() => {}); };
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    const timer = setTimeout(abort, 120000);
    let postAttempted = false, permittedRequest, editorPage, armed = false, approving = false, approved = false, routeError, result, readError;
    const observations = new Set();
    const active = () => { if (current.signal.aborted || stopped) fail('CANCELLED'); };
    let expected;
    const check = () => { active(); if (JSON.stringify(snapshot()) !== JSON.stringify(expected)) fail('ACCOUNT_CHANGED'); };
    const stopRoute = (error, route) => {
      routeError ||= codeOf(error);
      const aborted = route.abort('blockedbyclient').catch(() => {});
      void closeContext().catch(() => {});
      return aborted;
    };
    async function newOwnedPage() {
      check();
      const page = await context.newPage();
      try {
        // Persistent profiles may already have a worker; bypass it without changing stored registrations.
        const session = await context.newCDPSession(page);
        await session.send('Network.enable');
        await session.send('Network.setBypassServiceWorker', { bypass: true });
        check();
        return page;
      } catch (error) {
        await page.close({ runBeforeUnload: false });
        active();
        throw error;
      }
    }
    async function identity() {
      check();
      const page = await newOwnedPage();
      try {
        const response = page.waitForResponse(response => {
          const url = new URL(response.url());
          return response.request().method() === 'GET' && url.origin === API && url.pathname === '/account/restore_login';
        }, { timeout: 30000 });
        // Observe the website's own signed GET, not a guessed equivalent request.
        const [, observed] = await Promise.all([page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30000 }), response]);
        check();
        const value = await responseJson(observed);
        if (value?.status === 'show_captcha') fail('VERIFICATION_REQUIRED');
        if (value?.status !== 'ok') fail('SESSION_UNVERIFIED');
        let accountId;
        try { accountId = decimal(value.result?.account_detail?.userid); } catch { fail('SESSION_UNVERIFIED'); }
        if (accountId !== input.accountId) fail('ACCOUNT_CHANGED');
        check();
      } finally { await page.close({ runBeforeUnload: false }); }
    }
    async function verifyDom() {
      check();
      const location = new URL(editorPage.url());
      if (location.origin !== ORIGIN || location.pathname !== `/app/bbs/link/${input.postId}`) fail('SOURCE_CHANGED');
      const title = editorPage.locator('.link-section-title .section-title__content');
      if (await title.count() !== 1 || clean(await title.innerText()) !== input.title) fail('SOURCE_CHANGED');
      const wrapper = editorPage.locator(WRAPPER);
      if (await wrapper.count() !== 1 || await editorPage.locator(`${WRAPPER}.link-reply--disabled`).count()) fail('COMMENT_UNAVAILABLE');
      if (operation !== 'reply') return;
      const main = editorPage.locator(`.link-comment__comment-item[data-comment-id="${input.comment.rootId}"]`);
      if (await main.count() !== 1) fail('SOURCE_CHANGED');
      const root = input.comment.parentId === '0';
      const target = root ? main : main.locator(`.comment-children-item[data-comment-id="${input.comment.commentId}"]`);
      const author = target.locator(root ? ':scope > .link-comment__comment-item-header a.info-box__username' : 'a.children-item__comment-creator');
      const content = target.locator(root ? ':scope > .comment-item__content-container > .comment-item__content' : '.children-item__comment-content');
      if (await target.count() !== 1 || await author.count() !== 1 || await content.count() !== 1
        || clean(await content.innerText()) !== input.comment.text) fail('SOURCE_CHANGED');
      const href = await author.getAttribute('href');
      let url;
      try { url = new URL(href, ORIGIN); } catch { fail('SOURCE_CHANGED'); }
      if (url.origin !== ORIGIN || url.pathname !== `/app/user/profile/${input.comment.authorId}` || url.search || url.hash) fail('SOURCE_CHANGED');
      return content;
    }
    async function readPage({ own = operation === 'readOwn', navigationUrl = input.url } = {}) {
      const page = await newOwnedPage(), path = own ? OWN : TREE;
      try {
      const waiting = page.waitForResponse(response => {
        const url = new URL(response.url());
        return response.request().method() === 'GET' && url.origin === API && url.pathname === path;
      }, { timeout: 30000 });
      const [, response] = await Promise.all([page.goto(own ? `${ORIGIN}/app/user/profile/${input.accountId}` : navigationUrl,
        { waitUntil: 'domcontentloaded', timeout: 30000 }), waiting]);
      check();
      const query = new URL(response.url()).searchParams;
      if (own ? query.getAll('userid').length !== 1 || query.get('userid') !== input.accountId
        || query.getAll('list_type').length !== 1 || query.get('list_type') !== 'moment'
        || query.getAll('lastval').length > 1 || Boolean(query.get('lastval'))
        || query.getAll('limit').length > 1 || query.has('limit') && (!/^[1-9]\d?$/.test(query.get('limit')) || Number(query.get('limit')) > 30)
        : query.getAll('link_id').length !== 1 || query.get('link_id') !== (input.postRef || input.postId)) fail('REQUEST_REFUSED');
      let value;
      try { value = await responseJson(response); } catch { fail('READ_FAILED'); }
      if (value?.status === 'show_captcha') fail('VERIFICATION_REQUIRED');
      if (['login', 'relogin'].includes(value?.status)) fail('SESSION_UNVERIFIED');
      if (value?.status !== 'ok' || !object(value.result)) fail('READ_FAILED');
      check();
      const readAt = new Date().toISOString();
      if (!own) {
        try { return normalizeHeyboxDiscussion({ accountId: input.accountId, postRef: input.postRef || input.postId, url: input.url, tree: value.result, readAt }); }
        catch { fail('READ_FAILED'); }
      }
      if (!Array.isArray(value.result.moments) || value.result.moments.length > 30) fail('READ_FAILED');
      const ids = new Set();
      try {
        for (const item of value.result.moments) {
          const id = decimal(item?.linkid ?? item?.link_id);
          if (item.linkid !== undefined && item.link_id !== undefined && decimal(item.linkid) !== decimal(item.link_id)) fail('READ_FAILED');
          ids.add(id);
        }
      } catch { fail('READ_FAILED'); }
      return { accountId: input.accountId, readAt, urls: [...ids].map(id => `${ORIGIN}/app/bbs/link/${id}`) };
      } finally { await page.close({ runBeforeUnload: false }); }
    }
    async function verifyFreshSource() {
      const url = new URL(input.url);
      if (operation === 'reply') { url.searchParams.set('root_comment_id', input.comment.rootId); url.searchParams.set('comment_id', input.comment.commentId); }
      let source;
      try { source = await readPage({ own: false, navigationUrl: url.href }); }
      catch (error) { if (['READ_FAILED', 'REQUEST_REFUSED'].includes(error?.code)) fail('SOURCE_CHANGED'); throw error; }
      if (source.accountId !== input.accountId || source.postId !== input.postId || source.url !== input.url || source.title !== input.title
        || input.postText !== undefined && source.text !== input.postText
        || input.postAuthorId !== undefined && source.authorId !== input.postAuthorId
        || operation === 'reply' && !source.comments.some(comment => JSON.stringify(comment) === JSON.stringify(input.comment))) fail('SOURCE_CHANGED');
      check();
    }
    try {
      active(); expected = snapshot(); if (reading) input.accountId = expected.accountId;
      if (expected.accountId !== input.accountId) fail('ACCOUNT_CHANGED');
      const info = lstatSync(profile, { throwIfNoEntry: false });
      if (info && (!info.isDirectory() || info.isSymbolicLink())) fail('PROFILE_UNAVAILABLE');
      mkdirSync(profile, { recursive: true, mode: 0o700 });
      context = await contextFactory(profile, { headless: true, chromiumSandbox: true, acceptDownloads: false, permissions: [],
        serviceWorkers: 'block', viewport: { width: 1280, height: 900 }, timeout: 15000, ...(process.platform === 'win32' ? { channel: 'chrome' } : {}) });
      check();
      context.on('response', response => {
        const url = new URL(response.url());
        if (url.origin !== API || !['/account/restore_login', TREE, OWN, '/bbs/app/api/user/permission', CREATE].includes(url.pathname)) return;
        const observing = responseJson(response).then(value => {
          if (value?.status === 'show_captcha') {
            routeError = 'VERIFICATION_REQUIRED';
            void closeContext().catch(() => {});
          }
        }).catch(() => {});
        observations.add(observing); observing.finally(() => observations.delete(observing));
      });
      await context.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (['GET', 'HEAD'].includes(request.method()) || request.method() === 'OPTIONS' && url.origin === API) {
          try { active(); await route.continue(); } catch (error) { await stopRoute(error, route); }
          return;
        }
        let owner;
        try { owner = request.frame().page(); } catch { /* Service-worker writes are never admitted. */ }
        if (url.origin !== API || url.pathname !== CREATE || request.method() !== 'POST' || owner !== editorPage) { await route.abort('blockedbyclient'); return; }
        try {
          check();
          if (!armed) fail('REQUEST_REFUSED');
          if (approving || approved || postAttempted) fail('DUPLICATE_SUBMISSION');
          approving = true;
          const data = request.postData();
          const contentType = await request.headerValue('content-type');
          if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > 8192
            || !/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(contentType || '')) fail('REQUEST_REFUSED');
          const form = new URLSearchParams(data), fields = ['is_cy', 'link_id', 'reply_id', 'root_id', 'text'];
          if ([...form.keys()].length !== fields.length || fields.some(key => form.getAll(key).length !== 1)
            || [...form.keys()].some(key => !fields.includes(key)) || form.get('is_cy') !== '0' || form.get('link_id') !== input.postId
            || form.get('reply_id') !== (operation === 'reply' ? input.comment.commentId : '-1')
            || form.get('root_id') !== (operation === 'reply' ? input.comment.rootId : '-1') || form.get('text') !== input.text
            || fields.some(key => url.searchParams.has(key)) || url.username || url.password || url.hash
            || (url.searchParams.has('heybox_id') && (url.searchParams.getAll('heybox_id').length !== 1 || url.searchParams.get('heybox_id') !== input.accountId))) fail('REQUEST_REFUSED');
          await identity();
          await verifyDom();
          await verifyFreshSource();
          check();
          if (await input.beforeSend() === false) fail('CANCELLED');
          approved = true; check();
          permittedRequest = request;
          postAttempted = true;
          await route.continue();
        } catch (error) { await stopRoute(error, route); }
        finally { approving = false; }
      });
      await identity();
      if (reading) {
        result = await readPage(); check(); lastError = null;
      } else {
      editorPage = await newOwnedPage();
      const targetUrl = new URL(input.url);
      if (operation === 'reply') { targetUrl.searchParams.set('root_comment_id', input.comment.rootId); targetUrl.searchParams.set('comment_id', input.comment.commentId); }
      await editorPage.goto(targetUrl.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await editorPage.locator('.link-section-title .section-title__content').waitFor({ state: 'visible', timeout: 20000 });
      const editor = editorPage.locator(EDITOR);
      try { await editor.waitFor({ state: 'attached', timeout: 20000 }); }
      catch { fail(routeError || 'COMMENT_UNAVAILABLE'); }
      const target = await verifyDom();
      if (await editor.count() !== 1 || !await editor.isEditable()) fail('COMMENT_UNAVAILABLE');
      if (clean(await editor.innerText())) fail('DRAFT_PRESENT');
      if (operation === 'reply') {
        await target.click({ timeout: 10000 });
        const selected = editorPage.locator(`${WRAPPER} .link-comment__target--comment`);
        if (await selected.count() !== 1 || clean(await selected.innerText()) !== input.comment.text) fail('SOURCE_CHANGED');
      } else {
        if (await editorPage.locator(`${WRAPPER} .link-comment__target--comment`).count()) fail('DRAFT_PRESENT');
        await editorPage.locator(`${WRAPPER} .link-reply__input-wrapper`).click({ timeout: 10000 });
      }
      await editor.waitFor({ state: 'visible', timeout: 10000 });
      await editor.fill(input.text, { timeout: 10000 });
      if (clean(await editor.innerText()) !== input.text) fail('SOURCE_CHANGED');
      await verifyDom(); check();
      const send = editorPage.locator(SEND);
      if (await send.count() !== 1 || clean(await send.innerText()) !== '发送' || !await send.isVisible()) fail('COMMENT_UNAVAILABLE');
      const receipt = editorPage.waitForResponse(response => response.request() === permittedRequest, { timeout: 30000 });
      const observed = receipt.catch(error => { throw error; });
      // Observe rejection immediately while click waits for its routed request.
      observed.catch(() => {});
      armed = true;
      await send.click({ timeout: 45000 });
      const response = await observed;
      check();
      if (!approved || !postAttempted || routeError) fail(routeError || 'RECEIPT_UNCONFIRMED');
      const replyId = receiptId(await responseJson(response), input, operation);
      check();
      lastError = null;
      result = { outcome: 'sent', receipt: { confirmation: operation === 'reply' ? 'reply_receipt' : 'comment_receipt', replyId } };
      }
    } catch (error) {
      lastError = routeError || codeOf(error);
      if (reading) readError = lastError;
      else result = { outcome: postAttempted ? 'unknown' : 'failed', code: lastError };
    } finally {
      armed = false; clearTimeout(timer); input.signal?.removeEventListener('abort', abort);
      try { await closeContext(); }
      catch { if (reading) readError = 'BROWSER_CLOSE_FAILED'; else result = { outcome: postAttempted ? 'unknown' : 'failed', code: 'BROWSER_CLOSE_FAILED' }; }
      await Promise.allSettled([...observations]);
      busy = false; if (controller === current) controller = undefined; finish();
    }
    if (reading && readError) fail(readError);
    return result;
  }
  return {
    status: () => ({ busy, stopped, browserOpen: Boolean(context), closing: Boolean(closing), available: !stopped && !blocked, error: lastError }),
    reply: input => run('reply', input), comment: input => run('comment', input),
    readOwnPostUrls: options => run('readOwn', options || {}),
    readDiscussion: (url, options = {}) => run('readDiscussion', { ...options, url }),
    cancel() { controller?.abort(); void closeContext().catch(() => {}); },
    async stop() { stopped = true; controller?.abort(); await closeContext(); await drained; await closeContext(); },
  };
}
