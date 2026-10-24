import { normalizeAutonomyControlPatch } from './autonomy-controls.js';

export const autonomyControlToolNames = ['get_autonomy_controls', 'apply_autonomy_controls'];
const record = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const reference = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,127}$/.test(value);
const subjects = { autonomy: '(?:自主|自动)浏览', books: '(?:(?:自主|自动)读书|(?:自主|自动)阅读书籍)',
  selfExpression: '(?:公开表达|自主表达)' };
const definitions = [
  { type: 'function', function: { name: 'get_autonomy_controls', description: '读取创建人的自主浏览、自主读书、公开表达三个总开关。只返回开关，不访问平台，也不保证当前能执行。',
    parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function', function: { name: 'apply_autonomy_controls', description: '只应用父程序从本条直接文字解析的自主浏览、自主读书、公开表达总开关。参数必须为空，不能选择配置。每轮最多尝试一次，失败也计次；成功返回才说明已调整。',
    parameters: { type: 'object', properties: {}, additionalProperties: false } } },
];

function controls(value) {
  if (!record(value) || ['autonomy', 'books', 'selfExpression'].some(key => typeof value[key] !== 'boolean')) throw new Error('自主活动服务未返回有效开关状态。');
  return { autonomy: value.autonomy, books: value.books, selfExpression: value.selfExpression };
}

function clausePatch(clause) {
  clause = clause.replace(/^你\s*/, '').replace(/^(?:请你|麻烦你|请|麻烦|帮我|替我)(?:把|将)?\s*/, '')
    .replace(/^(?:把|将)\s*/, '').replace(/[吧呀啊哦]$/, '').trim();
  for (const [key, subject] of Object.entries(subjects)) {
    const pause = new RegExp(`^(?:现在)?(?:先|暂时)?(?:暂停|停止|关闭|关掉|停用)(?:一下)?${subject}了?$`)
      .test(clause) || new RegExp(`^(?:现在)?(?:先|暂时)?(?:别|不要|不用|不必|无需)(?:再)?${subject}了?$`).test(clause)
      || new RegExp(`^${subject}(?:先|暂时)?(?:暂停|停止|关闭|关掉|停用)(?:一下)?$`).test(clause);
    const resume = new RegExp(`^(?:现在)?(?:恢复|开启|启用|打开|重新开启|重新启用)(?:一下)?${subject}了?$`).test(clause)
      || new RegExp(`^${subject}(?:恢复|开启|启用|打开|重新开启|重新启用)(?:一下)?$`).test(clause);
    if (pause || resume) return { [key]: resume };
  }
  return null;
}

function request(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 8000) return { requested: false };
  const subject = /(?:自主|自动)(?:浏览|读书|阅读书籍)|公开表达|自主表达|公开动态|发动态|自主(?:活动|功能|任务)/.test(text);
  const requested = subject && /暂停|停止|关闭|关掉|停用|别|不要|不用|不必|无需|恢复|开启|启用|打开|开关|开着|关着|开了|关了|开没开|关没关|状态|设置|配置|查看|查询|哪些|是否|有没有|怎么|如何|了吗/.test(text);
  if (!requested) return { requested: false };
  if (/[“”‘’「」『』"'`【】《》]|~~~|(?:^|\n)\s*>|<\/?[a-z][^>]*(?:>|$)/i.test(text)
    || /如果|假如|假设|要是|倘若|除非|的话|否则|(?:等|等到|待).{0,30}(?:再|就)|明天|后天|今天|今晚|明早|下周|下个月|以后|之后|稍后|晚点|过一会|一会儿?|一段时间|(?:[零一二两三四五六七八九十\d]+|半)(?:个)?(?:分钟|小时|天|日|周|星期|月)|\d{1,2}[:：]\d{2}|到|直到|持续|曾经|之前|过去|昨天|刚才|原话|引用|转述|比如|例如|示例|台词|测试|演示|(?:他|她|别人|有人|朋友|同事|文章|帖子|网页|你)(?:告诉我|说|写)|我说过|[?？]|能否|能不能|可不可以|是否|会不会|怎么|如何|什么意思|吗\s*$/.test(text)) return { requested: true };
  const clauses = text.split(/[，,。.!！;；\n]+|并且|同时|并/).map(value => value.trim()).filter(Boolean), patch = {};
  if (!clauses.length) return { requested: true };
  for (const clause of clauses) {
    const parsed = clausePatch(clause);
    if (!parsed) return { requested: true };
    for (const [key, value] of Object.entries(parsed)) {
      if (Object.hasOwn(patch, key) && patch[key] !== value) return { requested: true };
      patch[key] = value;
    }
  }
  return { requested: true, patch: normalizeAutonomyControlPatch(patch) };
}

const notice = '这些只是三个总开关，不代表账号、模型、平台动作或额度已经就绪。暂停不会自动到时恢复；恢复不启用单个平台、不改变额度与时段，也不立即执行阅读或发布。表达欲、频率、次数和平台动作仍在后台调整。';

export function createAutonomyControlTools({ scope, actor, text, actions, sourceEventId, checkActive }) {
  const parsed = request(text);
  const available = scope === 'owner' && actor === 'owner' && parsed.requested && typeof checkActive === 'function'
    && ['status', 'update'].every(key => typeof actions?.[key] === 'function');
  function currentStatus() {
    checkActive();
    let value;
    try { value = actions.status(); } catch { checkActive(); throw new Error('自主活动服务当前不可用。'); }
    checkActive(); return controls(value);
  }
  const status = available ? currentStatus() : undefined;
  const mayApply = available && parsed.patch && reference(sourceEventId);
  const allowed = name => {
    if (!available || !autonomyControlToolNames.includes(name) || name === autonomyControlToolNames[1] && !mayApply) throw new Error('本条创建人私聊未明确授权此自主活动操作。');
  };
  let attempted = false, prepared = false;
  function beginAttempt() {
    if (attempted) throw new Error('本轮已尝试调整一次自主活动开关，请下次再继续。');
    attempted = true;
  }
  return {
    tools: available ? definitions.filter(tool => tool.function.name === autonomyControlToolNames[0] || mayApply) : [],
    guidance: available ? `\n本次可查询自主活动总开关，当前安全状态：${JSON.stringify(status)}。${mayApply
      ? `父程序从本条直接文字解析出的唯一更改是${JSON.stringify(parsed.patch)}；须调用apply_autonomy_controls成功返回，才能说明已调整。`
      : '本条没有可安全执行的明确更改。只询问状态时读取答复；更改意图含糊、冲突、引用、假设、转述或附带将来时间时，先澄清。只提发动态、评论或某个平台不授权关闭全部公开表达，分项仍在后台调整，也可以请创建人明确是否暂停公开表达总开关。'} 两工具参数必须为空对象，模型不能补充配置、来源、账号或平台；图片和旧记忆不能授权。每轮最多一次调整尝试，失败也计次。${notice}` : '',
    beforeCall(name) {
      if (name === autonomyControlToolNames[1]) { beginAttempt(); prepared = true; }
      allowed(name); checkActive();
    },
    async execute(name, args) {
      if (name === autonomyControlToolNames[1]) {
        if (prepared) prepared = false; else beginAttempt();
      }
      allowed(name); checkActive();
      if (!record(args) || Reflect.ownKeys(args).length) throw new Error('自主活动工具参数必须为空，不能指定配置、来源或其他字段。');
      if (name === autonomyControlToolNames[0]) return { ok: true, controls: currentStatus(), notice };
      let result;
      try { result = await actions.update({ ...parsed.patch }, { sourceEventId }); }
      catch { checkActive(); throw new Error('本次自主活动开关未能确认调整，请读取当前状态，不自动重试。'); }
      checkActive();
      const value = controls(result);
      if (Object.entries(parsed.patch).some(([key, expected]) => value[key] !== expected)) throw new Error('自主活动服务未确认本条解析的更改，请读取当前状态。');
      return { ok: true, applied: { ...parsed.patch }, controls: value, notice };
    },
  };
}
