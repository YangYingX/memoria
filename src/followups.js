export function followupView(store, row) {
  if (!row) return null;
  const memory = store.getMemory(row.memoryId);
  return { id: row.id, memoryId: row.memoryId, title: (memory?.title || '已结束的约定').slice(0, 80),
    dueAt: row.dueAt, expiresAt: row.expiresAt, status: row.status };
}

export function createFollowupActions({ store, getRecipient, cancel, signal, assertActive, clock = Date.now }) {
  const check = () => { signal?.throwIfAborted(); assertActive?.(); };
  function status() {
    const config = store.getSetting('proactive'), qq = store.getSetting('qq');
    return { enabled: config.enabled === true && qq.enabled === true, timeZone: config.timeZone,
      now: new Date(clock()).toISOString(), earliestDelaySeconds: 60, maxDays: 366, expiresAfterHours: 24,
      ready: Boolean(config.desire > 0 && config.dailyLimit > 0 && getRecipient() && store.getSetting('model')?.apiKey),
      startHour: config.startHour, endHour: config.endHour, idleMinutes: config.idleMinutes, cooldownMinutes: config.cooldownMinutes };
  }
  const result = row => ({ ok: Boolean(row), followup: followupView(store, row), ...status() });
  const recipient = () => {
    const current = getRecipient();
    if (!current) throw new Error('请先验证创建人 QQ 账号并启用 QQ 接入，再安排跟进。');
    return current.accountId;
  };
  return {
    status,
    list() { check(); return { ok: true, followups: store.listFollowups({ limit: 20 }).map(row => followupView(store, row)), ...status() }; },
    schedule(input) {
      check();
      const row = store.scheduleFollowup({ ...input, recipientAccountId: recipient(), now: clock() });
      cancel();
      return result(row);
    },
    cancel(id) { check(); const row = store.cancelFollowup(id, clock()); cancel(); return result(row); },
    resume(id) {
      check();
      const row = store.resumeFollowup({ id, recipientAccountId: recipient(), now: clock() });
      cancel();
      return { ...result(row), ok: row?.status === 'pending' };
    },
  };
}
