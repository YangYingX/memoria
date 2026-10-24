export const defaultOwnerChatReserve = 20;
export const defaultModelDailyRequestLimit = 3000;

export function normalizeModelDailyRequestLimit(value = defaultModelDailyRequestLimit) {
  if (!Number.isInteger(value) || value < 1 || value > 1_000_000) throw new Error('每日模型请求上限须为1–1000000的整数。');
  return value;
}

export function normalizeOwnerChatReserve(value = defaultOwnerChatReserve) {
  if (!Number.isInteger(value) || value < 0 || value > 200) throw new Error('创建人私聊模型预留须为0–200的整数。');
  return value;
}

export function modelBudget(store) {
  const day = new Date().toISOString().slice(0, 10);
  const model = store.getSetting('model', {});
  const dailyLimit = normalizeModelDailyRequestLimit(model?.dailyRequestLimit);
  const usage = store.getSetting('modelUsage', { day, calls: 0 });
  const calls = usage?.day !== day ? 0 : Number.isSafeInteger(usage.calls) && usage.calls >= 0 ? usage.calls : dailyLimit;
  const reserve = Math.min(normalizeOwnerChatReserve(model?.ownerChatReserve), dailyLimit);
  return { day, calls, reserve, dailyLimit,
    sharedRemaining: Math.max(0, dailyLimit - reserve - calls), ownerRemaining: Math.max(0, dailyLimit - calls) };
}

async function responseJson(response) {
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error('模型响应超过大小限制。');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function requestCompletion({ store, messages, tools, maxTokens = 1500, signal, ownerChat = false }) {
  if (typeof ownerChat !== 'boolean') throw new Error('模型额度请求类型须为布尔值。');
  signal?.throwIfAborted();
  const model = store.getSetting('model');
  if (!model?.apiKey) throw new Error('请先保存模型 API 密钥。');
  const budget = modelBudget(store), { day, calls } = budget;
  let usage = store.getSetting('modelUsage', { day, calls: 0 });
  if (usage.day !== day) usage = { day, calls: 0 };
  if (!budget.ownerRemaining) {
    const error = new Error(`已达到每日 ${budget.dailyLimit} 次模型请求上限。`);
    error.code = 'MODEL_DAILY_LIMIT';
    throw error;
  }
  if (!ownerChat && !budget.sharedRemaining) {
    const error = new Error('本次任务的共享模型额度不足，剩余额度为创建人私聊预留。');
    error.code = 'MODEL_OWNER_CHAT_RESERVED';
    throw error;
  }
  store.setSetting('modelUsage', { ...usage, calls: calls + 1 });
  const baseUrl = new URL(model.baseUrl);
  const response = await fetch(`${model.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
    headers: { Authorization: `Bearer ${model.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model.model, messages, max_tokens: maxTokens,
      ...(baseUrl.hostname === 'api.deepseek.com' ? { thinking: { type: 'disabled' } } : {}),
      ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
    }),
  });
  if (!response.ok) throw new Error(`模型接口返回 HTTP ${response.status}，请检查服务地址、模型名称、余额和密钥。`);
  const result = await responseJson(response);
  signal?.throwIfAborted();
  if (!result.choices?.[0]?.message) throw new Error('模型返回格式不兼容 Chat Completions。');
  usage = store.getSetting('modelUsage');
  if (usage.day === day) {
    const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
    store.setSetting('modelUsage', { ...usage,
      promptTokens: (usage.promptTokens || 0) + count(result.usage?.prompt_tokens),
      completionTokens: (usage.completionTokens || 0) + count(result.usage?.completion_tokens),
    });
  }
  return result;
}

export async function testModel(store) {
  const result = await requestCompletion({ store, messages: [{ role: 'user', content: '请只回复“连接成功”。' }], maxTokens: 32 });
  const reply = result.choices[0].message.content;
  if (typeof reply !== 'string' || !reply.trim()) throw new Error('模型未返回文本；请检查模型是否支持普通文本回复。');
  return { ok: true, model: result.model || store.getSetting('model').model, reply: reply.slice(0, 200), usage: result.usage };
}
