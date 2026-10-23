import { defaultProactiveSettings, normalizeProactiveSettings } from './proactive.js';

const FIELDS = ['enabled', 'desire', 'dailyLimit', 'cooldownMinutes'];

export function normalizeCompanionPreferencePatch(value) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('陪伴偏好须为对象。');
  const keys = Reflect.ownKeys(value);
  if (!keys.length || keys.length > FIELDS.length || keys.some(key => !FIELDS.includes(key))) throw new Error('仅可调整主动私聊开关、表达欲、每日条数和冷却时间。');
  const normalized = normalizeProactiveSettings(value);
  return Object.fromEntries(FIELDS.filter(key => Object.hasOwn(value, key)).map(key => [key, normalized[key]]));
}

export function companionPreferenceValues(settings) {
  const config = normalizeProactiveSettings({}, settings);
  return Object.fromEntries(FIELDS.map(key => [key, config[key]]));
}

export function createCompanionPreferenceActions({ store, cancel = () => {}, signal, assertActive, getReadiness = () => false }) {
  const expectedSettings = structuredClone(store.getSetting('proactive', defaultProactiveSettings));
  const check = () => { signal?.throwIfAborted(); assertActive?.(); };
  function status() {
    check();
    const preferences = companionPreferenceValues(store.getSetting('proactive', defaultProactiveSettings));
    let available = false;
    try { available = getReadiness() === true; } catch {}
    return { ...preferences, ready: Boolean(preferences.enabled && preferences.desire > 0 && preferences.dailyLimit > 0 && available) };
  }
  return {
    status,
    update(patch, { sourceEventId }) {
      check();
      patch = normalizeCompanionPreferencePatch(patch);
      cancel();
      check();
      store.updateProactivePreferences({ patch, sourceEventId, expectedSettings });
      return status();
    },
  };
}
