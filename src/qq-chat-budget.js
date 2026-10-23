export const defaultQQChatLimit = 200;

export function normalizeQQChatLimit(value = defaultQQChatLimit) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1000) throw new Error('QQ 每日聊天上限须为 0–1000 的整数。');
  return value;
}

function timestamp(value, day) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && value.startsWith(`${day}T`) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? value : '';
}

export function createQQChatBudget({ store, clock = Date.now }) {
  function current(stamp) {
    const day = stamp.slice(0, 10);
    const dailyLimit = normalizeQQChatLimit(store.getSetting('qq', {})?.dailyChatLimit);
    const saved = store.getSetting('qqChatStatus', {}) || {};
    const sameDay = saved.day === day;
    const attempts = sameDay && Number.isSafeInteger(saved.attempts) && saved.attempts >= 0 ? saved.attempts : 0;
    return { day, timeZone: 'UTC', dailyLimit, attempts, remaining: Math.max(0, dailyLimit - attempts),
      lastAttemptAt: sameDay ? timestamp(saved.lastAttemptAt, day) : '',
      lastLimitedAt: sameDay ? timestamp(saved.lastLimitedAt, day) : '' };
  }

  return {
    status() { return current(new Date(clock()).toISOString()); },
    reserve() {
      const stamp = new Date(clock()).toISOString();
      const status = current(stamp);
      const allowed = status.remaining > 0;
      const firstLimited = !allowed && !status.lastLimitedAt;
      if (!allowed && !firstLimited) return { allowed, firstLimited, ...status };
      const next = { ...status, attempts: status.attempts + Number(allowed),
        remaining: allowed ? status.remaining - 1 : 0,
        lastAttemptAt: allowed ? stamp : status.lastAttemptAt,
        lastLimitedAt: firstLimited ? stamp : status.lastLimitedAt };
      store.setSetting('qqChatStatus', { day: next.day, attempts: next.attempts,
        lastAttemptAt: next.lastAttemptAt, lastLimitedAt: next.lastLimitedAt });
      return { allowed, firstLimited, ...next };
    },
  };
}
