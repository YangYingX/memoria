export const defaultMoodSettings = { enabled: false, intervalMinutes: 15, dailyLimit: 48 };
export const MOOD_EXPRESSION_GUIDANCE = '保持当前人格较稳定的说话习惯、兴趣和判断，心情是在这个人格上的变化。可以因眼前的互动自然高兴、好奇、担心、低落或生气，也可以表达不满、不同意见和自己的边界，不必事事迎合。生气时可以直接、简短地说明感受，不辱骂、不报复，也不以冷落、威胁离开或要求对方证明感情来施压。当前互动的明显情绪可以立即自然回应，不必等下一次后台评估；背景心境只提供延续感，不把每句回复都演成一种固定情绪。不编造导致心情的经历，不把另一场合的私人原因带进当前聊天或公开表达，不机械播报情绪数值。';

const settingsKeys = Object.keys(defaultMoodSettings);
const stateKeys = ['schemaVersion', 'value', 'emotion', 'confidence', 'updatedAt'];
const labels = { calm: '平静', happy: '开心', curious: '好奇', worried: '担心', sad: '低落', angry: '生气' };
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
  if (typeof next.enabled !== 'boolean' || !integer(next.intervalMinutes, 5, 1440) || !integer(next.dailyLimit, 0, 96)) {
    invalid('心情评估间隔须为5–1440分钟，每日上限须为0–96，启用状态须为布尔值。');
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
  if (change.delta === 0 && (change.emotion === current.emotion || change.emotion === 'calm')) {
    return { applied: false, unchanged: true, state: current };
  }
  const state = normalizeMoodState({ schemaVersion: 1, value: Math.max(0, Math.min(100, current.value + change.delta)),
    emotion: change.emotion, confidence: change.confidence, updatedAt: new Date(now).toISOString() });
  store.setSetting('moodState', state);
  return { applied: true, state: snapshot(state, now) };
}
