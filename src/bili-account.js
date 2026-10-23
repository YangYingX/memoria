import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HOME = 'https://www.bilibili.com/';

function validCredentials(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => ['sessdata', 'accountId'].includes(key))
    && typeof value.sessdata === 'string' && value.sessdata.length > 0 && value.sessdata.length < 4096
    && !/[\0\r\n;]/.test(value.sessdata)
    && typeof value.accountId === 'string' && /^[1-9]\d{0,19}$/.test(value.accountId);
}

// This is a dedicated platform execution account, not a binding of the creator's identity.
export function createBiliAccount({ dataDir }) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) throw new Error('B站专用账号需要本地数据目录。');
  const directory = resolve(dataDir);
  const credentialsPath = join(directory, 'bili-credentials.json');
  const profilePath = join(directory, 'bili-browser');
  let context, startPromise, confirmPromise, closePromise;

  function status() {
    let credentials;
    try {
      const file = statSync(credentialsPath, { throwIfNoEntry: false });
      if (file?.isFile() && file.size <= 32768) {
        const value = JSON.parse(readFileSync(credentialsPath, 'utf8'));
        if (validCredentials(value)) credentials = value;
      }
    } catch { /* Configuration is local evidence only; it does not prove an online login. */ }
    return { configured: Boolean(credentials), browserOpen: Boolean(context), ...(credentials ? { accountId: credentials.accountId } : {}) };
  }

  function close() {
    if (closePromise) return closePromise;
    const pendingStart = startPromise;
    closePromise = (async () => {
      await pendingStart?.catch(() => {});
      const opened = context;
      if (opened) {
        try {
          await opened.close();
          if (context === opened) context = undefined;
        } catch { /* Keep the context tracked if closing failed, so another browser is not launched. */ }
      }
    })().finally(() => { closePromise = undefined; });
    return closePromise;
  }

  function openLogin() {
    if (confirmPromise) return Promise.reject(new Error('正在确认B站专用账号登录，请稍候。'));
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
            ...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
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
          ? 'B站专用登录窗口未能打开；请确认已安装 Microsoft Edge，并在本机桌面会话中重试。'
          : 'B站专用登录窗口未能打开；请运行 npx playwright install chromium 安装完整浏览器，并在图形桌面会话中重试。');
      }
    })().finally(() => { startPromise = undefined; });
    return startPromise;
  }

  function confirmLogin() {
    if (confirmPromise) return confirmPromise;
    const pendingStart = startPromise;
    const pendingClose = closePromise;
    confirmPromise = (async () => {
      let temporary, file, owned = false;
      try {
        await pendingClose;
        await pendingStart;
        if (!context) throw new Error('LOGIN_WINDOW_REQUIRED');
        const cookies = await context.cookies(HOME);
        const credentials = { sessdata: cookies.find(cookie => cookie.name === 'SESSDATA')?.value,
          accountId: cookies.find(cookie => cookie.name === 'DedeUserID')?.value };
        if (!validCredentials(credentials)) throw new Error('LOGIN_NOT_CONFIGURED');
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        temporary = join(directory, `.bili-credentials-${randomUUID()}.tmp`);
        file = openSync(temporary, 'wx', 0o600);
        owned = true;
        writeFileSync(file, JSON.stringify(credentials), 'utf8');
        closeSync(file); file = undefined;
        renameSync(temporary, credentialsPath);
      } catch {
        throw new Error('未保存B站专用账号；请重新打开登录窗口，手动完成登录后再点击确认。');
      } finally {
        if (file !== undefined) { try { closeSync(file); } catch {} }
        if (owned) { try { rmSync(temporary, { force: true }); } catch {} }
        await close();
      }
      return status();
    })().finally(() => { confirmPromise = undefined; });
    return confirmPromise;
  }

  return { status, openLogin, confirmLogin, close };
}
