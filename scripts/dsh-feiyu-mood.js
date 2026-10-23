import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, dirname } from 'node:path';
import { normalizeMoodState, validateMoodDelta } from '../src/mood.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fields = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const dimensions = () => ({ happy: 0, calm: 0, sweet: 0, heartache: 0, worry: 0, sad: 0, jealous: 0 });
const immediate = () => new Promise(resolve => setImmediate(resolve));

function cancelled() { return new Error('DSH_FEIYU_MOOD_CANCELLED'); }
function wait(promise, signal) {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(cancelled()); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

// The host verifies the original package and both runtime hashes before loading it.
// Its hook/parser/divide-by-three algorithm run here; only Memoria owns persistent mood.
export async function runFeiyuMood({ ctx, load, messages, requestCompletion, signal }) {
  let item;
  try {
    if (typeof load !== 'function' || typeof requestCompletion !== 'function' || !Array.isArray(messages) || messages.length !== 1
      || !fields(messages[0], ['role', 'content']) || messages[0].role !== 'user'
      || typeof messages[0].content !== 'string' || messages[0].content.length > 16000 || messages[0].content.includes('\0')) throw new Error();
    item = JSON.parse(messages[0].content);
    if (!fields(item, ['input', 'mood']) || !fields(item.input, ['kind', 'text', 'reply']) || item.input.kind !== 'conversation'
      || !['text', 'reply'].every(key => typeof item.input[key] === 'string' && item.input[key].trim())
      || item.input.text.length > 3000 || item.input.reply.length > 1500
      || !fields(item.mood, ['value', 'emotion', 'label', 'confidence', 'updatedAt'])
      || (item.mood.label !== undefined && (typeof item.mood.label !== 'string' || item.mood.label.length > 20))) throw new Error();
    normalizeMoodState({ schemaVersion: 1, value: item.mood.value, emotion: item.mood.emotion,
      confidence: item.mood.confidence, updatedAt: item.mood.updatedAt });
  } catch { throw new Error('DSH_FEIYU_MOOD_INVALID_INPUT'); }
  const parentMessages = [{ role: 'user', content: messages[0].content }];
  const configuredHome = process.env.DSH_HOME;
  let directory, home;
  try {
    if (typeof configuredHome !== 'string' || !isAbsolute(configuredHome)
      || !lstatSync(configuredHome).isDirectory() || lstatSync(configuredHome).isSymbolicLink()) throw new Error();
    home = realpathSync(configuredHome);
    directory = join(home, 'feiyu-mood');
  } catch { throw new Error('DSH_FEIYU_MOOD_INVALID_HOME'); }
  const statePath = join(directory, 'state.json'), configPath = join(directory, 'config.json'), diagPath = join(directory, 'diag.log');
  const controller = new AbortController();
  const taskSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let handle, scope, unregister, stopBarrier, owned = false, failureCode = '', failure, outcome;
  let replayCalls = 0, judgeCalls = 0, turns = 0, ends = 0, stops = 0, users = 0, completed = false, agentError = false;
  let nativeReply, canonical, actualDelta, intervals = 0, judgeFinished = false;
  let judgeStartedResolve, judgeSettledResolve;
  const judgeStarted = new Promise(resolve => { judgeStartedResolve = resolve; });
  const judgeSettled = new Promise(resolve => { judgeSettledResolve = resolve; });
  const provider = 'memoria-feiyu-mood', replayModel = 'replay', judgeModel = 'judge';
  const abort = () => handle?.agent.cancel({ kind: 'parent' });
  const fail = code => { failureCode ||= code; controller.abort(); abort(); throw new Error(code); };
  const active = () => { if (taskSignal.aborted) fail('DSH_FEIYU_MOOD_CANCELLED'); };
  let initial;

  function readState() {
    if (!lstatSync(statePath).isFile() || lstatSync(statePath).isSymbolicLink() || lstatSync(statePath).size > 20000) fail('DSH_FEIYU_MOOD_INVALID_RESULT');
    return JSON.parse(readFileSync(statePath, 'utf8'));
  }
  function consumed() {
    active();
    if (!canonical || !judgeFinished || judgeCalls !== 1 || !lstatSync(diagPath).isFile()
      || lstatSync(diagPath).isSymbolicLink() || lstatSync(diagPath).size > 20000) fail('DSH_FEIYU_MOOD_INVALID_RESULT');
    const line = readFileSync(diagPath, 'utf8').trim().split('\n').at(-1)?.replace(/^\S+\s+/, '');
    const state = readState();
    const step = Math.round(canonical.delta / 3);
    if (step === 0) {
      const marker = canonical.confidence === 0
        ? '这轮没判出来（模型没给结论：confidence=0、没有 reason）' : '这轮判定无变化，不记入时间线';
      if (line !== marker || JSON.stringify(state) !== JSON.stringify(initial)) fail('DSH_FEIYU_MOOD_INVALID_RESULT');
      actualDelta = 0;
    } else {
      const terminal = `${Math.abs(canonical.delta) >= 3 ? '心情更新' : '小波动（只记账，不告诉她）'}：mood=${70 + step}，（无理由）`;
      const entry = state.timeline?.[0];
      if (line !== terminal || state.mood !== 70 + step || state.lastReason !== '' || state.lastConfidence !== canonical.confidence
        || !Array.isArray(state.timeline) || state.timeline.length !== 1 || entry.delta !== step || entry.mood !== state.mood
        || entry.reason !== '' || entry.conf !== canonical.confidence
        || JSON.stringify(state.dims) !== JSON.stringify(dimensions()) || JSON.stringify(entry.dimsDelta) !== JSON.stringify(dimensions())) {
        fail('DSH_FEIYU_MOOD_INVALID_RESULT');
      }
      actualDelta = entry.delta;
    }
  }

  try {
    active();
    try { mkdirSync(directory); owned = true; } catch { fail('DSH_FEIYU_MOOD_STATE_EXISTS'); }
    const { LlmAdapter, LlmError, resolveRetryPolicy, createUserMessage } = await load('@deepseek-ai/dsh-llm');
    const plugin = await load('dsh-feiyu-mood');
    active();
    if (plugin?.name !== 'feiyu-mood' || typeof plugin.apply !== 'function') fail('DSH_FEIYU_MOOD_INVALID_PLUGIN');
    class Adapter extends LlmAdapter {
      providerRetryPolicy() { return resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, provider); }
      async resolveModel(route, model, callSignal) {
        active();
        if (callSignal?.aborted || route !== provider || ![replayModel, judgeModel].includes(model)) fail('DSH_FEIYU_MOOD_INVALID_RESULT');
        return { provider, id: model, name: 'Memoria controlled mood task', inputModalities: ['text'], defaultMaxTokens: model === replayModel ? 500 : 1000 };
      }
      async *stream(options) {
        try {
          active();
          if (options.provider !== provider || (options.tools !== undefined && (!Array.isArray(options.tools) || options.tools.length))) fail('DSH_FEIYU_MOOD_INVALID_RESULT');
          let text;
          if (options.model === replayModel) {
            if (++replayCalls !== 1) fail('DSH_FEIYU_MOOD_REPLAY_LIMIT');
            text = item.input.reply;
          } else if (options.model === judgeModel) {
            judgeCalls++;
            judgeStartedResolve();
            try {
              if (judgeCalls !== 1 || options.maxTokens !== 1000 || options.temperature !== 0.2) fail('DSH_FEIYU_MOOD_JUDGE_LIMIT');
              // Original system/history are deliberately not forwarded. The parent owns this exact input and the 300-token/global budget.
              const boundSignal = options.signal ? AbortSignal.any([taskSignal, options.signal]) : taskSignal;
              const result = await wait(requestCompletion({ messages: parentMessages, maxTokens: 300 }, boundSignal), boundSignal);
              active();
              if (!object(result) || typeof result.text !== 'string' || !result.text.trim() || result.text.length > 2000) fail('DSH_FEIYU_MOOD_INVALID_RESULT');
              try { canonical = validateMoodDelta(JSON.parse(result.text)); } catch { fail('DSH_FEIYU_MOOD_INVALID_RESULT'); }
              // Seven dimensions are not fabricated or persisted as another authority.
              text = JSON.stringify({ moodDelta: canonical.delta, dims: dimensions(), reason: '', confidence: canonical.confidence });
              yield { type: 'block-start', index: 0, blockType: 'text' };
              yield { type: 'text-delta', index: 0, text };
              yield { type: 'block-end', index: 0, block: { type: 'text', text } };
              yield { type: 'finish', reason: { kind: 'stop' } };
            } finally { judgeFinished = true; judgeSettledResolve(); }
            return;
          } else fail('DSH_FEIYU_MOOD_INVALID_RESULT');
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text };
          yield { type: 'block-end', index: 0, block: { type: 'text', text } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        } catch (error) {
          failureCode ||= taskSignal.aborted ? 'DSH_FEIYU_MOOD_CANCELLED' : 'DSH_FEIYU_MOOD_FAILED';
          throw new LlmError(failureCode, error?.code === 'DSH_MODEL_LIMIT' ? 'QUOTA' : failureCode);
        }
      }
    }
    signal?.addEventListener('abort', abort, { once: true });
    unregister = ctx.llm.registerAdapter([provider], new Adapter());
    handle = await ctx.agents.create({ sessionId: `memoria-feiyu-${randomUUID()}`, signal: taskSignal,
      agentOptions: { provider, model: replayModel, maxTokens: 500 }, setup(agentCtx, agent) {
        agentCtx.tools.presentAs('native'); agentCtx.tools.restrict({ allow: [] }); agentCtx.tools.guard(() => 'MEMORIA_NO_TOOLS');
        agentCtx.systemPrompt.suppressRuntimeContext();
        agentCtx.systemPrompt.section({ name: 'memoria-feiyu-replay', order: 0, complete: true, interpolate: false, text: '回放已核对的单轮回复，不调用工具。' });
        agentCtx.on('agent/error', event => { if (event.agent === agent) agentError = true; });
        agentCtx.on('session/event', (session, event) => {
          if (session !== agent.session) return;
          if (event.type === 'turn/start') turns++;
          else if (event.type === 'turn/end') { ends++; completed = event.data.reason?.kind === 'completed'; }
          else if (event.type === 'user/message') {
            if (['runtime-context', 'time-context'].includes(event.data.source?.kind)) return;
            users++;
            if (event.data.source?.kind !== 'user' || event.data.content?.map(block => block.type === 'text' ? block.text : '').join('') !== item.input.text) agentError = true;
          } else if (event.type === 'assistant/message') {
            const content = event.data.message?.content;
            nativeReply = Array.isArray(content) && content.every(block => block.type === 'text') ? content.map(block => block.text).join('') : undefined;
          }
        });
      } });
    active();
    if (ctx.tools.schemas(handle.agent).length) fail('DSH_FEIYU_MOOD_INVALID_RESULT');
    ctx.sessionTitle.rename(handle.agent.session, 'Memoria isolated mood replay');
    const now = Date.now();
    initial = { mood: 70, dims: dimensions(), lastReason: '', lastConfidence: 0, injectedFor: 0, lastInjectedText: '', lastInjectedAt: 0,
      saidAt: [], lastNotedMood: 70, minor: false, kind: '', updatedAt: now, lastDecayAt: now, timeline: [] };
    writeFileSync(statePath, JSON.stringify(initial), { flag: 'wx' });
    writeFileSync(configPath, JSON.stringify({ targetSession: handle.agent.id, selfName: '伙伴', ownerName: '当前对话对象', autoJudge: true,
      injectMode: 'off', injectPerDay: 0, moodBase: 70, moodFloor: 0, judgeProvider: provider, judgeModel }), { flag: 'wx' });
    scope = ctx.isolate('webServer').plugin({ name: 'memoria-feiyu-mood-adapter', async apply(adapterCtx) {
      adapterCtx.provide('webServer', { register() { return () => {}; } });
      await adapterCtx.extend({ interval: () => { intervals++; return () => {}; } }).plugin(plugin);
    } });
    await scope;
    active();
    if (scope.state !== 2 || intervals !== 1) fail('DSH_FEIYU_MOOD_NOT_READY');
    stopBarrier = handle.agent.ctx.on('agent/turn-stopping', async payload => {
      if (payload.agent !== handle.agent || ++stops !== 1) fail('DSH_FEIYU_MOOD_INVALID_RESULT');
      let timer;
      try {
        await wait(Promise.race([judgeStarted, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DSH_FEIYU_MOOD_NOT_STARTED')), 1000); })]), taskSignal);
        await wait(judgeSettled, taskSignal);
        // Pinned 0.4.3 has no await between stream consumption and parseDelta/applyDelta/saveState/terminal diag.
        // Drain that known microtask chain, then require its exact terminal log AND state; elapsed time alone is never success.
        await immediate();
        consumed();
      } finally { clearTimeout(timer); }
    });
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: item.input.text }], source: { kind: 'user' } }));
    await wait(handle.agent.whenIdle(), taskSignal);
    active();
    if (agentError || turns !== 1 || ends !== 1 || stops !== 1 || users !== 1 || !completed || replayCalls !== 1 || judgeCalls !== 1
      || nativeReply !== item.input.reply || actualDelta === undefined || !canonical) fail('DSH_FEIYU_MOOD_FAILED');
    outcome = { text: JSON.stringify(validateMoodDelta({ ...canonical, delta: actualDelta })) };
  } catch { failure = new Error(failureCode || (signal?.aborted ? 'DSH_FEIYU_MOOD_CANCELLED' : 'DSH_FEIYU_MOOD_FAILED')); }
  finally {
    signal?.removeEventListener('abort', abort); controller.abort(); abort();
    try { await stopBarrier?.(); } catch { failure ||= new Error('DSH_FEIYU_MOOD_CLEANUP_FAILED'); }
    try { await handle?.dispose(); } catch { failure ||= new Error('DSH_FEIYU_MOOD_CLEANUP_FAILED'); }
    // The bridge races parent work against task cancellation, so an ignored callback cannot leave the original judge alive.
    try { if (judgeCalls) { await judgeSettled; await immediate(); } } catch { failure ||= new Error('DSH_FEIYU_MOOD_CLEANUP_FAILED'); }
    try { await scope?.dispose(); } catch { failure ||= new Error('DSH_FEIYU_MOOD_CLEANUP_FAILED'); }
    try { await unregister?.(); } catch { failure ||= new Error('DSH_FEIYU_MOOD_CLEANUP_FAILED'); }
    try {
      if (owned) {
        if (dirname(directory) !== home || realpathSync(directory) !== directory
          || !lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error();
        rmSync(directory, { recursive: true, force: true });
      }
    } catch { failure ||= new Error('DSH_FEIYU_MOOD_CLEANUP_FAILED'); }
  }
  if (failure) throw failure;
  return outcome;
}
