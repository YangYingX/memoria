import { defaultProactiveSettings, normalizeProactiveSettings } from './proactive.js';

const FIELDS = ['enabled', 'desire', 'dailyLimit', 'cooldownMinutes', 'startHour', 'endHour'];
const PATCH_FIELDS = [...FIELDS, 'quietMinutes'];

export function normalizeCompanionPreferencePatch(value) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('陪伴偏好须为对象。');
  const keys = Reflect.ownKeys(value);
  if (!keys.length || keys.length > PATCH_FIELDS.length || keys.some(key => !PATCH_FIELDS.includes(key))) throw new Error('仅可调整主动私聊开关、表达欲、每日条数、冷却时间、同日整点时段和免打扰时长。');
  if (Object.hasOwn(value, 'startHour') !== Object.hasOwn(value, 'endHour')) throw new Error('主动私聊时段须同时提供开始和结束整点。');
  if (Object.hasOwn(value, 'quietMinutes') && (!Number.isSafeInteger(value.quietMinutes) || value.quietMinutes < 0 || value.quietMinutes > 1440)) throw new Error('免打扰须为0至1440的整数分钟；0仅用于明确结束。');
  const normalized = normalizeProactiveSettings(value);
  return { ...Object.fromEntries(FIELDS.filter(key => Object.hasOwn(value, key)).map(key => [key, normalized[key]])),
    ...(Object.hasOwn(value, 'quietMinutes') ? { quietMinutes: value.quietMinutes } : {}) };
}

export function companionPreferenceValues(settings) {
  const config = normalizeProactiveSettings({}, settings);
  return { ...Object.fromEntries(FIELDS.map(key => [key, config[key]])), timeZone: config.timeZone, quietUntil: config.quietUntil };
}

export function createCompanionPreferenceActions({ store, cancel = () => {}, signal, assertActive, getReadiness = () => false }) {
  const expectedSettings = structuredClone(store.getSetting('proactive', defaultProactiveSettings));
  const check = () => { signal?.throwIfAborted(); assertActive?.(); };
  function status() {
    check();
    const preferences = companionPreferenceValues(store.getSetting('proactive', defaultProactiveSettings));
    let available = false;
    try { available = getReadiness() === true; } catch {}
    const quiet = Boolean(preferences.quietUntil && Date.parse(preferences.quietUntil) > Date.now());
    return { ...preferences, quiet, ready: Boolean(preferences.enabled && !quiet && preferences.desire > 0 && preferences.dailyLimit > 0 && available) };
  }
  return {
    status,
    update(patch, { sourceEventId, expectedText }) {
      check();
      patch = normalizeCompanionPreferencePatch(patch);
      store.updateProactivePreferences({ patch, sourceEventId, expectedSettings, expectedText });
      cancel();
      return status();
    },
  };
}
