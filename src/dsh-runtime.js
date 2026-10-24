import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryAccess } from './memory-access.js';
import { biliVideoUrl } from './bili-reading.js';
import { createDshModelAccess } from './dsh-model.js';
import { moodSnapshot, validateMoodDelta } from './mood.js';
import { createMemoryAgentAccess, memoryAgentErrorMessage } from './dsh-memory-agent-access.js';
import { normalizeProactiveImpulse, proactiveQuery } from './dsh-proactive-context.js';
import { expressionSearchItems, expressionSearchQuery, expressionSearchResult } from './expression-search.js';
import { readBiliCredentials } from './bili-credentials.js';

const hostScript = fileURLToPath(new URL('../scripts/dsh-host.js', import.meta.url));
const memoryTools = ['search_memory', 'read_memory', 'read_memory_source', 'search_conversations', 'read_conversation'];
export const defaultDshReadingSettings = { dailyReadLimit: 6 };

class DshTaskError extends Error {}

export function dshTaskErrorMessage(error) {
  return error instanceof DshTaskError ? error.message : 'DSH 任务未完成，未自动重试。';
}

export function normalizeDshReadingSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'dailyReadLimit')
    || !Number.isSafeInteger(input.dailyReadLimit) || input.dailyReadLimit < 0 || input.dailyReadLimit > 50) throw new Error('DSH 每日阅读尝试上限须为 0–50。');
  return { dailyReadLimit: input.dailyReadLimit };
}

const readingErrors = {
  PLATFORM_PAUSED: 'B站拒绝访问或要求验证，读取已暂停；不会自动重试或清空暂停记录。',
  PERSISTENT_PAUSE: 'B站读取仍处于暂停状态，请先在本机核对平台访问情况。',
  NO_READABLE_TEXT: '未取得可读字幕；没有保存阅读经历，也没有推断视频内容。',
  NETWORK_FAILED: 'B站文字获取失败，未自动重试。',
  READ_TOKEN_BUDGET: '视频文字超过单次资料上限，未截断保存。',
  INVALID_SOURCE: '视频文字来源或分页校验失败，未保存阅读经历。',
  SOURCE_TOO_LARGE: '视频资料超过单次读取上限，本次未截断保存。',
  DSH_READ_FAILED: 'B站文字读取未完成，未自动重试。',
};
const modelErrors = {
  DSH_MODEL_LIMIT: '本次任务可用模型额度不足，已停止。',
  DSH_MODEL_CANCELLED: 'DSH 模型任务已取消。',
  DSH_MODEL_INVALID_RESPONSE: 'DSH 模型回复格式无效，本次任务已停止。',
  DSH_MODEL_FAILED: 'DSH 模型请求未完成，本次任务已停止。',
};

function publicReflectionSource(value) {
  if (typeof value !== 'string' || !value) return false;
  if (biliVideoUrl(value) === value) return true;
  try {
    const url = new URL(value);
    return url.origin === 'https://www.xiaoheihe.cn' && /^\/app\/bbs\/link\/\d+$/.test(url.pathname)
      && !url.username && !url.password && !url.search && !url.hash && !url.port && url.href === value && url.href === url.origin + url.pathname;
  } catch { return false; }
}

export function createDshRuntime({ store, dataDir }) {
  let busy = false, stopped = false, cancelCurrent;
  let drained = Promise.resolve();
  let lastProactiveTurn = null;
  let lastMoodEvaluation = null;
  function readingStatus() {
    const day = new Date().toISOString().slice(0, 10);
    const saved = store.getSetting('dshReadingStatus', {});
    const settings = normalizeDshReadingSettings(store.getSetting('dshReading', defaultDshReadingSettings));
    const attempts = saved.day === day && Number.isSafeInteger(saved.attempts) && saved.attempts >= 0 ? saved.attempts : 0;
    return { day, attempts, dailyLimit: settings.dailyReadLimit, remaining: Math.max(0, settings.dailyReadLimit - attempts) };
  }
  function config() {
    const path = join(dataDir, 'dsh-runtime.json');
    if (!existsSync(path)) return { enabled: false };
    let input;
    try { input = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); }
    catch { throw new Error('DSH 本机配置无法读取。'); }
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.enabled !== 'boolean'
      || Object.keys(input).some(key => !['enabled', 'nodePath', 'hostDirectory', 'proactivePlugin', 'moodPlugin', 'expressionPlugin'].includes(key))
      || (Object.hasOwn(input, 'proactivePlugin') && input.proactivePlugin !== 'dsh-speak-up')
      || (Object.hasOwn(input, 'moodPlugin') && input.moodPlugin !== 'dsh-feiyu-mood')
      || (Object.hasOwn(input, 'expressionPlugin') && input.expressionPlugin !== 'dsh-meme')) throw new Error('DSH 本机配置无效。');
    if (!input.enabled) return { enabled: false };
    if (![input.nodePath, input.hostDirectory].every(value => typeof value === 'string' && isAbsolute(value))
      || !statSync(input.nodePath, { throwIfNoEntry: false })?.isFile()
      || !statSync(join(input.hostDirectory, 'package.json'), { throwIfNoEntry: false })?.isFile()) {
      throw new Error('请配置独立的 Node.js 24 和已安装 DSH 的宿主目录。');
    }
    return { enabled: true, nodePath: realpathSync(input.nodePath), hostDirectory: realpathSync(input.hostDirectory),
      proactivePlugin: input.proactivePlugin, moodPlugin: input.moodPlugin, expressionPlugin: input.expressionPlugin };
  }
  return {
    stop() { stopped = true; cancelCurrent?.(); return drained; },
    status() {
      try {
        const settings = config();
        return { enabled: settings.enabled, busy, mode: 'read-only', memoryAuthority: 'memoria', reading: readingStatus(),
          proactive: { configuredEngine: settings.proactivePlugin || 'native', lastCompletedTurn: lastProactiveTurn },
          expressions: { configuredEngine: settings.expressionPlugin || 'catalog' },
          mood: { configuredConversationEngine: settings.moodPlugin || 'native', lastCompletedEvaluation: lastMoodEvaluation } };
      }
      catch { return { enabled: false, busy, mode: 'read-only', memoryAuthority: 'memoria', error: '请检查本机 DSH 配置。' }; }
    },
    async execute({ scope, actor, name, args = {}, signal, selectVideo, excludeMessageId = '' }) {
      if (stopped) throw new Error('DSH 运行层已停止。');
      const browsing = name === 'browse_bili';
      const reading = name === 'read_bili_video' || browsing;
      const noting = name === 'note_bili_reading';
      const judging = name === 'evaluate_mood';
      const composing = name === 'compose_proactive';
      const searchingExpressions = name === 'search_expressions';
      const recalling = name === 'recall_memory' || composing;
      const modelTask = noting || judging;
      const memory = createMemoryAccess({ store, scope: reading || modelTask ? 'public' : scope, actor, excludeMessageId });
      if (!['inspect', ...memoryTools, 'read_bili_video', 'browse_bili', 'note_bili_reading', 'evaluate_mood', 'recall_memory', 'compose_proactive', 'search_expressions'].includes(name) || !args || typeof args !== 'object' || Array.isArray(args)
        || (name === 'inspect' && Object.keys(args).length)) throw new Error('此 DSH 入口仅支持状态、书架和已接入的公开阅读工具。');
      let noteMessages, noteConfiguration, conversationMood = false;
      const noteVersions = new Map();
      const noteSourcesCurrent = () => {
        try {
          return (!noting || JSON.stringify({ model: store.getSetting('model'), persona: store.getSetting('persona') }) === noteConfiguration)
            && [...noteVersions].every(([id, signature]) => store.getMemoryVersionEvidence(id, ['owner'])?.signature === signature);
        }
        catch { return false; }
      };
      if (searchingExpressions) {
        if (Object.keys(args).some(key => !['query', 'items'].includes(key))) throw new Error('表情检索只接受关键词和当前场合目录。');
        args = { query: expressionSearchQuery(args.query), items: expressionSearchItems(args.items) };
      } else if (composing) {
        const identifiers = ['messageId', 'agendaId', 'memoryId'].filter(key => Object.hasOwn(args, key));
        const key = identifiers[0];
        if (scope !== 'owner' || actor !== 'owner' || excludeMessageId || identifiers.length !== 1
          || Object.keys(args).some(field => ![key, 'impulse'].includes(field))
          || typeof args[key] !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,127}$/.test(args[key])) throw new Error('主动拟聊只接受已验证创建人的消息、约定或旧主题标识。');
        const impulse = normalizeProactiveImpulse(args.impulse);
        if (key === 'agendaId' && impulse !== undefined) throw new Error('到期约定不接受陪伴节奏建议。');
        args = { [key]: args[key], ...(impulse ? { impulse } : {}) };
      } else if (recalling) {
        if (Object.keys(args).some(key => key !== 'query') || typeof args.query !== 'string' || !args.query.trim() || args.query.length > 500) throw new Error('记忆子代理只接受 1–500 字的查询。');
        args = { query: args.query.trim() };
      } else if (judging) {
        const item = args.input;
        if (typeof scope !== 'string' || !/^(owner|(?:group|person):[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,127})$/.test(scope)
          || (scope === 'owner' && !['owner', 'scheduler'].includes(actor))
          || Object.keys(args).some(key => key !== 'input') || !item || typeof item !== 'object' || Array.isArray(item)
          || Object.keys(item).some(key => !['kind', 'text', 'reply'].includes(key)) || !['reading', 'conversation'].includes(item.kind)
          || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 3000
          || (item.kind === 'reading' && (scope !== 'owner' || Object.hasOwn(item, 'reply')))
          || (item.kind === 'conversation' && (typeof item.reply !== 'string' || !item.reply.trim() || item.reply.length > 1500))) throw new Error('情绪评估只接受一个已核对场合的当次资料。');
        conversationMood = item.kind === 'conversation';
        noteMessages = [{ role: 'user', content: JSON.stringify({ input: item, mood: moodSnapshot(store) }) }];
        args = { messages: noteMessages };
      } else if (noting) {
        const item = args.reading;
        if (scope !== 'owner' || !['owner', 'scheduler'].includes(actor) || Object.keys(args).some(key => key !== 'reading')
          || !item || typeof item !== 'object' || Array.isArray(item)
          || Object.keys(item).some(key => !['title', 'url', 'excerpt', 'readAt', 'truncated', 'partCount', 'totalSavedChars', 'evidence', 'previousNotes'].includes(key))
          || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 500
          || typeof item.url !== 'string' || biliVideoUrl(item.url) !== item.url
          || typeof item.excerpt !== 'string' || !item.excerpt.trim() || item.excerpt.length > 8000
          || typeof item.readAt !== 'string' || !Number.isFinite(Date.parse(item.readAt))
          || typeof item.truncated !== 'boolean' || !Number.isSafeInteger(item.partCount) || item.partCount < 1 || item.partCount > 50
          || !Number.isSafeInteger(item.totalSavedChars) || item.totalSavedChars < item.excerpt.length || item.totalSavedChars > 1000000
          || item.evidence?.plugin !== 'dsh-bili-humanism' || JSON.stringify(item).length > 16000) throw new Error('DSH 笔记只接受当次公开 B站阅读摘录。');
        const supplied = item.previousNotes === undefined ? [] : item.previousNotes;
        if (!Array.isArray(supplied) || supplied.length > 3) throw new Error('DSH 笔记旧思考须为最多三条已核验资料。');
        const canonical = supplied.length ? store.listReadingReflections(['owner'], 10) : [];
        const previousNotes = supplied.map(previous => {
          if (!previous || typeof previous !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(previous))
            || Reflect.ownKeys(previous).length !== 6 || Reflect.ownKeys(previous).some(key => !['memoryId', 'title', 'note', 'sourceRef', 'createdAt', 'truncated'].includes(key))
            || typeof previous.memoryId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,127}$/.test(previous.memoryId) || noteVersions.has(previous.memoryId)
            || typeof previous.title !== 'string' || !previous.title.trim() || previous.title.length > 200
            || typeof previous.note !== 'string' || !previous.note.trim() || previous.note.length > 800
            || !publicReflectionSource(previous.sourceRef) || typeof previous.createdAt !== 'string' || typeof previous.truncated !== 'boolean') {
            throw new Error('DSH 笔记旧思考未通过来源核对。');
          }
          const original = canonical.find(note => note.memoryId === previous.memoryId);
          const evidence = store.getMemoryVersionEvidence(previous.memoryId, ['owner']), memory = evidence?.memory;
          if (!original || !memory || memory.scope !== 'owner' || memory.sourceType !== 'reflection' || memory.category !== 'reading-note'
            || memory.title !== original.title || memory.content !== original.note || memory.sourceRef !== original.sourceRef || memory.createdAt !== original.createdAt
            || previous.title !== original.title || previous.sourceRef !== original.sourceRef || previous.createdAt !== original.createdAt
            || previous.note !== original.note.slice(0, 800) || previous.truncated !== (original.note.length > 800)
            || typeof evidence.signature !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.signature)) throw new Error('DSH 笔记旧思考未通过来源核对。');
          noteVersions.set(previous.memoryId, evidence.signature);
          return { title: previous.title, note: previous.note, sourceRef: previous.sourceRef, createdAt: previous.createdAt, truncated: previous.truncated };
        });
        const { previousNotes: ignoredNotes, ...readingData } = item;
        noteMessages = [{ role: 'user', content: JSON.stringify({ ...readingData, ...(Object.hasOwn(item, 'previousNotes') ? { previousNotes } : {}) }) }];
        noteConfiguration = JSON.stringify({ model: store.getSetting('model'), persona: store.getSetting('persona') });
        args = { messages: noteMessages };
      } else if (browsing) {
        if (Object.keys(args).length || typeof selectVideo !== 'function') throw new Error('B站自主浏览需要栖忆选择候选，不能传入网址或其他参数。');
      } else if (reading) {
        if (Object.keys(args).some(key => key !== 'url') || typeof args.url !== 'string' || args.url.length > 4096) throw new Error('视频阅读只接受完整网址。');
        const url = biliVideoUrl(args.url);
        if (!url) throw new Error('请提供完整 B站 BV 视频网址。');
        args = { url };
      }
      const settings = config();
      if (searchingExpressions && settings.expressionPlugin !== 'dsh-meme') throw new Error('尚未配置 DSH 表情检索模块。');
      const feiyu = judging && conversationMood && settings.moodPlugin === 'dsh-feiyu-mood';
      if (!settings.enabled) throw new Error('尚未启用 DSH 插件运行层。');
      if (busy) throw new Error('已有 DSH 任务运行，请稍后再试。');
      signal?.throwIfAborted();
      if (reading) {
        const usage = readingStatus();
        if (!usage.remaining) throw new Error('已达到今日 DSH 阅读尝试上限，可在人格与设置中调整。');
        store.setSetting('dshReadingStatus', { day: usage.day, attempts: usage.attempts + 1, lastAttemptAt: new Date().toISOString() });
      }
      busy = true;
      let finish;
      drained = new Promise(accept => { finish = accept; });
      const taskController = new AbortController();
      const modelAccess = createDshModelAccess({ store, signal: taskController.signal, purpose: judging ? 'mood' : 'reading-note' });
      let workspace;
      try {
        const memoryAgent = recalling ? createMemoryAgentAccess({ store, scope, actor, query: args.query, signal: taskController.signal, excludeMessageId,
          ...(composing ? { purpose: 'proactive', ...args } : {}) }) : null;
        let cacheDirectory;
        const readonlyCredentials = reading ? readBiliCredentials({ dataDir }) : null;
        if (reading) {
          cacheDirectory = join(resolve(dataDir), 'dsh-cache', 'humanism');
          mkdirSync(cacheDirectory, { recursive: true });
          cacheDirectory = realpathSync(cacheDirectory);
        }
        // Disposable profile/cache; the authoritative memories stay in Memoria's database.
        workspace = mkdtempSync(join(settings.hostDirectory, '.memoria-job-'));
        for (const folder of ['home', 'appdata', 'localappdata', 'tmp', 'dsh']) mkdirSync(join(workspace, folder));
        const env = {};
        for (const [key, value] of Object.entries(process.env)) {
          if (['systemroot', 'windir', 'comspec', 'path', 'pathext', 'systemdrive', 'number_of_processors', 'processor_architecture'].includes(key.toLowerCase())) env[key] = value;
        }
        Object.assign(env, { HOME: join(workspace, 'home'), USERPROFILE: join(workspace, 'home'),
          APPDATA: join(workspace, 'appdata'), LOCALAPPDATA: join(workspace, 'localappdata'),
          TEMP: join(workspace, 'tmp'), TMP: join(workspace, 'tmp'), DSH_HOME: join(workspace, 'dsh') });
        return await new Promise((accept, reject) => {
          const child = spawn(settings.nodePath, [hostScript], { cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
          let result, authorizedNote, authorizedMood, failure, modelFailureMessage, received = false, selectionRequested = false, modelRequested = false, requests = 0, stderrBytes = 0;
          const agentRequestIds = new Set();
          let killTimer;
          const stop = message => {
            failure ||= new DshTaskError(message); taskController.abort(); child.kill();
            killTimer ||= setTimeout(() => child.kill('SIGKILL'), 2000);
            killTimer.unref();
          };
          cancelCurrent = () => stop('DSH 任务已取消。');
          const timeout = setTimeout(() => stop('DSH 任务超时，未自动重试。'), recalling ? 270000 : reading ? 110000 : modelTask ? 90000 : 30000);
          const abort = () => stop('DSH 任务已取消。');
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
          child.stderr.on('data', chunk => {
            stderrBytes += chunk.length;
            if (stderrBytes > 65536) stop('DSH 日志超过大小限制。');
          });
          child.on('error', () => stop('DSH 子进程未能启动。'));
          child.once('disconnect', () => {
            taskController.abort();
            if (!received) stop('DSH 连接已中断，未自动重试。');
          });
          child.on('spawn', () => child.send({ type: 'start', hostDirectory: settings.hostDirectory, workspace,
            ...(reading ? { cacheDirectory, ...(readonlyCredentials ? { readonlyCredentials } : {}) } : {}),
            ...(name === 'inspect' && settings.proactivePlugin ? { proactivePlugin: settings.proactivePlugin } : {}),
            ...(name === 'inspect' && settings.moodPlugin ? { moodPlugin: settings.moodPlugin } : {}),
            ...(name === 'inspect' && settings.expressionPlugin ? { expressionPlugin: settings.expressionPlugin } : {}),
            operation: composing ? { name: settings.proactivePlugin ? 'compose_proactive' : 'recall_memory', args: { query: proactiveQuery } }
              : { name: feiyu ? 'evaluate_mood_feiyu' : name, args } }));
          child.on('message', message => {
            if (!message || typeof message !== 'object' || Buffer.byteLength(JSON.stringify(message)) > (reading ? 2 * 1024 * 1024 : 100000)) return stop('DSH 返回格式无效或超过资料上限。');
            if (['agent-model', 'agent-memory'].includes(message.type)) {
              if (!recalling || received || !Number.isSafeInteger(message.id) || message.id < 1 || agentRequestIds.has(message.id)
                || Object.keys(message).some(key => !(message.type === 'agent-model' ? ['type', 'id'] : ['type', 'id', 'call']).includes(key))) return stop('DSH 子代理请求不属于本次任务。');
              agentRequestIds.add(message.id);
              Promise.resolve().then(() => message.type === 'agent-model' ? memoryAgent.complete() : memoryAgent.execute(message.call)).then(result => {
                if (!failure && child.connected) child.send({ type: `${message.type}-result`, id: message.id, result }, () => {});
              }).catch(error => stop(memoryAgentErrorMessage(error)));
            } else if (message.type === 'model') {
              if (!modelTask || received || modelRequested || !Number.isSafeInteger(message.id) || message.id < 1
                || Object.keys(message).some(key => !['type', 'id', 'args'].includes(key))
                || !message.args || Object.keys(message.args).some(key => !['messages', 'maxTokens'].includes(key))
                || message.args.maxTokens !== (judging ? 300 : 650) || JSON.stringify(message.args.messages) !== JSON.stringify(noteMessages)) return stop('DSH 模型请求不属于本次获准的任务。');
              if (!noteSourcesCurrent()) return stop('DSH 笔记来源或配置已变化，本次结果已取消。');
              modelRequested = true;
              modelAccess(message.args).then(result => {
                if (!noteSourcesCurrent()) return stop('DSH 笔记来源或配置已变化，本次结果已取消。');
                if (feiyu) {
                  try {
                    const proposal = validateMoodDelta(JSON.parse(result.text));
                    authorizedMood = { ...proposal, delta: Math.round(proposal.delta / 3) };
                  } catch {
                    const error = new Error('DSH_MODEL_INVALID_RESPONSE'); error.code = 'DSH_MODEL_INVALID_RESPONSE'; throw error;
                  }
                }
                authorizedNote = result.text;
                if (!failure && child.connected) child.send({ type: 'model-result', id: message.id, result }, () => {});
              }).catch(error => {
                modelFailureMessage = Object.hasOwn(modelErrors, error?.code) ? modelErrors[error.code] : modelErrors.DSH_MODEL_FAILED;
                if (!failure && child.connected) child.send({ type: 'model-result', id: message.id,
                  error: ['DSH_MODEL_LIMIT', 'DSH_MODEL_CANCELLED', 'DSH_MODEL_INVALID_RESPONSE'].includes(error.code) ? error.code : 'DSH_MODEL_FAILED' }, () => {});
              });
            } else if (message.type === 'select-video') {
              if (!browsing || selectionRequested || !Number.isSafeInteger(message.id) || message.id < 1
                || !Array.isArray(message.candidates) || message.candidates.length > 3) return stop('DSH 视频候选格式无效。');
              selectionRequested = true;
              const candidates = [];
              try {
                for (const item of message.candidates) {
                  if (!item || typeof item !== 'object' || typeof item.url !== 'string' || biliVideoUrl(item.url) !== item.url
                    || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 500
                    || typeof item.author !== 'string' || item.author.length > 200 || !Number.isFinite(item.duration) || item.duration <= 0) throw new Error();
                  candidates.push({ url: item.url, title: item.title, author: item.author, duration: item.duration });
                }
              } catch { return stop('DSH 视频候选格式无效。'); }
              Promise.resolve().then(() => selectVideo(candidates)).then(url => {
                if (url !== null && !candidates.some(item => item.url === url)) return stop('栖忆返回了无效的视频选择。');
                if (!failure && child.connected) child.send({ type: 'video-selection', id: message.id, url }, () => {});
              }).catch(() => stop('本次视频选择未完成，未自动重试。'));
            } else if (message.type === 'memory') {
              if (modelTask || recalling || searchingExpressions || ++requests > 10 || !memoryTools.includes(message.name) || !Number.isSafeInteger(message.id) || message.id < 1) return stop('DSH 记忆请求超出限制。');
              let response;
              try { response = { result: memory.execute(message.name, message.args) }; }
              catch (error) { response = { error: error.message }; }
              if (child.connected) child.send({ type: 'memory-result', id: message.id, ...response }, () => {});
            } else if (message.type === 'result' && !received) {
              if (recalling) {
                try {
                  const expected = memoryAgent.finalResult();
                  const value = message.result;
                  if (!value || Object.keys(value).some(key => !['text', 'completed', 'modelRequests', 'toolCalls'].includes(key)) || value.completed !== true
                    || value.text !== expected.text || value.modelRequests !== expected.modelRequests || value.toolCalls !== expected.toolCalls) throw new Error();
                  result = { ...expected, completed: true };
                } catch { return stop('DSH 未完成有效的原生记忆回合。'); }
              } else if (feiyu) {
                const value = message.result;
                if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1
                  || typeof value.text !== 'string' || value.text.length > 2000) return stop('DSH 未返回有效的原版心情评估。');
                result = { text: value.text };
              } else result = message.result;
              received = true;
            } else if (message.type === 'failure') stop(modelFailureMessage || (reading && typeof message.code === 'string' && Object.hasOwn(readingErrors, message.code)
              ? readingErrors[message.code] : 'DSH 核对未完成，请检查固定版本依赖与本机配置。'));
            else stop('DSH 返回了不支持的消息。');
          });
          child.on('close', code => {
            taskController.abort();
            clearTimeout(timeout); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
            if (failure || code !== 0 || !received) reject(failure || new Error('DSH 任务未正常完成。'));
            else if (!noteSourcesCurrent()) reject(new DshTaskError('DSH 笔记来源或配置已变化，本次结果已取消。'));
            else if (recalling && !result.sourcesCurrent()) reject(new DshTaskError(composing ? '主动拟聊的资料已变化。' : '记忆子代理使用的资料已变化，本次结果已取消。'));
            else if (modelTask && (!modelRequested || typeof authorizedNote !== 'string'
              || (feiyu ? !authorizedMood : result?.text !== authorizedNote))) reject(new DshTaskError('DSH 未返回有效的模型结果。'));
            else if (judging) {
              try {
                const proposal = validateMoodDelta(JSON.parse(result.text));
                if (feiyu && JSON.stringify(proposal) !== JSON.stringify(authorizedMood)) throw new Error();
                if (feiyu && JSON.stringify(config()) !== JSON.stringify(settings)) return reject(new DshTaskError('DSH 心情配置已变化，本次评估未应用。'));
                lastMoodEvaluation = { engine: feiyu ? 'dsh-feiyu-mood' : 'native',
                  kind: conversationMood ? 'conversation' : 'reading', completedAt: new Date().toISOString() };
                accept(proposal);
              } catch { reject(new DshTaskError('DSH 未返回有效的情绪变化。')); }
            } else {
              if (searchingExpressions) {
                try {
                  if (JSON.stringify(config()) !== JSON.stringify(settings)) throw new Error();
                  result = expressionSearchResult(result, args.items);
                } catch { return reject(new DshTaskError('DSH 表情检索结果或配置已失效。')); }
              }
              if (composing) lastProactiveTurn = { engine: settings.proactivePlugin || 'native', completedAt: new Date().toISOString() };
              accept(composing ? { ...result, engine: settings.proactivePlugin || 'native' } : result);
            }
          });
        });
      } finally {
        taskController.abort();
        try {
          if (workspace && dirname(resolve(workspace)) === settings.hostDirectory && realpathSync(workspace) === resolve(workspace)) rmSync(workspace, { recursive: true, force: true });
        } finally { busy = false; cancelCurrent = undefined; finish(); }
      }
    },
  };
}
