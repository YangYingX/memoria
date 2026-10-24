import { defaultAutonomySettings } from './autonomy.js';
import { defaultBookSettings } from './book-jobs.js';
import { defaultExpressionSettings } from './self-expression.js';

const KEYS = ['autonomy', 'books', 'selfExpression'];
export const expressionControlFields = { expressionDesire: 'desire', expressionDailyLimit: 'dailyLimit', expressionCooldownMinutes: 'cooldownMinutes' };
const RANGES = { expressionDesire: [0, 100], expressionDailyLimit: [0, 100], expressionCooldownMinutes: [60, 1440] };
const record = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export function normalizeAutonomyControlPatch(value) {
  if (!record(value)) throw new Error('自主活动偏好须为对象。');
  const keys = Reflect.ownKeys(value);
  if (!keys.length || keys.length > KEYS.length + Object.keys(RANGES).length || keys.some(key => KEYS.includes(key)
    ? typeof value[key] !== 'boolean' : !Object.hasOwn(RANGES, key) || !Number.isSafeInteger(value[key]) || value[key] < RANGES[key][0] || value[key] > RANGES[key][1])) {
    throw new Error('仅可调整三个总开关、公开表达欲（0–100）、全平台每日公开发布上限（0–100）或间隔（60–1440分钟）。');
  }
  return Object.fromEntries([...KEYS, ...Object.keys(RANGES)].filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
}

export function autonomyControlValues(settings) {
  if (KEYS.some(key => !record(settings?.[key]) || typeof settings[key].enabled !== 'boolean')) throw new Error('当前自主活动设置无效，请在后台核对。');
  return normalizeAutonomyControlPatch({ ...Object.fromEntries(KEYS.map(key => [key, settings[key].enabled])),
    ...Object.fromEntries(Object.entries(expressionControlFields).map(([key, field]) => [key, settings.selfExpression[field] ?? defaultExpressionSettings[field]])) });
}

export function createAutonomyControlActions({ store, cancel = () => {}, signal, assertActive }) {
  const settings = () => ({ autonomy: store.getSetting('autonomy', defaultAutonomySettings),
    books: store.getSetting('books', defaultBookSettings), selfExpression: store.getSetting('selfExpression', defaultExpressionSettings) });
  const expectedSettings = structuredClone(settings());
  const check = () => { signal?.throwIfAborted(); assertActive?.(); };
  function status() {
    check();
    return autonomyControlValues(settings());
  }
  return {
    status,
    update(patch, { sourceEventId, expectedText }) {
      check();
      patch = normalizeAutonomyControlPatch(patch);
      const current = status(), changed = KEYS.filter(key => Object.hasOwn(patch, key) && current[key] !== patch[key]);
      if (!changed.includes('selfExpression') && Object.keys(expressionControlFields).some(key => Object.hasOwn(patch, key) && current[key] !== patch[key])) changed.push('selfExpression');
      check();
      store.updateAutonomyControls({ patch, sourceEventId, expectedSettings, expectedText });
      if (changed.length) cancel(changed);
      return status();
    },
  };
}
