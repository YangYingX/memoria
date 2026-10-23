export const FOLLOWUP_STATUSES = Object.freeze(['pending', 'paused', 'deciding', 'attempted', 'sent', 'unknown', 'cancelled', 'expired', 'invalidated']);
export const FOLLOWUP_TERMINAL_STATUSES = Object.freeze(['sent', 'unknown', 'cancelled', 'expired', 'invalidated']);
export const FOLLOWUP_DAY_MS = 86400000;

function invalid(message) {
  const error = new Error(message);
  error.validation = true;
  throw error;
}

export function followupTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) invalid('跟进时间须为标准 UTC ISO 时间。');
  const time = new Date(value);
  if (!Number.isFinite(time.getTime()) || time.toISOString() !== value) invalid('跟进时间无效。');
  return value;
}

export function followupClock(value) {
  if (!Number.isSafeInteger(value)) invalid('跟进时钟须为毫秒时间戳。');
  let stamp;
  try { stamp = new Date(value).toISOString(); } catch { invalid('跟进时钟无效。'); }
  return followupTimestamp(stamp);
}

export function normalizeFollowupRecord(value) {
  const fields = ['id', 'memoryId', 'sourceEventId', 'recipientAccountId', 'dueAt', 'expiresAt', 'nextDecisionAt', 'status', 'revision', 'decisionAttempts', 'createdAt', 'updatedAt'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) invalid('跟进记录字段无效。');
  for (const key of ['id', 'memoryId', 'sourceEventId', 'recipientAccountId']) {
    if (typeof value[key] !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,127}$/.test(value[key])) invalid('跟进记录的关联标识无效。');
  }
  if (!FOLLOWUP_STATUSES.includes(value.status) || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !Number.isSafeInteger(value.decisionAttempts) || value.decisionAttempts < 0 || value.decisionAttempts > 3
    || (['deciding', 'attempted', 'sent'].includes(value.status) && !value.decisionAttempts)) invalid('跟进记录状态或版本无效。');
  for (const key of ['dueAt', 'expiresAt', 'nextDecisionAt', 'createdAt', 'updatedAt']) followupTimestamp(value[key]);
  const due = Date.parse(value.dueAt), created = Date.parse(value.createdAt);
  if (due < created + 60000 || due > created + 366 * FOLLOWUP_DAY_MS || Date.parse(value.expiresAt) !== due + FOLLOWUP_DAY_MS
    || value.updatedAt < value.createdAt || value.nextDecisionAt < value.dueAt || value.nextDecisionAt > value.expiresAt) invalid('跟进记录的时间顺序无效。');
  return Object.fromEntries(fields.map(key => [key, value[key]]));
}
