import { normalizeHeyboxCredentials } from './heybox-credentials.js';

// The official website restores the current session without selecting a target user.
export async function verifyHeyboxSession(input, { expectedAccountId, signal, request = fetch } = {}) {
  const failure = () => new Error('未能核验小黑盒当前登录账号，请在专用窗口完成正常登录与验证后重试。');
  try {
    const credentials = normalizeHeyboxCredentials(input, { expectedAccountId });
    const active = signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
    active.throwIfAborted();
    const url = new URL('https://api.xiaoheihe.cn/account/restore_login');
    for (const [key, value] of Object.entries({ app: 'heybox', os_type: 'web', x_app: 'heybox_website',
      x_client_type: 'weboutapp', x_os_type: process.platform === 'win32' ? 'Windows' : 'Linux' })) url.searchParams.set(key, value);
    const response = await request(url, { method: 'GET', redirect: 'error', signal: active,
      headers: { Cookie: credentials.cookie, Accept: 'application/json', Origin: 'https://www.xiaoheihe.cn',
        Referer: 'https://www.xiaoheihe.cn/app/bbs/home' } });
    if (!response.ok || response.redirected) {
      await response.body?.cancel();
      throw failure();
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      active.throwIfAborted();
      size += chunk.length;
      if (size > 1024 * 1024) throw failure();
      chunks.push(chunk);
    }
    active.throwIfAborted();
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    let accountId = value?.result?.account_detail?.userid;
    if (typeof accountId === 'number' && Number.isSafeInteger(accountId) && accountId > 0) accountId = String(accountId);
    if (value?.status !== 'ok' || typeof accountId !== 'string' || !/^[1-9]\d{0,19}$/.test(accountId)
      || accountId !== credentials.accountId) throw failure();
    return { accountId, verifiedAt: new Date().toISOString() };
  } catch {
    throw failure();
  }
}
