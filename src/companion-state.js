const emotions = ['joy', 'trust', 'fear', 'surprise', 'sadness', 'disgust', 'anger', 'anticipation'];
const character = ['selfWorth', 'selfEfficacy', 'optimismBias', 'trustBaseline', 'attachmentAnxiety', 'reflectiveness', 'directness', 'depthPreference', 'warmth', 'vitality', 'curiosity', 'tolerance', 'impulsivity', 'rumination', 'vulnerability', 'assertiveness', 'empathy'];
const priors = { othersTrustworthy: 'others are trustworthy', worldSafety: 'the world is mostly benign' };
const stateKeys = ['version', 't', 'lastInteraction', 'lastHeartbeat', 'born', 'emotions', 'opponent', 'mood', 'personality', 'character', 'relationship', 'drives', 'beliefs', 'awareness', 'allostasis', 'rho', 'habituation', 'circadian', 'observations', 'counters', 'catastrophe', 'surpriseEma', 'seed'];

function invalid() { const error = new Error('陪伴内核状态无效；只允许有界机械数据。'); error.validation = true; throw error; }
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const present = Reflect.ownKeys(value);
  if (present.length !== keys.length || present.some(key => !keys.includes(key))) invalid();
}
function number(value, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) invalid();
}
function epoch(value) { number(value, 0, 8640000000000000, true); }
function vector(value, keys, min = 0, max = 1) { object(value, keys); for (const key of keys) number(value[key], min, max); }
function identifier(value) { if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,127}$/.test(value)) invalid(); }
function copy(value) {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > 32768) invalid();
  return JSON.parse(json);
}

// The upstream repair helper accepts arbitrary observations/topics. This boundary intentionally does not.
export function normalizeCompanionState(value) {
  if (value === null) return null;
  object(value, stateKeys);
  if (value.version !== 1 || typeof value.catastrophe !== 'boolean') invalid();
  for (const key of ['t', 'lastInteraction', 'lastHeartbeat', 'born']) epoch(value[key]);
  if (value.t < value.born || value.lastInteraction < value.born || value.lastInteraction > value.t || value.lastHeartbeat < value.born || value.lastHeartbeat > value.t) invalid();
  vector(value.emotions, emotions); vector(value.opponent, emotions);
  vector(value.mood, ['p', 'a', 'd'], -1, 1);
  vector(value.personality, ['o', 'c', 'e', 'a', 'n']);
  object(value.character, character);
  for (const key of character) number(value.character[key], key === 'optimismBias' ? -0.3 : 0, key === 'optimismBias' ? 0.3 : 1);
  object(value.relationship, ['trust', 'attachment', 'respect', 'frustration', 'familiarity', 'unanswered']);
  for (const key of ['trust', 'attachment', 'respect', 'frustration', 'familiarity']) number(value.relationship[key], 0, 1);
  number(value.relationship.unanswered, 0, 1000, true);
  vector(value.drives, ['connection', 'curiosity', 'expression', 'growth', 'rest']);
  object(value.beliefs, Object.keys(priors));
  for (const [key, label] of Object.entries(priors)) {
    const belief = value.beliefs[key];
    const keys = ['key', 'valence', 'confidence', 'count', 't', ...(Object.hasOwn(belief || {}, 'label') ? ['label'] : [])];
    object(belief, keys);
    if (belief.key !== key || (Object.hasOwn(belief, 'label') && belief.label !== label)) invalid();
    number(belief.valence, -1, 1); number(belief.confidence, 0.05, 0.95); number(belief.count, 0, Number.MAX_SAFE_INTEGER, true); epoch(belief.t);
    if (belief.t > value.t) invalid();
  }
  object(value.awareness, ['userPresence', 'socialPressure', 'thoughtSaturation']);
  number(value.awareness.userPresence, 0, 1); number(value.awareness.socialPressure, -1, 1); number(value.awareness.thoughtSaturation, 0, 1);
  object(value.allostasis, ['fatigue', 'load', 'baselineShift']);
  number(value.allostasis.fatigue, 0, 1); number(value.allostasis.load, 0, 1); vector(value.allostasis.baselineShift, ['p', 'a', 'd'], -1, 1);
  if (!Array.isArray(value.rho) || value.rho.length !== 8) invalid();
  for (const row of value.rho) {
    if (!Array.isArray(row) || row.length !== 8) invalid();
    for (const cell of row) { if (!Array.isArray(cell) || cell.length !== 2) invalid(); for (const part of cell) number(part, -1, 1); }
  }
  if (!value.habituation || typeof value.habituation !== 'object' || Array.isArray(value.habituation) || ![Object.prototype, null].includes(Object.getPrototypeOf(value.habituation))) invalid();
  const habits = Reflect.ownKeys(value.habituation);
  if (habits.length > 128 || habits.some(key => typeof key !== 'string' || !/^(?:curiosity|boredom|expression|silence:[0-9]{1,8})$/.test(key))) invalid();
  for (const habit of Object.values(value.habituation)) { object(habit, ['s', 't']); number(habit.s, 0, 1); epoch(habit.t); if (habit.t > value.t) invalid(); }
  object(value.circadian, ['bins']);
  if (!Array.isArray(value.circadian.bins) || value.circadian.bins.length !== 24) invalid();
  for (const bin of value.circadian.bins) number(bin, 0, 1000);
  if (!Array.isArray(value.observations) || value.observations.length !== 0) invalid();
  object(value.counters, ['messages', 'transitions', 'sleepCycles', 'observations']);
  for (const count of Object.values(value.counters)) number(count, 0, Number.MAX_SAFE_INTEGER, true);
  number(value.surpriseEma, 0, 4); number(value.seed, -2147483648, 2147483647, true);
  return copy(value);
}

export function normalizeCompanionEnvelope(value) {
  if (value === null) return null;
  object(value, ['version', 'revision', 'state', 'ownerCursor', 'opportunityKey']);
  if (value.version !== 1) invalid();
  number(value.revision, 1, Number.MAX_SAFE_INTEGER, true);
  normalizeCompanionState(value.state);
  if (value.ownerCursor !== null) identifier(value.ownerCursor);
  if (value.opportunityKey !== null && (typeof value.opportunityKey !== 'string' || !/^[a-f0-9]{64}$/.test(value.opportunityKey))) invalid();
  return copy(value);
}
