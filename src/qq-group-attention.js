const defaults = { groupReplyChance: 0, groupReplyCooldownSeconds: 300 };
const groupIdPattern = /^\d{1,20}$/;
const object = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export function normalizeQQGroupAttentionSettings(input = {}, previous = {}) {
  if (!object(input) || !object(previous)) throw new Error('QQ 群聊关注设置格式无效。');
  const result = {};
  for (const [key, min, max] of [['groupReplyChance', 0, 100], ['groupReplyCooldownSeconds', 60, 3600]]) {
    const value = input[key] === undefined ? previous[key] === undefined ? defaults[key] : previous[key] : input[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(key === 'groupReplyChance'
      ? 'QQ 群聊关注概率须为 0–100 的整数。' : 'QQ 群聊关注冷却须为 60–3600 秒的整数。');
    result[key] = value;
  }
  return result;
}

function configSignature(value) {
  if (!object(value)) throw new Error();
  return JSON.stringify(Object.fromEntries(Object.entries({ ...value, ...normalizeQQGroupAttentionSettings(value) })
    .sort(([left], [right]) => left.localeCompare(right))));
}

function readGroups(store, time) {
  const saved = store.getSetting('qqGroupAttentionStatus', { groups: {} });
  if (!object(saved) || Reflect.ownKeys(saved).length !== 1 || !Object.hasOwn(saved, 'groups') || !object(saved.groups)) throw new Error();
  const entries = Object.entries(saved.groups);
  if (Reflect.ownKeys(saved.groups).length !== entries.length || entries.length > 100) throw new Error();
  for (const [id, value] of entries) {
    if (!groupIdPattern.test(id) || !object(value) || Reflect.ownKeys(value).length !== 1 || !Object.hasOwn(value, 'lastAttemptAt')
      || typeof value.lastAttemptAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.lastAttemptAt)
      || !Number.isFinite(Date.parse(value.lastAttemptAt)) || new Date(value.lastAttemptAt).toISOString() !== value.lastAttemptAt
      || Date.parse(value.lastAttemptAt) > time) throw new Error();
  }
  return saved.groups;
}

export function createQQGroupAttention({ store, clock = Date.now, random = Math.random }) {
  return {
    reserve({ groupId, config }) {
      const denied = reason => ({ allowed: false, reason });
      let expected, current, settings;
      try {
        current = store.getSetting('qq', {});
        expected = configSignature(config);
        if (configSignature(current) !== expected) return denied('config_changed');
        settings = normalizeQQGroupAttentionSettings(current);
        if (current.enabled !== true) return denied('disabled');
        if (!Array.isArray(current.allowedGroups) || current.allowedGroups.length > 100
          || current.allowedGroups.some(id => typeof id !== 'string' || !groupIdPattern.test(id))) return denied('invalid_config');
        if (typeof groupId !== 'string' || !groupIdPattern.test(groupId) || !current.allowedGroups.includes(groupId)) return denied('not_allowed');
      } catch { return denied('invalid_config'); }
      if (settings.groupReplyChance === 0) return denied('quiet');
      try {
        const time = clock();
        if (!Number.isSafeInteger(time) || time < 0) return denied('invalid_state');
        const stamp = new Date(time).toISOString(), cooldown = settings.groupReplyCooldownSeconds * 1000;
        if (!/^\d{4}-/.test(stamp)) return denied('invalid_state');
        function available() {
          const groups = readGroups(store, time);
          if (groups[groupId] && time - Date.parse(groups[groupId].lastAttemptAt) < cooldown) return { reason: 'cooldown' };
          // Retain removed-but-cooling groups so removing/re-adding an allowlist entry cannot reset it.
          const kept = Object.fromEntries(Object.entries(groups).filter(([, value]) => time - Date.parse(value.lastAttemptAt) < cooldown));
          if (!Object.hasOwn(kept, groupId) && Object.keys(kept).length >= 100) return { reason: 'capacity' };
          return { groups: kept };
        }
        const first = available();
        if (first.reason) return denied(first.reason);
        if (settings.groupReplyChance < 100) {
          const roll = random();
          if (!Number.isFinite(roll) || roll < 0 || roll >= 1 || roll >= settings.groupReplyChance / 100) return denied('quiet');
        }
        if (configSignature(store.getSetting('qq', {})) !== expected) return denied('config_changed');
        const latest = available();
        if (latest.reason) return denied(latest.reason);
        latest.groups[groupId] = { lastAttemptAt: stamp };
        store.setSetting('qqGroupAttentionStatus', { groups: latest.groups });
        return { allowed: true, reason: 'allowed' };
      } catch { return denied('invalid_state'); }
    },
  };
}
