import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { normalizeHeyboxCredentials, readHeyboxCredentials } from './heybox-credentials.js';

const HOME = 'https://www.xiaoheihe.cn/app/bbs/home';
const COOKIE_URLS = [HOME, 'https://api.xiaoheihe.cn/'];
const COOKIE_DOMAINS = new Set(['xiaoheihe.cn', 'www.xiaoheihe.cn', 'api.xiaoheihe.cn']);

// This browser belongs to the platform execution account, never to the creator's identity binding.
export function createHeyboxAccount({ dataDir, getExpectedAccountId = () => undefined }) {
  if (typeof dataDir !== 'string' || !dataDir.trim() || typeof getExpectedAccountId !== 'function') throw new Error('小黑盒专用账号需要本地数据目录和有效的账号检查方式。');
  const directory = resolve(dataDir);
  const credentialsPath = join(directory, 'heybox-credentials.json');
  const profilePath = join(directory, 'heybox-browser');
  let context, startPromise, confirmPromise, closePromise, generation = 0;

  function status() {
    let credentials;
    try { credentials = readHeyboxCredentials({ dataDir: directory, expectedAccountId: getExpectedAccountId() }); }
    catch { /* Saved cookies are local configuration evidence, not a verified online session. */ }
    return { configured: Boolean(credentials), browserOpen: Boolean(context), ...(credentials ? { accountId: credentials.accountId } : {}) };
  }

  function saveCredentials(value, expectedAccountId) {
    const credentials = normalizeHeyboxCredentials(value, { expectedAccountId });
    let temporary, file, owned = false;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const previous = lstatSync(credentialsPath, { throwIfNoEntry: false });
      if (previous && (!previous.isFile() || previous.isSymbolicLink())) throw new Error('INVALID_CREDENTIAL_FILE');
      temporary = join(directory, `.heybox-credentials-${randomUUID()}.tmp`);
      file = openSync(temporary, 'wx', 0o600);
      owned = true;
      writeFileSync(file, JSON.stringify(credentials), 'utf8');
      closeSync(file); file = undefined;
      renameSync(temporary, credentialsPath);
    } finally {
      if (file !== undefined) { try { closeSync(file); } catch {} }
      if (owned) { try { rmSync(temporary, { force: true }); } catch {} }
    }
  }

  function close() {
    if (closePromise) return closePromise;
    generation++;
    const pendingStart = startPromise;
    closePromise = (async () => {
      await pendingStart?.catch(() => {});
      const opened = context;
      if (opened) {
        try {
          await opened.close();
          if (context === opened) context = undefined;
        } catch { /* Keep tracking a browser that failed to close. */ }
      }
    })().finally(() => { closePromise = undefined; });
    return closePromise;
  }

  function openLogin() {
    if (confirmPromise) return Promise.reject(new Error('正在确认小黑盒专用账号登录，请稍候。'));
    if (startPromise) return startPromise;
    const pendingClose = closePromise;
    startPromise = (async () => {
      await pendingClose;
      let opened = context;
      try {
        if (!opened) {
          mkdirSync(profilePath, { recursive: true, mode: 0o700 });
          opened = await chromium.launchPersistentContext(profilePath, {
            headless: false, chromiumSandbox: true, acceptDownloads: false, permissions: [], timeout: 15000,
            ...(process.platform === 'win32' ? { channel: 'chrome' } : {}),
          });
          context = opened;
          opened.once('close', () => { if (context === opened) context = undefined; });
          const page = opened.pages().find(candidate => !candidate.isClosed()) || await opened.newPage();
          await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.bringToFront();
        } else {
          const page = opened.pages().find(candidate => !candidate.isClosed()) || await opened.newPage();
          await page.bringToFront();
        }
        return status();
      } catch {
        if (opened) {
          try {
            await opened.close();
            if (context === opened) context = undefined;
          } catch { /* Retain a context that still needs manual closing. */ }
        }
        throw new Error(process.platform === 'win32'
          ? '小黑盒专用登录窗口未能打开；请确认已安装 Google Chrome，并在本机桌面会话中重试。'
          : '小黑盒专用登录窗口未能打开；请运行 npx playwright install chromium 安装完整浏览器，并在图形桌面会话中重试。');
      }
    })().finally(() => { startPromise = undefined; });
    return startPromise;
  }

  function confirmLogin() {
    if (confirmPromise) return confirmPromise;
    const pendingStart = startPromise, pendingClose = closePromise, expectedGeneration = generation;
    confirmPromise = (async () => {
      try {
        const expectedAccountId = getExpectedAccountId();
        await pendingClose;
        await pendingStart;
        const opened = context;
        if (!opened || generation !== expectedGeneration) throw new Error('LOGIN_WINDOW_REQUIRED');
        const cookies = await opened.cookies(COOKIE_URLS);
        if (!Array.isArray(cookies) || cookies.length > 128) throw new Error('INVALID_COOKIES');
        const entries = [];
        for (const item of cookies) {
          if (!item || typeof item.domain !== 'string' || !COOKIE_DOMAINS.has(item.domain.replace(/^\./, '').toLowerCase())) throw new Error('UNEXPECTED_COOKIE_DOMAIN');
          if (typeof item.name !== 'string' || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/.test(item.name)
            || typeof item.value !== 'string' || !/^[\x21-\x7e]*$/.test(item.value) || /[",;\\]/.test(item.value)) throw new Error('INVALID_COOKIES');
          entries.push(`${item.name}=${item.value}`);
        }
        const credentials = normalizeHeyboxCredentials({ accountId: cookies.find(item => item.name === 'heybox_id')?.value, cookie: entries.join('; ') }, { expectedAccountId });
        if (context !== opened || generation !== expectedGeneration || closePromise || getExpectedAccountId() !== expectedAccountId) throw new Error('LOGIN_CONTEXT_CHANGED');
        saveCredentials(credentials, expectedAccountId);
      } catch {
        throw new Error('未保存小黑盒专用账号；请在专用窗口完成正常登录和验证，并核对执行账号后重新确认。');
      } finally {
        await close();
      }
      return status();
    })().finally(() => { confirmPromise = undefined; });
    return confirmPromise;
  }

  return { status, openLogin, confirmLogin, close };
}
