export const defaultMoodSettings = { enabled: false, intervalMinutes: 180, dailyLimit: 4 };

const settingsKeys = Object.keys(defaultMoodSettings);
const stateKeys = ['schemaVersion', 'value', 'emotion', 'confidence', 'updatedAt'];
const labels = { calm: '平静', happy: '开心', curious: '好奇', worried: '担心', sad: '低落' };
const baseline = { schemaVersion: 1, value: 70, emotion: 'calm', confidence: 100, updatedAt: null };
const HALF_LIFE_MS = 3 * 60 * 60 * 1000;

function invalid(message) { const error = new Error(message); error.validation = true; throw error; }
function fields(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Object.keys(value).every(key => allowed.includes(key));
}
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const emotion = value => typeof value === 'string' && Object.hasOwn(labels, value);

export function normalizeMoodSettings(input = {}, previous = {}) {
  if (!fields(input, settingsKeys) || !fields(previous, settingsKeys)) invalid('心情设置只接受启用状态、评估间隔和每日上限。');
  const next = { ...defaultMoodSettings, ...previous, ...input };
  if (typeof next.enabled !== 'boolean' || !integer(next.intervalMinutes, 60, 1440) || !integer(next.dailyLimit, 0, 12)) {
    invalid('心情评估间隔须为60–1440分钟，每日上限须为0–12，启用状态须为布尔值。');
  }
  return next;
}

export function normalizeMoodState(value) {
  if (value === null) return { ...baseline };
  if (!fields(value, stateKeys) || stateKeys.some(key => !Object.hasOwn(value, key))
    || value.schemaVersion !== 1 || !Number.isFinite(value.value) || value.value < 0 || value.value > 100
    || !emotion(value.emotion) || !integer(value.confidence, 0, 100)) invalid('心情状态格式无效。');
  if (value.updatedAt !== null && (typeof value.updatedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.updatedAt)
    || !Number.isFinite(Date.parse(value.updatedAt)) || new Date(value.updatedAt).toISOString() !== value.updatedAt)) invalid('心情更新时间须为有效ISO时间。');
  return Object.fromEntries(stateKeys.map(key => [key, value[key]]));
}

function instant(now) {
  if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime())) invalid('心情状态的计算时间无效。');
  return now;
}

function snapshot(state, now) {
  instant(now);
  if (state.updatedAt === null) return { value: 70, emotion: 'calm', label: labels.calm, confidence: 100, updatedAt: null };
  const elapsed = Math.max(0, now - Date.parse(state.updatedAt));
  const value = 70 + (state.value - 70) * 2 ** (-elapsed / HALF_LIFE_MS);
  const currentEmotion = elapsed >= 2 * HALF_LIFE_MS ? 'calm' : state.emotion;
  return { value, emotion: currentEmotion, label: labels[currentEmotion], confidence: state.confidence, updatedAt: state.updatedAt };
}

export function moodSnapshot(store, now = Date.now()) {
  return snapshot(normalizeMoodState(store.getSetting('moodState', null)), now);
}

export function validateMoodDelta(value) {
  if (!fields(value, ['delta', 'emotion', 'confidence']) || !integer(value.delta, -10, 10)
    || !emotion(value.emotion) || !integer(value.confidence, 0, 100)) invalid('心情变化须为-10至10的整数，并包含有效情绪和0–100的整数置信度。');
  return { delta: value.delta, emotion: value.emotion, confidence: value.confidence };
}

export function applyMoodDelta(store, proposal, { now = Date.now(), expectedState } = {}) {
  const change = validateMoodDelta(proposal);
  const raw = store.getSetting('moodState', null);
  if (expectedState !== undefined && JSON.stringify(raw) !== JSON.stringify(expectedState)) {
    const error = new Error('心情状态已变化，本次评估未应用。'); error.code = 'MOOD_CONFLICT'; throw error;
  }
  const current = snapshot(normalizeMoodState(raw), now);
  if (change.confidence < 60) return { applied: false, state: current };
  const state = normalizeMoodState({ schemaVersion: 1, value: Math.max(0, Math.min(100, current.value + change.delta)),
    emotion: change.emotion, confidence: change.confidence, updatedAt: new Date(now).toISOString() });
  store.setSetting('moodState', state);
  return { applied: true, state: snapshot(state, now) };
}
