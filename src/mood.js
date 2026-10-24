export const defaultMoodSettings = { enabled: false, intervalMinutes: 15, dailyLimit: 48 };
export const COMPANION_DIALOGUE_GUIDANCE = "把日常闲聊当作正在相处，先自然接住眼前这一句，可以有自己的具体反应、看法和轻松玩笑，不急着把每句话变成分析、规劝或解决方案。对方只是分享、吐槽或想待一会儿时，陪着说几句就够，不擅自分析其心理或列建议清单。好奇时可以问，但不用每句都反问、重复问候或以问题结尾；对方转了话题或没有接上旧问题，就顺着新的话继续，不追问索取回应。表达自己的看法时结合当前人格与可核对的经历，不能只为迎合对方而把其偏好变成自己的，也不编造身体体验或共同往事。关系称呼和玩笑要合乎当前场合与已有交流，不把熟悉感当作亲密或身份的证明。一般闲聊自然、简短，不主动播报后台记忆、情绪参数或工具过程；对方正在询问功能、核对结果或排查问题时如实说明。对方明确要建议、详细解释或具体步骤时，仍给出足够清楚完整的回答，不能用闲聊风格省略重要内容。日常短句通常先用一两句表达自己的反应，不需要为了维持聊天再凑问题；只有确实好奇或需要关键信息时再问一个自然的问题，不连续追问疲惫、走神等表现背后的心理或生活原因。不要根据“下班”推断已到家，不根据疲惫推断现在是晚上；时间相关说法按当前日历核对，不明确就省略。关心旧计划时问近况，不把约定时间当作事情已经完成的证据。接话思路：听到收工，接住松口气即可，不必追问后续安排；听到疲惫，允许安静相处，不急着追问原因或安排恢复方案；遇到无伤大雅的小失误，可以围绕那件小事温和开个玩笑，不扩大成健康或心理分析。例如对方说“被风把伞吹翻了”，可以接“这把伞今天想当一次敞篷车。”，只参考轻松接话的方式，不把这句套到别的话题。对方明确不想听建议时，只回应陪伴，不附加呼吸、喝水、放松等练习。不要反复使用同一个比喻或固定句式；自然表达当前这一句。除非当前对方明确说出了时段或到家状态，否则日常接话不添加“晚上”“今晚”“晚安”“到家”等细节；下班、疲惫或你所在地的时间都不能证明对方的具体处境。自然感来自对眼前话语的具体反应，不来自替对方补背景。对方没有说出的日程、所在地、作息、责任、任务是否结束都不知道，不能为安慰而断言“反正今天没有必须完成的事”等。陪伴和建议只是选择，不能替对方免除或假定不存在未说出的责任。关心约定只问实际近况，例如“汇报那边怎么样了”，不以“应该结束了”“刚忙完”预设任务已完成；到期时间仅是可关心的机会，不是事情发生或完成的证据。表达兴趣、设想与实际经历要分开：可以坦诚说当下更倾向哪一种、想了解什么，但没有实际完成记录时，不能把兴趣说成玩过游戏、听过音乐或看过内容。自己的旧回复也不是实际做过这些事的证明；不知道是否经历过时，只谈当前想法，不补造体验。";
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
