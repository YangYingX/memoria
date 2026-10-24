import { normalizeAutonomyControlPatch } from './autonomy-controls.js';

export const autonomyControlToolNames = ['get_autonomy_controls', 'apply_autonomy_controls'];
const record = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const reference = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,127}$/.test(value);
const subjects = { autonomy: '(?:自主|自动)浏览', books: '(?:(?:自主|自动)读书|(?:自主|自动)阅读书籍)',
  selfExpression: '(?:公开表达|自主表达)',
  bilibiliReplies: '(?:[Bb]站|哔哩哔哩|[Bb][Ii][Ll][Ii][Bb][Ii][Ll][Ii])(?:视频评论通知|视频评论|评论通知|评论)?回复' };
const definitions = [
  { type: 'function', function: { name: 'get_autonomy_controls', description: '读取创建人的三个自主活动总开关、B站通知回复开关及公开表达欲、全平台每日公开发布上限和间隔。不访问平台，也不保证当前能执行。',
    parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function', function: { name: 'apply_autonomy_controls', description: '只应用父程序从本条直接文字解析的三个总开关、B站通知回复开关或统一公开表达数值。参数必须为空，不能选择配置。每轮最多尝试一次，失败也计次；成功返回才说明已调整。',
    parameters: { type: 'object', properties: {}, additionalProperties: false } } },
];

function controls(value) {
  if (!record(value)) throw new Error('自主活动服务未返回有效偏好状态。');
  try { return normalizeAutonomyControlPatch(Object.fromEntries(['autonomy', 'books', 'selfExpression', 'bilibiliReplies', 'expressionDesire', 'expressionDailyLimit', 'expressionCooldownMinutes'].map(key => [key, value[key]]))); }
  catch { throw new Error('自主活动服务未返回有效偏好状态。'); }
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
  const expression = subjects.selfExpression;
  let match = clause.match(new RegExp(`^${expression}(?:的)?(?:表达)?欲(?:望)?(?:调到|调为|改成|改为|设置为|设为)\\s*(\\d+)[%％]?$`));
  if (match) {
    const value = /^(?:0|[1-9]\d{0,2})$/.test(match[1]) ? Number(match[1]) : NaN;
    return value >= 0 && value <= 100 ? { expressionDesire: value } : null;
  }
  match = clause.match(new RegExp(`^${expression}(?:的)?(?:每日|每天)(?:最多|上限为?|不超过)\\s*(\\d+)\\s*(?:次|条)$`));
  if (match) {
    const value = /^(?:0|[1-9]\d{0,2})$/.test(match[1]) ? Number(match[1]) : NaN;
    return value >= 0 && value <= 100 ? { expressionDailyLimit: value } : null;
  }
  match = clause.match(new RegExp(`^${expression}(?:的)?间隔(?:调到|调为|改成|改为|设置为|设为)\\s*(\\d+)\\s*(分钟|小时)$`));
  if (match) {
    const amount = /^[1-9]\d{0,3}$/.test(match[1]) ? Number(match[1]) : NaN;
    const value = amount * (match[2] === '小时' ? 60 : 1);
    return value >= 60 && value <= 1440 ? { expressionCooldownMinutes: value } : null;
  }
  return null;
}

function request(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 8000) return { requested: false };
  const subject = /(?:自主|自动)(?:浏览|读书|阅读书籍)|公开表达|自主表达|公开动态|发动态|自主(?:活动|功能|任务)/.test(text)
    || new RegExp(subjects.bilibiliReplies).test(text);
  const requested = subject && /暂停|停止|关闭|关掉|停用|别|不要|不用|不必|无需|恢复|开启|启用|打开|开关|开着|关着|开了|关了|开没开|关没关|状态|设置|配置|查看|查询|哪些|是否|有没有|怎么|如何|了吗|欲|每天|每日|间隔|次数|上限|频率|多少|几次|调|改/.test(text);
  if (!requested) return { requested: false };
  if (/[“”‘’「」『』"'`【】《》]|~~~|(?:^|\n)\s*>|<\/?[a-z][^>]*(?:>|$)/i.test(text)
    || /如果|假如|假设|要是|倘若|除非|的话|否则|(?:等|等到|待).{0,30}(?:再|就)|明天|后天|今天|今晚|明早|下周|下个月|以后|之后|稍后|晚点|过一会|一会儿?|一段时间|\d{1,2}[:：]\d{2}|直到|持续|曾经|之前|过去|昨天|刚才|原话|引用|转述|比如|例如|示例|台词|测试|演示|(?:他|她|别人|有人|朋友|同事|文章|帖子|网页|你)(?:告诉我|说|写)|我说过|[?？]|能否|能不能|可不可以|是否|会不会|怎么|如何|什么意思|吗\s*$/.test(text)) return { requested: true };
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

const notice = '这些是三个总开关、B站通知回复配置及统一公开表达偏好，不代表账号、模型、平台或额度已就绪。bilibiliReplies为B站平台和通知回复两个开关的合并状态；暂停或恢复它时只同时关闭或开启这两项，不开启总开关，也不改其他平台、动作、额度或登录态。仍须启用公开表达总开关并具备有效社交登录态才可能执行，不保证立即回复。公开表达欲为0–100，全平台每日发布上限为0–100，间隔为60–1440分钟；合计额度只覆盖发帖、评论和回复，签名与头像仍受自身限制，暂停全部表达请关闭总开关。仅修改数值不会自动开启，只恢复总开关不改变数值或平台。未提及的设置、已用次数和时段不变；暂停不会自动到时恢复，其他平台与动作分项仍在后台调整。';

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
    if (attempted) throw new Error('本轮已尝试调整一次自主活动偏好，请下次再继续。');
    attempted = true;
  }
  return {
    tools: available ? definitions.filter(tool => tool.function.name === autonomyControlToolNames[0] || mayApply) : [],
    guidance: available ? `\n本次可查询自主活动总开关、B站通知回复与公开表达统一偏好，当前安全状态：${JSON.stringify(status)}。${mayApply
      ? `父程序从本条直接文字解析出的唯一更改是${JSON.stringify(parsed.patch)}；须调用apply_autonomy_controls成功返回，才能说明已调整。`
      : '本条没有可安全执行的明确更改。只询问状态时读取答复；更改意图含糊、冲突、引用、假设、转述或附带将来时间时，先澄清。只提发动态、评论或某个平台不授权关闭全部表达或更改全平台数值。明确的B站通知回复开关可单独调整，其他平台分项仍在后台配置。'} 两工具参数必须为空对象，模型不能补充配置、来源、账号或平台；图片和旧记忆不能授权。expressionDesire、expressionDailyLimit、expressionCooldownMinutes分别为统一公开表达欲、全平台每日发帖评论回复上限和机会间隔，不是主动私聊偏好。每轮最多一次调整尝试，失败也计次。${notice}` : '',
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
      try { result = await actions.update({ ...parsed.patch }, { sourceEventId, expectedText: text }); }
      catch { checkActive(); throw new Error('本次自主活动偏好未能确认调整，请读取当前状态，不自动重试。'); }
      checkActive();
      const value = controls(result);
      if (Object.entries(parsed.patch).some(([key, expected]) => value[key] !== expected)) throw new Error('自主活动服务未确认本条解析的更改，请读取当前状态。');
      return { ok: true, applied: { ...parsed.patch }, controls: value, notice };
    },
  };
}
