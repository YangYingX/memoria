import { normalizeProactiveSettings } from './proactive.js';

export function followupView(store, row) {
  if (!row) return null;
  const memory = store.getMemory(row.memoryId);
  return { id: row.id, memoryId: row.memoryId, title: (memory?.title || '已结束的约定').slice(0, 80),
    dueAt: row.dueAt, expiresAt: row.expiresAt, status: row.status };
}

export function createFollowupActions({ store, getRecipient, cancel, signal, assertActive, clock = Date.now }) {
  const check = () => { signal?.throwIfAborted(); assertActive?.(); };
  function status() {
    const config = normalizeProactiveSettings({}, store.getSetting('proactive', {})), current = getRecipient();
    const time = Number(clock()), quiet = Boolean(config.quietUntil && time < Date.parse(config.quietUntil));
    return { enabled: config.enabled === true && Boolean(current), timeZone: config.timeZone,
      now: new Date(time).toISOString(), quietUntil: config.quietUntil, quiet, earliestDelaySeconds: 60, maxDays: 366, expiresAfterHours: 24,
      ready: Boolean(!quiet && config.desire > 0 && config.dailyLimit > 0 && current && store.getSetting('model')?.apiKey),
      startHour: config.startHour, endHour: config.endHour, idleMinutes: config.idleMinutes, cooldownMinutes: config.cooldownMinutes };
  }
  const result = row => ({ ok: Boolean(row), followup: followupView(store, row), ...status() });
  const recipient = (sourceEventId, allowLegacyQQ = false) => {
    const current = getRecipient(sourceEventId, allowLegacyQQ);
    if (!current) throw new Error('请先在原私聊渠道验证创建人账号并启用该渠道，再安排跟进。');
    return current.accountId;
  };
  return {
    status,
    list() { check(); return { ok: true, followups: store.listFollowups({ limit: 20 }).map(row => followupView(store, row)), ...status() }; },
    schedule(input) {
      check();
      const row = store.scheduleFollowup({ ...input, recipientAccountId: recipient(input.sourceEventId), now: clock() });
      cancel();
      return result(row);
    },
    pause(id) {
      check(); const row = store.pauseFollowup(id, clock()); cancel();
      return { ...result(row), ok: row?.status === 'paused' };
    },
    cancel(id) { check(); const row = store.cancelFollowup(id, clock()); cancel(); return result(row); },
    resume(id) {
      check();
      const previous = store.getFollowup(id);
      if (!previous) return result(null);
      const row = store.resumeFollowup({ id, recipientAccountId: recipient(previous.sourceEventId, true), now: clock() });
      cancel();
      return { ...result(row), ok: row?.status === 'pending' };
    },
  };
}
