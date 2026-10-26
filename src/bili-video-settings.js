export const defaultBiliVideoSettings = Object.freeze({
  enabled: false, frames: 6, audioSeconds: 60, dailyDownloadMiB: 256, dailyAudioSeconds: 360,
});

export function normalizeBiliVideoSettings(input = {}, previous = {}) {
  const keys = Object.keys(defaultBiliVideoSettings);
  for (const item of [input, previous]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(item))
      || Reflect.ownKeys(item).some(key => !keys.includes(key))) throw new Error('B站视频设置字段无效。');
  }
  const value = key => Object.hasOwn(input, key) ? input[key]
    : Object.hasOwn(previous, key) ? previous[key] : defaultBiliVideoSettings[key];
  const enabled = value('enabled');
  if (typeof enabled !== 'boolean') throw new Error('B站视频理解开关须为布尔值。');
  const result = { enabled };
  for (const [key, maximum] of [['frames', 8], ['audioSeconds', 60], ['dailyDownloadMiB', 4096], ['dailyAudioSeconds', 86400]]) {
    const number = value(key);
    if (!Number.isSafeInteger(number) || number < 0 || number > maximum) throw new Error('B站视频理解额度须为允许范围内的整数。');
    result[key] = number;
  }
  return result;
}
