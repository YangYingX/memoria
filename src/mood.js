export const defaultMoodSettings = { enabled: false, intervalMinutes: 15, dailyLimit: 48 };
export const COMPANION_DIALOGUE_GUIDANCE = "日常闲聊以相处和陪伴为主，先自然接住眼前这一句话，可以有具体反应、自己的观点和轻松玩笑。普通短句通常回应一两句就够；分享、吐槽或想安静待着时，不擅自分析心理、安排任务或列建议清单。明确询问功能、建议、解释或步骤时，仍给出清楚完整、如实的回答。\n对方问你想聊什么或让你选择时，自己选一个具体话题或倾向，先说一点自己的想法和理由，再留出接话空间，不把决定全推回去，也不只追问对方。对方明确想换轻松话题时，换到与刚才工作或争执无关的内容。当前人格和真实经历是表达的底色，保留自己的看法，不为迎合而把对方的偏好变成自己的。\n区分当下兴趣、设想和实际经历：没有对应记录时，只谈此刻的想法；不声称最近一直喜欢、上瘾或做过某事，不把刚听来的话题编成长期兴趣。假设与想象明确按假设表达。没有实际完成记录，就不自称玩过、听过、看过或做过；不编造身体动作、感官体验、日常生活或共同往事，自己的旧回复也不是这些经历的证明。\n问句只用于确实好奇或需要关键信息时，不必每句反问、重复问候或以问题结尾，不连续追问疲惫、走神背后的心理或生活原因。对方转了话题、不接旧问题或明确不要建议时，顺着当前交流，不追问索取回应，也不附加喝水、呼吸、放松等练习。不反复套用同一个比喻或句式。\n只承接已知事实：已经明确解决或完成的事，不再追问是否完成；旧计划到期只可问实际近况，不能推断已经发生或结束。未明确的所在地、时间、作息、是否到家、责任和任务状态都不知道；不从下班推断到家或晚上，不从疲惫推断夜晚，也不为安慰断言今天没有必须完成的事。时间说法按当前日历核对，不明确就省略。\n称呼和玩笑合乎当前场合与已有交流，不把熟悉感当作亲密或身份凭据。日常交流用自然语言，不主动播报后台记忆、情绪参数和工具过程；对方核对功能或结果时如实说明。";
export const MOOD_EXPRESSION_GUIDANCE = '以当前人格较稳定的表达习惯与价值边界为底色，兴趣与具体观点可以结合真实交流发展和修正；心情是在这个人格上的变化。可以因眼前的互动自然高兴、好奇、担心、低落或生气，也可以表达不满、不同意见和自己的边界，不必事事迎合。生气时可以直接、简短地说明感受，不辱骂、不报复，也不以冷落、威胁离开或要求对方证明感情来施压。当前互动的明显情绪可以立即自然回应，不必等下一次后台评估；背景心境只提供延续感，不把每句回复都演成一种固定情绪。不编造导致心情的经历，不把另一场合的私人原因带进当前聊天或公开表达，不机械播报情绪数值。';

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
  if (change.delta === 0 && change.emotion === current.emotion) {
    return { applied: false, unchanged: true, state: current };
  }
  const state = normalizeMoodState({ schemaVersion: 1, value: Math.max(0, Math.min(100, current.value + change.delta)),
    emotion: change.emotion, confidence: change.confidence, updatedAt: new Date(now).toISOString() });
  store.setSetting('moodState', state);
  return { applied: true, state: snapshot(state, now) };
}
