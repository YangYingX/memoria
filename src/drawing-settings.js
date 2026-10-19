export const defaultDrawingSettings = {
  provider: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com', model: 'qwen-image-3.0',
  apiKey: '', dailyLimit: 1, weeklyLimit: 3,
};

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}须为对象。`);
  return value;
}

function text(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label}须为 1–${max} 字，且不能包含控制字符。`);
  }
  return value.trim();
}

function endpoint(value) {
  const address = text(value, '绘图接口地址', 2000);
  let url;
  try { url = new URL(address); } catch { throw new Error('绘图接口地址无效。'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const loopback = host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new Error('绘图接口须使用 HTTPS 或本机回环 HTTP，不能在地址中放置登录凭据、查询参数或片段。');
  }
  return address;
}

export function normalizeDrawingSettings(input = {}, previous = {}) {
  plainObject(input, '绘图设置');
  plainObject(previous, '已有绘图设置');
  const value = key => input[key] ?? previous[key] ?? defaultDrawingSettings[key];
  const provider = value('provider');
  if (!['openai-compatible', 'qwen'].includes(provider)) throw new Error('绘图服务类型须为 OpenAI 兼容或 Qwen。');
  if (input.clearApiKey !== undefined && typeof input.clearApiKey !== 'boolean') throw new Error('清除绘图密钥选项须为布尔值。');
  if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 4096 || /[\u0000-\u001f\u007f]/.test(input.apiKey))) {
    throw new Error('绘图 API 密钥格式无效或过长。');
  }
  const apiKey = input.clearApiKey === true ? '' : (input.apiKey?.trim() || previous.apiKey || '');
  if (typeof apiKey !== 'string' || apiKey.length > 4096 || /[\u0000-\u001f\u007f]/.test(apiKey)) throw new Error('已有绘图 API 密钥格式无效。');
  const dailyLimit = value('dailyLimit'), weeklyLimit = value('weeklyLimit');
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 5) throw new Error('未来每日绘图限制须为 1–5 次。');
  if (!Number.isInteger(weeklyLimit) || weeklyLimit < 1 || weeklyLimit > 20 || weeklyLimit < dailyLimit) {
    throw new Error('未来每周绘图限制须为 1–20 次，且不能小于每日限制。');
  }
  return { provider, baseUrl: endpoint(value('baseUrl')), model: text(value('model'), '绘图模型名称', 120), apiKey, dailyLimit, weeklyLimit };
}

export function publicDrawingSettings(config = {}) {
  const { apiKey, ...view } = normalizeDrawingSettings({}, config);
  return { ...view, hasApiKey: Boolean(apiKey) };
}
