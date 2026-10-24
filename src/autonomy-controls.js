import { defaultAutonomySettings } from './autonomy.js';
import { defaultBookSettings } from './book-jobs.js';
import { defaultExpressionSettings } from './self-expression.js';

const KEYS = ['autonomy', 'books', 'selfExpression'];
const record = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export function normalizeAutonomyControlPatch(value) {
  if (!record(value)) throw new Error('自主活动开关须为对象。');
  const keys = Reflect.ownKeys(value);
  if (!keys.length || keys.length > KEYS.length || keys.some(key => !KEYS.includes(key) || typeof value[key] !== 'boolean')) {
    throw new Error('仅可调整自主浏览、读书和公开表达三个布尔开关。');
  }
  return Object.fromEntries(KEYS.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
}

export function createAutonomyControlActions({ store, cancel = () => {}, signal, assertActive }) {
  const settings = () => ({ autonomy: store.getSetting('autonomy', defaultAutonomySettings),
    books: store.getSetting('books', defaultBookSettings), selfExpression: store.getSetting('selfExpression', defaultExpressionSettings) });
  const expectedSettings = structuredClone(settings());
  const check = () => { signal?.throwIfAborted(); assertActive?.(); };
  function status() {
    check();
    const current = settings();
    if (KEYS.some(key => !record(current[key]) || typeof current[key].enabled !== 'boolean')) throw new Error('当前自主活动开关设置无效，请在后台核对。');
    return Object.fromEntries(KEYS.map(key => [key, current[key].enabled]));
  }
  return {
    status,
    update(patch, { sourceEventId }) {
      check();
      patch = normalizeAutonomyControlPatch(patch);
      const current = status(), changed = KEYS.filter(key => Object.hasOwn(patch, key) && current[key] !== patch[key]);
      check();
      store.updateAutonomyControls({ patch, sourceEventId, expectedSettings });
      if (changed.length) cancel(changed);
      return status();
    },
  };
}
