import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new Error('管理密码须为 12–256 个字符。');
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}

export function verifyPassword(password, saved) {
  if (typeof password !== 'string' || password.length > 256 || !saved) return false;
  return sameSecret(scryptSync(password, saved.salt, 64).toString('hex'), saved.hash);
}

export function createSessions() {
  const sessions = new Map();
  const get = req => {
    const token = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('persona_session='))?.slice(16);
    if (!token) return null;
    const expiry = sessions.get(token);
    if (!expiry || expiry < Date.now()) { sessions.delete(token); return null; }
    return token;
  };
  return {
    get,
    start(res) {
      for (const [token, expiry] of sessions) if (expiry < Date.now()) sessions.delete(token);
      const token = randomBytes(32).toString('hex');
      sessions.set(token, Date.now() + 8 * 3600000);
      res.setHeader('Set-Cookie', `persona_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
    },
    end(req, res) {
      sessions.delete(get(req));
      res.setHeader('Set-Cookie', 'persona_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    },
  };
}
