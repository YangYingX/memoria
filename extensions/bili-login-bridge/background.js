const MEMORIA_ORIGIN = 'http://127.0.0.1:3210';
const MEMORIA_PAGES = new Set([`${MEMORIA_ORIGIN}/`, `${MEMORIA_ORIGIN}/index.html`]);
const BILIBILI_URL = 'https://www.bilibili.com/';

function allowedSender(sender) {
  return sender && typeof sender === 'object' && !Array.isArray(sender)
    && sender.id === undefined && sender.frameId === 0
    && MEMORIA_PAGES.has(sender.url)
    && (sender.origin === undefined || sender.origin === MEMORIA_ORIGIN);
}

function allowedMessage(message) {
  return message && typeof message === 'object' && !Array.isArray(message)
    && Reflect.ownKeys(message).length === 1 && Object.hasOwn(message, 'action')
    && message.action === 'memoria-import-bili';
}

function validCookies(session, account, csrf, device) {
  return session && session.name === 'SESSDATA'
    && typeof session.value === 'string' && session.value.length > 0 && session.value.length < 4096
    && !/[\s\u0000-\u001f\u007f;]/u.test(session.value)
    && account && account.name === 'DedeUserID'
    && typeof account.value === 'string' && /^[1-9]\d{0,19}$/.test(account.value)
    && (csrf === null || csrf === undefined || csrf.name === 'bili_jct' && typeof csrf.value === 'string' && /^[0-9a-f]{32}$/i.test(csrf.value))
    && (device === null || device === undefined || device.name === 'buvid3' && typeof device.value === 'string' && device.value.length > 0 && device.value.length <= 512
      && /^[\x21-\x7e]+$/.test(device.value) && !/[;,"\\]/.test(device.value));
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  const reply = response => { try { sendResponse(response); } catch { /* The requesting page may have closed. */ } };
  if (!allowedSender(sender)) {
    reply({ ok: false, error: 'BILI_BRIDGE_DENIED' });
    return false;
  }
  if (!allowedMessage(message)) {
    reply({ ok: false, error: 'BILI_BRIDGE_INVALID_REQUEST' });
    return false;
  }
  // The manifest match cannot restrict a port; the sender check above does.
  (async () => {
    try {
      const [session, account, csrf, device] = await Promise.all([
        chrome.cookies.get({ url: BILIBILI_URL, name: 'SESSDATA' }),
        chrome.cookies.get({ url: BILIBILI_URL, name: 'DedeUserID' }),
        chrome.cookies.get({ url: BILIBILI_URL, name: 'bili_jct' }),
        chrome.cookies.get({ url: BILIBILI_URL, name: 'buvid3' }),
      ]);
      if (!validCookies(session, account, csrf, device)) return { ok: false, error: 'BILI_BRIDGE_NOT_LOGGED_IN' };
      return { ok: true, credentials: { sessdata: session.value, accountId: account.value,
        ...(csrf ? { biliJct: csrf.value } : {}), ...(device ? { buvid3: device.value } : {}) } };
    } catch {
      return { ok: false, error: 'BILI_BRIDGE_UNAVAILABLE' };
    }
  })().then(reply);
  return true;
});
