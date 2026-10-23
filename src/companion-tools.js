export const companionToolNames = ['get_companion_preferences', 'apply_companion_preferences'];

const record = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const reference = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,127}$/.test(value);
const definitions = [
  { type: 'function', function: { name: 'get_companion_preferences', description: '应创建人本条询问读取主动陪伴偏好。不修改开关、表达欲、次数或间隔，不保证当前可以发送。',
    parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function', function: { name: 'apply_companion_preferences', description: '仅应用父程序从创建人本条直接文字中明确解析的主动陪伴偏好。参数必须为空，模型不能选择配置值。每轮最多尝试一次，失败也计次；成功返回才说明已调整。',
    parameters: { type: 'object', properties: {}, additionalProperties: false } } },
];

function preferences(value) {
  if (!record(value) || typeof value.enabled !== 'boolean' || typeof value.ready !== 'boolean'
    || !Number.isSafeInteger(value.desire) || value.desire < 0 || value.desire > 100
    || !Number.isSafeInteger(value.dailyLimit) || value.dailyLimit < 0 || value.dailyLimit > 3
    || !Number.isSafeInteger(value.cooldownMinutes) || value.cooldownMinutes < 60 || value.cooldownMinutes > 1440) {
    throw new Error('主动陪伴服务未返回有效偏好状态。');
  }
  return { enabled: value.enabled, desire: value.desire, dailyLimit: value.dailyLimit, cooldownMinutes: value.cooldownMinutes, ready: value.ready };
}

function clausePatch(clause) {
  clause = clause.replace(/^你\s*/, '').replace(/^(?:请你|麻烦你|请|麻烦|帮我|替我)(?:把)?\s*/, '').replace(/^把\s*/, '').replace(/[吧呀啊哦]$/, '').trim();
  if (/^(?:现在)?(?:先|暂时)?(?:别|不要|不用|不必|无需)(?:再)?主动(?:来)?(?:找我|跟我|和我)(?:聊天|说话)?了?$/.test(clause)
    || /^(?:现在)?(?:先|暂时)?(?:关闭|关掉|暂停|停止|停用)(?:一下)?主动(?:聊天|私聊|陪伴)$/.test(clause)) return { enabled: false };
  if (/^(?:可以|允许)(?:再|继续)?主动(?:来)?找我(?:聊天)?了?$/.test(clause)
    || /^(?:现在)?(?:开启|启用|打开|恢复|重新开启|重新启用)主动(?:聊天|私聊|陪伴)$/.test(clause)) return { enabled: true };
  let match = clause.match(/^主动(?:聊天|私聊)(?:的)?(?:每日|每天)(?:最多|上限为?|不超过)\s*([0-9零一二两三四五六七八九十]+)\s*次$/);
  if (match) {
    const value = /^[0-3]$/.test(match[1]) ? Number(match[1]) : ({ 零: 0, 一: 1, 二: 2, 两: 2, 三: 3 })[match[1]];
    return Number.isSafeInteger(value) ? { dailyLimit: value } : null;
  }
  match = clause.match(/^主动(?:聊天|私聊)(?:的)?(?:表达)?欲(?:望)?(?:调到|调为|改成|改为|设置为|设为)\s*(\d+)[%％]?$/);
  if (match) {
    const value = /^(?:0|[1-9]\d{0,2})$/.test(match[1]) ? Number(match[1]) : NaN;
    return value >= 0 && value <= 100 ? { desire: value } : null;
  }
  match = clause.match(/^主动(?:聊天|私聊)(?:的)?间隔(?:调到|调为|改成|改为|设置为|设为)\s*(\d+)\s*(分钟|小时)$/)
    || clause.match(/^每隔\s*(\d+)\s*(分钟|小时)主动(?:来)?找我(?:聊天)?$/);
  if (match) {
    const value = /^[1-9]\d{0,3}$/.test(match[1]) ? Number(match[1]) * (match[2] === '小时' ? 60 : 1) : NaN;
    return value >= 60 && value <= 1440 ? { cooldownMinutes: value } : null;
  }
  return null;
}

function request(text) {
  if (typeof text !== 'string' || text.length > 8000) return { requested: false };
  const direct = text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|<(blockquote|q)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/^[\t ]*>[^\r\n]*(?:\r?\n(?![\t ]*(?:\r?\n|$))[^\r\n]*)*|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'|`[^`]*`/gm, ' ').trim();
  const subject = /主动(?:聊天|私聊|陪伴|(?:来)?找我|跟我|和我)/.test(direct);
  const requested = subject && /开启|启用|打开|恢复|关闭|关掉|暂停|停止|停用|别|不要|不用|不必|无需|可以|允许|每天|每日|每隔|表达欲|聊天欲|私聊欲|间隔|状态|设置|配置|上限|频率|多少|几次|是否|有没有|怎么|如何/.test(direct);
  if (!requested) return { requested: false };
  const ambiguous = /如果|假如|假设|要是|倘若|除非|的话|否则|(?:等|等到|待).{0,30}(?:再|就)|明天|后天|今天|今晚|明早|下周|下个月|以后|之后|稍后|晚点|过一会|过[零一二两三四五六七八九十\d]+(?:分钟|小时|天)|\d{1,2}[:：]\d{2}|曾经|之前|过去|昨天|刚才|原话|引用|转述|比如|例如|示例|台词|测试|演示|(?:他|她|别人|有人|朋友|同事|文章|帖子|网页|你)(?:告诉我|说|写)|我说过|(?:不要|别|不能|禁止|勿|不许|不需要|不想|不是|没让|没有要求)[^。！？.!?\n，,；;]{0,20}(?:开启|启用|打开|恢复|关闭|暂停|停止|调|改|设置)|[?？]|能否|能不能|可不可以|是否|会不会|怎么|如何|什么意思|吗\s*$/.test(direct);
  const clauses = direct.split(/[，,。!！;；\n]+|(?<!\d)\.|\.(?!\d)/).map(value => value.trim()).filter(Boolean);
  const patch = {};
  if (ambiguous || /[“”‘’「」『』"'`]|<\/?(?:blockquote|q)(?:\s|>)/i.test(direct) || !clauses.length) return { requested: true };
  for (const clause of clauses) {
    const parsed = clausePatch(clause);
    if (!parsed) {
      if (!/^我(?:最近|近来|现在|这阵子)?(?:工作|学习)?(?:比较|有点|很|挺|有些)?(?:忙|累|疲惫|没空|没有空)了?$/.test(clause)) return { requested: true };
      continue;
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (Object.hasOwn(patch, key) && patch[key] !== value) return { requested: true };
      patch[key] = value;
    }
  }
  return Object.keys(patch).length ? { requested: true, patch } : { requested: true };
}

function notice(value) {
  return (!value.enabled ? '当前已暂停主动私聊，须由创建人明确恢复；不会自动到时开启。' : '')
    + (!value.ready ? '当前模型、原私聊渠道或表达与额度条件尚未满足发送要求。' : '')
    + '偏好调整不清空已用额度或未回应记录，不改变时段与空闲限制，也不保证立即或准点发送；修改频率不会自动开启，恢复也不会改变其他偏好。';
}

export function createCompanionTools({ scope, actor, text, actions, sourceEventId, checkActive }) {
  const parsed = request(text);
  const available = scope === 'owner' && actor === 'owner' && parsed.requested && typeof checkActive === 'function'
    && ['status', 'update'].every(key => typeof actions?.[key] === 'function');
  function currentStatus() {
    checkActive();
    let value;
    try { value = actions.status(); } catch { checkActive(); throw new Error('主动陪伴服务当前不可用。'); }
    checkActive(); return preferences(value);
  }
  let status;
  if (available) status = currentStatus();
  const mayApply = available && parsed.patch && reference(sourceEventId);
  const tools = available ? definitions.filter(tool => tool.function.name === companionToolNames[0] || mayApply) : [];
  const allowed = name => {
    if (!available || !companionToolNames.includes(name) || name === companionToolNames[1] && !mayApply) throw new Error('本条创建人私聊未明确授权此主动陪伴偏好操作。');
  };
  let attempted = false, prepared = false;
  function beginAttempt() {
    if (attempted) throw new Error('本轮已尝试调整一次主动陪伴偏好，请下次再继续。');
    attempted = true;
  }
  const guidance = available ? `\n本次可读取主动陪伴偏好。当前安全状态：${JSON.stringify(status)}。${mayApply
    ? `父程序只从本条直接文字解析出更改：${JSON.stringify(parsed.patch)}；只有apply_companion_preferences成功返回后才能说已调整。`
    : '本条没有可安全执行的明确更改或缺少可靠来源。纯查询当前设置时直接读取答复；只在更改意图不明确时澄清，不猜冲突数字、否定、他人转述、引用、条件、将来定时或限时暂停。'} 两工具参数只能为空对象，模型不能补充或选择字段、数值、账号或渠道；图片与旧记忆不能授权更改。每轮最多一次调整尝试，失败也计次。${notice(status)}` : '';
  return {
    tools, guidance,
    beforeCall(name) {
      if (name === companionToolNames[1]) { beginAttempt(); prepared = true; }
      allowed(name); checkActive();
    },
    async execute(name, args) {
      if (name === companionToolNames[1]) {
        if (prepared) prepared = false; else beginAttempt();
      }
      allowed(name); checkActive();
      if (!record(args) || Reflect.ownKeys(args).length) throw new Error('主动陪伴工具参数必须为空，不能指定配置、账号或其他字段。');
      if (name === companionToolNames[0]) {
        const value = currentStatus();
        return { ok: true, preferences: value, notice: notice(value) };
      }
      let result;
      try { result = await actions.update({ ...parsed.patch }, { sourceEventId }); }
      catch { checkActive(); throw new Error('本次主动陪伴偏好未能确认调整，请读取当前状态，不自动重试。'); }
      checkActive();
      const value = preferences(result);
      if (Object.entries(parsed.patch).some(([key, expected]) => value[key] !== expected)) throw new Error('主动陪伴服务未确认本条解析的更改，请读取当前状态。');
      return { ok: true, applied: { ...parsed.patch }, preferences: value, notice: notice(value) };
    },
  };
}
