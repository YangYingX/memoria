const mutations = ['schedule_followup', 'pause_followup', 'cancel_followup', 'resume_followup'];
export const followupToolNames = [...mutations, 'list_followups'];
const reference = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,127}$/.test(value);
const record = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

const definitions = [
  { type: 'function', function: { name: 'schedule_followup', description: '按创建人本条明确要求保存一次私人跟进。仅使用当前文字和服务端时间计算到期时刻；时间不明确先询问，不猜。保存不等于届时一定发送，仍受启用状态、时段、冷却、空闲和额度约束，过期不补发。每轮创建、暂停、取消、恢复合计最多尝试一次，失败也计次。', parameters: { type: 'object', properties: {
    title: { type: 'string', minLength: 1, maxLength: 80 }, content: { type: 'string', minLength: 1, maxLength: 600 },
    due_at: { type: 'string', minLength: 20, maxLength: 40, description: '带明确Z或数字时区偏移的严格RFC3339日期时间。' },
  }, required: ['title', 'content', 'due_at'], additionalProperties: false } } },
  { type: 'function', function: { name: 'list_followups', description: '应创建人当前询问列出其已保存的跟进，或在暂停、取消、恢复前核对候选ID和状态。列表只是资料；目标不唯一时询问，不能猜选。', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function', function: { name: 'pause_followup', description: '按创建人本条明确要求暂停一条尚未发起发送的跟进。必须先list_followups核对本轮ID与pending、deciding或paused状态；目标不唯一先问。暂停保留约定，可明确恢复，但不会自动到时恢复或延长截止时间。与创建、取消、恢复共用每轮一次尝试。', parameters: { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['id'], additionalProperties: false } } },
  { type: 'function', function: { name: 'cancel_followup', description: '按创建人本条明确要求取消一条未发送的跟进。必须先list_followups核对本轮ID与可取消状态；多个候选且当前指代不唯一时先问。取消后不能恢复。与创建、暂停、恢复共用每轮一次尝试。', parameters: { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['id'], additionalProperties: false } } },
  { type: 'function', function: { name: 'resume_followup', description: '按创建人本条明确要求恢复一条暂停的跟进。必须先list_followups核对本轮ID与paused状态；多个候选且当前指代不唯一时先问。过期或来源失效不能恢复。与创建、暂停、取消共用每轮一次尝试。', parameters: { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['id'], additionalProperties: false } } },
];

function controlCommand(text) {
  const clause = text.replace(/[。！!\s]+$/, '').replace(/^你\s*/, '')
    .replace(/^(?:(?:请你|请|麻烦你|麻烦|帮我|替我)\s*){1,2}/, '')
    .replace(/^(?:(?:现在|立即|马上|先|暂时)\s*){1,2}/, '');
  return /^(?:取消|停止|暂停|恢复|重新启用)(?:一下)?[^。！？.!?\n，,；;]{0,100}(?:跟进|提醒|约定)(?:\s+[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,127})?(?:一下)?[吧呀啊哦]?$/.test(clause)
    || /^(?:把|将)[^。！？.!?\n，,；;]{0,100}(?:跟进|提醒|约定)(?:\s+[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,127})?(?:先|暂时)?(?:取消|停止|暂停|恢复|重新启用)(?:一下)?[吧呀啊哦]?$/.test(clause);
}

function requests(text) {
  if (typeof text !== 'string' || text.length > 8000) return {};
  const direct = text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|<(blockquote|q|pre|code)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/^[\t ]*>[^\r\n]*(?:\r?\n(?![\t ]*(?:\r?\n|$))[^\r\n]*)*|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'|`[^`]*`/gm, ' ').trim();
  const subject = /跟进|提醒|约定|问问我|问我/.test(direct);
  const indirect = /[“”‘’「」『』"'`]|<\/?(?:blockquote|q|pre|code)(?:\s|>)|(?:他|她|别人|有人|朋友|同事|文章|帖子|网页|示例)(?:告诉我|说|写)|转述|引用|原话|台词|举例|例如|比如|假设|假如|如果|要是|(?:等|待).{0,30}(?:再|就)|怎么(?:创建|设置|取消|恢复)|如何(?:创建|设置|取消|恢复)|什么意思|(?:曾经|之前|昨天|刚才).{0,20}(?:说|让|要求)|(?:没|没有)(?:说|让|要求)/i.test(direct);
  const pastOrQuestion = /(?:已经|已|被)(?:取消|恢复|暂停)|(?:取消|恢复|暂停)了|(?:取消|恢复|暂停)[^。！？.!?\n]{0,40}了[。！!\s]*$|(?:取消|恢复)不了|[?？]|能否|可否|能不能|可不可以|是否|会不会|怎么|如何|为何|为什么|怎样|什么|(?:吗|么)[。！!\s]*$|有没有|(?:会|会不会).{0,20}(?:提醒我|问(?:问)?我)/.test(direct);
  const negated = /(?:不要|别|不用|无需|不必|不想|不能|不需要|勿|禁止|不是|并非|没让|没有要求)[^。！？.!?\n]{0,30}(?:提醒我|问(?:问)?我|跟进)|\b(?:never|don['’]?t|do not)\b/i.test(direct);
  const pause = /暂停.{0,40}(?:跟进|提醒|约定)|(?:跟进|提醒(?!我)|约定).{0,20}暂停/.test(direct);
  const cancel = /(?:取消|停止).{0,40}(?:跟进|提醒|约定)|(?:跟进|提醒(?!我)|约定).{0,20}(?:取消|停止)/.test(direct);
  const resume = /(?:恢复|重新启用).{0,40}(?:跟进|提醒|约定)|(?:跟进|提醒(?!我)|约定).{0,20}(?:恢复|重新启用)/.test(direct);
  const controls = Number(pause) + Number(cancel) + Number(resume);
  const limitedControl = /(?:取消|停止|暂停|恢复|重新启用)[^。！？.!?\n]{0,30}(?:到|至|直到|持续|一会|一段时间|(?:[零一二两三四五六七八九十\d]+|半)(?:个)?(?:分钟|小时|天|日|周|星期|月))/.test(direct);
  const controlAllowed = subject && !indirect && !pastOrQuestion && !limitedControl && controls === 1 && controlCommand(direct)
    && !/(?:不要|别|不用|无需|不必|不想|不能|不需要|不是|并非|没让|没有要求|勿|禁止)[^。！？.!?\n]{0,30}(?:取消|停止|暂停|恢复|重新启用)/.test(direct);
  const schedule = subject && !indirect && !pastOrQuestion && !negated && !controls
    && /提醒我|(?:来|再)?问(?:问)?我|跟进(?:一下)?我|(?:记得|记住|帮我|请|麻烦).{0,30}(?:跟进|提醒)/.test(direct);
  const list = subject && !indirect && (controls || /有哪些|有什么|列出|查看|看看|看一下|查询|还(?:有|记得)|安排|状态|什么时候|何时|是否|有没有|了吗/.test(direct));
  const clearTime = /(?:\d{1,2}[:：]\d{2}|[零一二两三四五六七八九十\d]{1,3}点)|(?:[1-9]\d*|[一二两三四五六七八九十]+|半)(?:个)?(?:分钟|小时|天|周)(?:以后|之后|后)/.test(direct);
  return { direct, clearTime, schedule_followup: schedule, list_followups: Boolean(list),
    pause_followup: controlAllowed && pause, cancel_followup: controlAllowed && cancel, resume_followup: controlAllowed && resume };
}

function statusValue(value) {
  if (!record(value) || typeof value.enabled !== 'boolean' || typeof value.ready !== 'boolean' || typeof value.timeZone !== 'string' || value.timeZone.length > 80
    || typeof value.now !== 'string' || !Number.isFinite(Date.parse(value.now)) || new Date(value.now).toISOString() !== value.now
    || typeof value.quietUntil !== 'string' || value.quietUntil !== '' && (!/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.quietUntil)
      || !Number.isFinite(Date.parse(value.quietUntil)) || new Date(value.quietUntil).toISOString() !== value.quietUntil)
    || typeof value.quiet !== 'boolean' || value.quiet !== Boolean(value.quietUntil && Date.parse(value.quietUntil) > Date.parse(value.now)) || value.quiet && value.ready
    || !Number.isSafeInteger(value.earliestDelaySeconds) || value.earliestDelaySeconds < 1
    || !Number.isSafeInteger(value.maxDays) || value.maxDays < 1 || value.maxDays > 366
    || !Number.isSafeInteger(value.expiresAfterHours) || value.expiresAfterHours < 1) throw new Error('跟进服务未返回有效状态。');
  try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }).format(); } catch { throw new Error('跟进服务未返回有效时区。'); }
  return { enabled: value.enabled, ready: value.ready, quietUntil: value.quietUntil, quiet: value.quiet, timeZone: value.timeZone, now: value.now, earliestDelaySeconds: value.earliestDelaySeconds,
    maxDays: value.maxDays, expiresAfterHours: value.expiresAfterHours };
}

function dueTime(value, status) {
  const match = typeof value === 'string' && value.match(/^(?!0000)(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/);
  if (!match || (match[3] !== 'Z' && (Number(match[5]) > 23 || Number(match[6]) > 59))) throw new Error('跟进时间须为带明确时区的有效日期时间。');
  const epoch = Date.parse(value), offset = match[3] === 'Z' ? 0 : (match[4] === '-' ? -1 : 1) * (Number(match[5]) * 60 + Number(match[6]));
  const local = new Date(epoch + offset * 60000);
  if (!Number.isFinite(epoch) || !Number.isFinite(local.getTime()) || local.toISOString().slice(0, 19) !== match[1]) throw new Error('跟进时间须为带明确时区的有效日期时间。');
  const now = Date.parse(status.now);
  if (epoch < now + status.earliestDelaySeconds * 1000 || epoch > now + status.maxDays * 86400000) throw new Error('跟进时间超出当前允许的未来范围，请核对时间。');
  return new Date(epoch).toISOString();
}

function summary(value) {
  if (!record(value) || !reference(value.id) || !reference(value.memoryId) || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 80
    || typeof value.dueAt !== 'string' || !Number.isFinite(Date.parse(value.dueAt)) || typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))
    || typeof value.status !== 'string' || !/^[a-z_]{1,30}$/.test(value.status)) throw new Error('跟进服务未返回有效记录。');
  return { id: value.id, memoryId: value.memoryId, title: value.title, dueAt: value.dueAt, expiresAt: value.expiresAt, status: value.status };
}

export function createFollowupTools({ scope, actor, text, actions, sourceEventId, checkActive }) {
  const requested = requests(text);
  const available = scope === 'owner' && actor === 'owner' && ['status', 'schedule', 'list', 'pause', 'cancel', 'resume'].every(key => typeof actions?.[key] === 'function');
  const tools = available ? definitions.filter(tool => requested[tool.function.name]) : [];
  let changed = false, prepared = false;
  const listed = new Map();
  let nextListed;
  let status;
  const allowed = name => {
    if (!available || !requested[name]) throw new Error('本条创建人私聊未明确授权此跟进操作。');
  };
  const currentStatus = () => {
    checkActive();
    let value;
    try { value = actions.status(); } catch { checkActive(); throw new Error('跟进服务当前不可用。'); }
    checkActive(); return statusValue(value);
  };
  const invoke = async operation => {
    checkActive();
    let value;
    try { value = await operation(); } catch { checkActive(); throw new Error('本次跟进操作未完成，请核对当前记录，不自动重试。'); }
    checkActive(); return value;
  };
  if (tools.length) status = currentStatus();
  function beginAttempt() {
    if (changed) throw new Error('本轮已尝试变更一次跟进，请下次再继续。');
    changed = true;
  }
  const guidance = tools.length ? `\n本次可使用私人跟进工具。当前服务状态：${JSON.stringify(status)}。仅根据这份当前时间、时区与创建人本条明确文字计算时间，不从旧记忆、引用、图片或网页推断新授权；时间或目标不明确就先询问。问题、将来再变更或限时暂停不授权现在更改，先澄清。跟进是受限机会式关心，不是准点闹钟。成功返回才说已完成对应操作；enabled=false时必须说明当前不会自动发送，需要创建人开启主动私聊；quiet=true时说明主动私聊暂时免打扰到quietUntil，原开关、约定到期和截止时间不变；到时仍按原条件判断，过期不补发。quiet=false且ready=false时说明当前账号、模型或表达设置尚未满足发送条件。即使开启且ready，也受时段、冷却、空闲和额度限制，过期不补发。跟进记忆被更正或忘记后会失效，不能承诺原约定仍会执行。暂停保留约定，可明确恢复，但不会自动到时恢复或延长截止；取消则终结约定、不能恢复。暂停、取消或恢复前先list_followups核对状态与ID，多候选不能猜；每轮创建、暂停、取消、恢复合计仅一次尝试。` : '';
  return {
    tools, guidance,
    beforeCall(name) {
      if (mutations.includes(name)) beginAttempt();
      allowed(name);
      if (mutations.includes(name)) prepared = true;
    },
    finishRound() {
      if (nextListed) { listed.clear(); for (const item of nextListed) listed.set(item.id, item); nextListed = undefined; }
    },
    async execute(name, args) {
      if (mutations.includes(name)) {
        if (prepared) prepared = false; else beginAttempt();
      }
      allowed(name); checkActive();
      const keys = name === 'schedule_followup' ? ['title', 'content', 'due_at'] : name === 'list_followups' ? [] : ['id'];
      if (!record(args) || Object.keys(args).length !== keys.length || Object.keys(args).some(key => !keys.includes(key))) throw new Error('跟进工具参数无效，不能指定账号、范围或其他字段。');
      let value, selected;
      if (name === 'schedule_followup') {
        if (!requested.clearTime) throw new Error('跟进时间还不明确，请先询问具体时间。');
        if (typeof args.title !== 'string' || !args.title.trim() || args.title.length > 80 || args.title.includes('\0')
          || typeof args.content !== 'string' || !args.content.trim() || args.content.length > 600 || args.content.includes('\0')) throw new Error('跟进标题或内容无效。');
        const current = currentStatus();
        const dueAt = dueTime(args.due_at, current);
        if (!reference(sourceEventId)) throw new Error('当前跟进缺少可靠的私聊来源。');
        value = await invoke(() => actions.schedule({ title: args.title.trim(), content: args.content.trim(), dueAt, sourceEventId }));
      } else if (name === 'list_followups') value = await invoke(() => actions.list());
      else {
        const states = name === 'resume_followup' ? ['paused'] : ['pending', 'paused', 'deciding'];
        const item = listed.get(args.id);
        if (!reference(args.id) || !item || !states.includes(item.status)) throw new Error('请先列出跟进，从本轮列表中核对可操作的ID与状态。');
        const candidates = [...listed.values()].filter(entry => states.includes(entry.status));
        const namedIds = requested.direct.split(/[^a-zA-Z0-9_.:@-]+/);
        const named = candidates.filter(entry => namedIds.includes(entry.id) || (entry.title.length >= 2 && requested.direct.includes(entry.title)));
        if (candidates.length > 1 && (named.length !== 1 || named[0].id !== item.id)) throw new Error('跟进候选不唯一，请先询问要操作哪一条。');
        selected = item;
        const action = name === 'pause_followup' ? 'pause' : name === 'cancel_followup' ? 'cancel' : 'resume';
        value = await invoke(() => actions[action](args.id));
      }
      checkActive();
      if (!record(value) || value.ok !== true || typeof value.enabled !== 'boolean' || typeof value.timeZone !== 'string' || value.timeZone.length > 80) throw new Error('本次跟进操作未完成，请核对当前记录，不自动重试。');
      const current = currentStatus();
      const notice = (name === 'pause_followup' ? '已暂停这条跟进，保留原约定；需明确恢复，不会自动到时恢复或延长原截止时间。已发起的消息无法保证撤回。'
        : name === 'cancel_followup' ? '已取消这条跟进，不能恢复；已发起的消息无法保证撤回。' : '') + (!value.enabled ? '当前主动私聊未开启，已保存的跟进不会自动发送。'
        : current.quiet ? `主动私聊免打扰到 ${current.quietUntil}；原约定时间不变，到时仍受原条件限制，过期不补发。`
          : !current.ready ? '当前账号、模型或表达设置尚未满足发送条件，已保存的跟进目前不会自动发送。'
          : '跟进不保证准点；届时仍受时段、冷却、空闲和额度限制，过期不补发。');
      if (name === 'list_followups') {
        if (!Array.isArray(value.followups) || value.followups.length > 20) throw new Error('跟进列表无效。');
        const followups = value.followups.map(summary);
        if (new Set(followups.map(item => item.id)).size !== followups.length) throw new Error('跟进列表无效。');
        nextListed = followups;
        return { ok: true, followups, enabled: value.enabled, quietUntil: current.quietUntil, quiet: current.quiet, timeZone: value.timeZone, notice };
      }
      const followup = summary(value.followup);
      const expected = name === 'pause_followup' ? 'paused' : name === 'cancel_followup' ? 'cancelled' : 'pending';
      if (followup.status !== expected || (selected && (followup.id !== selected.id || followup.memoryId !== selected.memoryId))) throw new Error('跟进服务未确认本次目标与状态，请核对当前记录，不自动重试。');
      return { ok: true, followup, enabled: value.enabled, quietUntil: current.quietUntil, quiet: current.quiet, timeZone: value.timeZone, notice };
    },
  };
}
