function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function fields(value, allowed) { return object(value) && Object.keys(value).every(key => allowed.includes(key)); }
function count(value) { return Number.isSafeInteger(value) && value >= 0; }

// requestCompletion({ messages: [{ role, content }], maxTokens }, signal) is the parent IPC callback.
// It returns { text, model, usage: null | DSH TokenUsage }; no system prompt, persona or key crosses into this child.
export async function registerMemoriaLlm({ ctx, load, requestCompletion }) {
  const { LlmAdapter, LlmError, resolveRetryPolicy } = await load('@deepseek-ai/dsh-llm');
  const provider = 'memoria';
  const id = 'memoria-notes';
  const fail = (code, llmCode = code) => { throw new LlmError(code, llmCode); };
  class MemoriaAdapter extends LlmAdapter {
    providerRetryPolicy() { return resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'memoria'); }
    async resolveModel(route, model, signal) {
      if (signal?.aborted) fail('DSH_MODEL_CANCELLED', 'ABORTED');
      if (route !== provider || model !== id) fail('DSH_MODEL_INVALID_INPUT');
      return { provider, id, name: 'Memoria reading notes', inputModalities: ['text'], defaultMaxTokens: 650 };
    }
    async *stream(options) {
      if (options.signal?.aborted) fail('DSH_MODEL_CANCELLED', 'ABORTED');
      if (options.provider !== provider || options.model !== id
        || ['tools', 'toolHistory'].some(key => Object.hasOwn(options, key))
        || ['temperature', 'stop', 'reasoningEffort'].some(key => options[key] !== undefined)
        || !Array.isArray(options.messages) || !options.messages.length
        || !Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > 800) fail('DSH_MODEL_INVALID_INPUT');
      let characters = 0;
      const messages = options.messages.map(message => {
        if (!object(message) || !['user', 'assistant'].includes(message.role) || !Array.isArray(message.content)) fail('DSH_MODEL_INVALID_INPUT');
        const content = message.content.map(block => {
          if (!fields(block, ['type', 'text']) || block.type !== 'text' || typeof block.text !== 'string') fail('DSH_MODEL_INVALID_INPUT');
          characters += block.text.length;
          if (characters > 20000) fail('DSH_MODEL_INVALID_INPUT');
          return block.text;
        }).join('');
        return { role: message.role, content };
      });
      // options.system is intentionally ignored: only the parent owns the fixed reading-note instructions.
      let result;
      try { result = await requestCompletion({ messages, maxTokens: options.maxTokens }, options.signal); }
      catch (error) {
        if (options.signal?.aborted || error?.code === 'DSH_MODEL_CANCELLED') fail('DSH_MODEL_CANCELLED', 'ABORTED');
        if (error?.code === 'DSH_MODEL_LIMIT') fail('DSH_MODEL_LIMIT', 'QUOTA');
        fail('DSH_MODEL_FAILED');
      }
      if (options.signal?.aborted) fail('DSH_MODEL_CANCELLED', 'ABORTED');
      if (!fields(result, ['text', 'model', 'usage']) || typeof result.text !== 'string' || !result.text.trim()
        || result.text.length > 2000 || typeof result.model !== 'string' || !result.model.trim() || result.model.length > 200) fail('DSH_MODEL_INVALID_RESPONSE');
      const usage = result.usage;
      if (usage !== null && (!fields(usage, ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens'])
        || !count(usage.inputTokens) || !count(usage.outputTokens) || !count(usage.totalTokens)
        || (Object.hasOwn(usage, 'cacheReadTokens') && !count(usage.cacheReadTokens))
        || usage.totalTokens !== usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0))) fail('DSH_MODEL_INVALID_RESPONSE');
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: result.text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: result.text } };
      if (usage !== null) yield { type: 'usage', usage };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const dispose = ctx.llm.registerAdapter([provider], new MemoriaAdapter());
  return { provider, id, dispose };
}
