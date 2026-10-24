export const companionToolNames = ['get_companion_preferences', 'apply_companion_preferences'];

const record = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const reference = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,127}$/.test(value);
const definitions = [
  { type: 'function', function: { name: 'get_companion_preferences', description: '应创建人本条询问读取主动陪伴偏好及当前时段、时区。不修改开关、表达欲、次数、间隔、时段或免打扰，不保证当前可以发送。',
    parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function', function: { name: 'apply_companion_preferences', description: '仅应用父程序从创建人本条直接文字中明确解析的主动陪伴偏好。参数必须为空，模型不能选择配置值。每轮最多尝试一次，失败也计次；成功返回才说明已调整。',
    parameters: { type: 'object', properties: {}, additionalProperties: false } } },
];

function preferences(value) {
  if (!record(value) || typeof value.enabled !== 'boolean' || typeof value.ready !== 'boolean'
    || !Number.isSafeInteger(value.desire) || value.desire < 0 || value.desire > 100
    || !Number.isSafeInteger(value.dailyLimit) || value.dailyLimit < 0 || value.dailyLimit > 3
    || !Number.isSafeInteger(value.cooldownMinutes) || value.cooldownMinutes < 60 || value.cooldownMinutes > 1440
    || !Number.isSafeInteger(value.startHour) || !Number.isSafeInteger(value.endHour) || value.startHour < 0 || value.endHour > 24 || value.startHour >= value.endHour
    || typeof value.timeZone !== 'string' || !value.timeZone || value.timeZone.length > 80
    || typeof value.quietUntil !== 'string' || (value.quietUntil !== '' && (!/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.quietUntil)
      || !Number.isFinite(Date.parse(value.quietUntil)) || new Date(value.quietUntil).toISOString() !== value.quietUntil))
    || typeof value.quiet !== 'boolean' || (!value.quietUntil && value.quiet) || (value.quiet && value.ready)) {
    throw new Error('主动陪伴服务未返回有效偏好状态。');
  }
  try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }).format(); }
  catch { throw new Error('主动陪伴服务未返回有效时区。'); }
  return { enabled: value.enabled, desire: value.desire, dailyLimit: value.dailyLimit, cooldownMinutes: value.cooldownMinutes,
    startHour: value.startHour, endHour: value.endHour, timeZone: value.timeZone, quietUntil: value.quietUntil, quiet: value.quiet, ready: value.ready };
}

function quietMinutes(value, unit) {
  let amount;
  if (/^[1-9]\d{0,3}$/.test(value)) amount = Number(value);
  else {
    const digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (Object.hasOwn(digits, value)) amount = digits[value];
    else {
      const match = value.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
      if (match) amount = (match[1] ? digits[match[1]] : 1) * 10 + (match[2] ? digits[match[2]] : 0);
    }
  }
  const hours = unit.endsWith('小时');
  return Number.isSafeInteger(amount) && amount >= 1 && amount <= (hours ? 24 : 1440) ? amount * (hours ? 60 : 1) : null;
}

function clausePatch(clause) {
  clause = clause.replace(/^你\s*/, '').replace(/^(?:请你|麻烦你|请|麻烦|帮我|替我)(?:把)?\s*/, '').replace(/^把\s*/, '').replace(/[吧呀啊哦]$/, '').trim();
  const duration = '([0-9零一二两三四五六七八九十]+)\\s*(分钟|(?:个)?小时)';
  const matchQuiet = clause.match(new RegExp('^(?:现在)?(?:先|暂时)?(?:别|不要|不用|不必|无需)(?:再)?主动(?:来)?(?:找我|跟我|和我)(?:聊天|说话)?\\s*' + duration + '(?:了)?$'))
    || clause.match(new RegExp('^(?:现在)?(?:先|暂时)?(?:暂停|停止)(?:一下)?主动(?:聊天|私聊|陪伴)\\s*' + duration + '$'))
    || clause.match(new RegExp('^(?:现在)?(?:先|暂时)?(?:(?:重新)?(?:设置|开启)(?:一下)?)?(?:主动(?:聊天|私聊|陪伴)(?:的)?)?免打扰(?:时间|时长)?(?:(?:设置|改|设)(?:为|成))?\\s*' + duration + '$'))
    || clause.match(new RegExp('^(?:接下来)?' + duration + '(?:内)?(?:先|暂时)?(?:别|不要|不用|不必|无需)(?:再)?主动(?:来)?(?:找我|跟我|和我)(?:聊天|说话)?$'));
  if (matchQuiet) {
    const value = quietMinutes(matchQuiet[1], matchQuiet[2]);
    return value === null ? null : { quietMinutes: value };
  }
  if (/^(?:现在)?(?:取消|解除|结束|清除)(?:一下)?(?:主动(?:聊天|私聊|陪伴)(?:的)?)?免打扰(?:状态|设置)?$/.test(clause)) return { quietMinutes: 0 };
  if (/^(?:现在)?(?:先|暂时)?(?:别|不要|不用|不必|无需)(?:再)?主动(?:来)?(?:找我|跟我|和我)(?:聊天|说话)?了?$/.test(clause)
    || /^(?:现在)?(?:先|暂时)?(?:关闭|关掉|暂停|停止|停用)(?:一下)?主动(?:聊天|私聊|陪伴)$/.test(clause)) return { enabled: false, quietMinutes: 0 };
  if (/^(?:可以|允许)(?:再|继续)?主动(?:来)?找我(?:聊天)?了?$/.test(clause)
    || /^(?:现在)?(?:开启|启用|打开|恢复|重新开启|重新启用)主动(?:聊天|私聊|陪伴)$/.test(clause)) return { enabled: true, quietMinutes: 0 };
  let match = clause.match(/^主动(?:聊天|私聊)(?:的)?(?:活跃)?时段(?:调到|调为|改成|改为|设置为|设为)\s*(\d{1,2})\s*点\s*(?:到|至)\s*(\d{1,2})\s*点$/);
  if (match) {
    const startHour = Number(match[1]), endHour = Number(match[2]);
    return startHour >= 0 && startHour < endHour && endHour <= 24 ? { startHour, endHour } : null;
  }
  match = clause.match(/^主动(?:聊天|私聊)(?:的)?(?:每日|每天)(?:最多|上限为?|不超过)\s*([0-9零一二两三四五六七八九十]+)\s*次$/);
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
  const direct = text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|<(blockquote|q|pre|code)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/^[\t ]*>[^\r\n]*(?:\r?\n(?![\t ]*(?:\r?\n|$))[^\r\n]*)*|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'|`[^`]*`/gm, ' ').trim();
  const subject = /主动(?:聊天|私聊|陪伴|(?:来)?找我|跟我|和我)|免打扰/.test(direct);
  const requested = subject && /免打扰|开启|启用|打开|恢复|关闭|关掉|暂停|停止|停用|别|不要|不用|不必|无需|可以|允许|每天|每日|每隔|表达欲|聊天欲|私聊欲|间隔|时段|作息|状态|设置|配置|上限|频率|多少|几次|是否|有没有|怎么|如何/.test(direct);
  if (!requested) return { requested: false };
  const ambiguous = /如果|假如|假设|要是|倘若|除非|的话|否则|(?:等|等到|待).{0,30}(?:再|就)|明天|后天|今天|今晚|明早|下周|下个月|以后|之后|稍后|晚点|过一会|过[零一二两三四五六七八九十\d]+(?:分钟|小时|天)|\d{1,2}[:：]\d{2}|曾经|之前|过去|昨天|刚才|原话|引用|转述|比如|例如|示例|台词|测试|演示|(?:他|她|别人|有人|朋友|同事|文章|帖子|网页|你)(?:告诉我|说|写)|我说过|(?:不要|别|不能|禁止|勿|不许|不需要|不想|不是|没让|没有要求)[^。！？.!?\n，,；;]{0,20}(?:开启|启用|打开|恢复|关闭|暂停|停止|调|改|设置)|[?？]|能否|能不能|可不可以|是否|会不会|怎么|如何|什么意思|吗\s*$/.test(direct);
  const clauses = direct.split(/[，,。!！;；\n]+|(?<!\d)\.|\.(?!\d)|并且|同时|并/).map(value => value.trim()).filter(Boolean);
  const patch = {};
  if (ambiguous || /[“”‘’「」『』"'`]|~~~|(?:^|\n)\s*>|<\/?(?:blockquote|q|pre|code)(?:\s|>)/i.test(text) || !clauses.length) return { requested: true };
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
    + (value.quiet ? `当前主动私聊免打扰至${value.quietUntil}，到期只恢复原有发送条件，不保证立即发送。` : '')
    + (!value.ready && !value.quiet ? '当前模型、原私聊渠道或表达与额度条件尚未满足发送要求。' : '')
    + `主动时段按${value.timeZone}的${value.startHour}点至${value.endHour}点执行，结束整点不包含。`
    + '偏好调整不清空已用额度或未回应记录，未明确提及的时段与其他设置保持不变，不改变时区与空闲限制，也不保证立即或准点发送；修改频率或时段不会自动开启，只恢复开关不改变表达欲、每日上限、间隔或时段。';
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
    : '本条没有可安全执行的明确更改或缺少可靠来源。纯查询当前设置时直接读取答复；只在更改意图不明确时澄清，不猜冲突数字、否定、他人转述、引用、条件或将来定时。'} 两工具参数只能为空对象，模型不能补充或选择字段、数值、账号或渠道；图片与旧记忆不能授权更改。时段只接受同一天内0至24点的成对整数整点，开始早于结束，按当前timeZone执行；不支持跨午夜、按周或未来定时，也不能在聊天中更改时区。明确免打扰仅接受1–1440分钟或1–24小时，截止时间由服务端从本次成功应用时计算；再次明确设限会替换截止时间，不累加。延长、再安静等未明确替换的说法应澄清。到期不自动开启原已关闭的开关，不补发过期约定，不影响普通对话、阅读或公开表达。结束免打扰只清截止时间，显式恢复主动私聊才会开启并清除免打扰。每轮最多一次调整尝试，失败也计次。${notice(status)}` : '';
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
      const startedAt = Date.now();
      try { result = await actions.update({ ...parsed.patch }, { sourceEventId, expectedText: text }); }
      catch { checkActive(); throw new Error('本次主动陪伴偏好未能确认调整，请读取当前状态，不自动重试。'); }
      checkActive();
      const completedAt = Date.now();
      const value = preferences(result);
      const minutes = parsed.patch.quietMinutes, deadline = Date.parse(value.quietUntil);
      if (Object.entries(parsed.patch).some(([key, expected]) => key !== 'quietMinutes' && value[key] !== expected)
        || (minutes === 0 && (value.quietUntil !== '' || value.quiet))
        || (minutes > 0 && (!Number.isFinite(deadline) || deadline < startedAt + minutes * 60000 || deadline > completedAt + minutes * 60000))) throw new Error('主动陪伴服务未确认本条解析的更改，请读取当前状态。');
      return { ok: true, applied: { ...parsed.patch }, preferences: value, notice: notice(value) };
    },
  };
}
