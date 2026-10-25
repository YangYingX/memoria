'use strict';

const $ = id => document.getElementById(id);
const labels = { chat: '对话实验室', memories: '记忆书架', reading: '网页阅读', books: '书房', expressions: '表情库', identity: '身份与备份', settings: '人格与设置' };
const categories = { event: '共同经历', person: '人物', interest: '兴趣', reading: '阅读', 'reading-note': '读后思考', 'book-note': '读书笔记', 'self-view': '自己的旧表达', promise: '约定' };
const scopes = { owner: '仅创建人', public: '公开记忆', 'group:demo': '演练群聊' };
const proactiveOutcomes = { quiet: '这次保持安静', decision: '已考虑本次话题', attempt: '已尝试，等待确认', pending: '等待平台确认', success: '已确认发送', unknown: '发送结果未确认', error: '未能完成', cancelled: '已取消', busy: '等空闲时再聊', limit: '今日额度已用完', deciding: '正在考虑开口', missed: '错过的机会已跳过', unavailable: '原聊天渠道暂不可用' };
const followupStatuses = { pending: '待跟进', paused: '已暂停，需在聊天中恢复', deciding: '正在判断是否关心', attempted: '已尝试发送，等待确认', sent: '已确认发送', unknown: '发送结果未确认，不重发', cancelled: '已取消', expired: '已结束，不再跟进', invalidated: '来源或账号已失效' };
const state = { status: {}, data: null, page: 'chat', scope: 'owner', memories: [], books: [], expressions: new Map(), busyChat: false, preview: null };
let toastTimer;

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined && text !== null) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}

function date(value) {
  if (!value) return '时间未记录';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '时间未记录' : parsed.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').classList.toggle('error', error);
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 7000 : 3800);
}

async function api(path, { method = 'GET', data, binary = false } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method, credentials: 'same-origin', cache: 'no-store',
      ...(data !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}),
    });
  } catch { throw new Error('无法连接本地服务，请确认项目正在运行后重试。'); }
  if (!response.ok) {
    let error = `请求未完成（${response.status}）`;
    try { error = (await response.json()).error || error; } catch {}
    if (response.status === 401 && !['/api/login', '/api/setup'].includes(path)) {
      state.status.authenticated = false;
      showAuth();
    }
    throw new Error(error);
  }
  return binary ? response.blob() : response.json();
}

async function action(control, task) {
  const buttons = control.matches('button') ? [control] : [...control.elements].filter(element => element.tagName === 'BUTTON' && element.type === 'submit');
  buttons.forEach(button => { button.disabled = true; });
  try { await task(); } catch (error) { toast(error.message, true); }
  finally { buttons.forEach(button => { button.disabled = false; }); }
}

function empty(container, title, description, symbol = '◌') {
  const box = node('div', null, 'empty-state');
  box.append(node('span', symbol, 'empty-symbol'), node('h3', title), node('p', description));
  container.replaceChildren(box);
}

function showAuth() {
  $('memory-dialog').close();
  resetPreview();
  $('boot-screen').hidden = true;
  $('app').hidden = true;
  $('auth-screen').hidden = false;
  const setup = !state.status.initialized;
  $('auth-title').textContent = setup ? '创建你的私密空间' : '欢迎回来';
  $('auth-description').textContent = setup ? '验证本机初始化码，设置仅由你掌握的管理密码。' : '输入管理密码，进入你的工作台。';
  $('setup-key-label').hidden = !setup;
  $('setup-key').required = setup;
  $('password-hint').hidden = !setup;
  $('auth-password').minLength = setup ? 12 : 1;
  $('auth-password').autocomplete = setup ? 'new-password' : 'current-password';
  $('auth-submit').textContent = setup ? '创建并进入 →' : '进入工作台 →';
  if (state.status.setupKeyPath) $('setup-key-hint').textContent = `从本机文件复制初始化码：${state.status.setupKeyPath}`;
}

async function loadState({ fill = false } = {}) {
  state.data = await api('/api/state');
  const { settings, stats, readingStatus } = state.data;
  state.status.mode = settings.model.hasApiKey ? 'live' : 'demo';
  $('sidebar-persona').textContent = settings.persona.name;
  $('sidebar-mode').textContent = state.status.mode === 'live' ? '模型已配置' : '离线演示模式';
  $('model-mode').textContent = state.status.mode === 'live' ? settings.model.model : '离线演示';
  $('offline-note').hidden = state.status.mode === 'live';
  const budget = state.data.modelBudget, usage = state.data.modelUsage;
  $('model-budget-summary').textContent = !budget ? '正在读取模型额度…'
    : usage?.day === budget.day && (!Number.isSafeInteger(usage.calls) || usage.calls < 0) ? '本日模型调用计数异常，已暂停新请求；请检查本机数据。'
      : `今日模型请求 ${budget.calls} / ${budget.dailyLimit} 次，剩余 ${budget.ownerRemaining} 次（UTC）。普通任务还可用 ${budget.sharedRemaining} 次；创建人私聊预留配置 ${budget.reserve} 次，已包含在总额中。`;
  $('stat-memories').textContent = stats.memories ?? 0;
  $('stat-events').textContent = stats.events ?? 0;
  $('app-version').textContent = `v${state.status.version || '0.1.0'} · 本地开发版`;
  const schedule = settings.reading;
  $('reading-schedule-summary').textContent = schedule.enabled
    ? `每 ${schedule.intervalMinutes} 分钟读取一次，每天最多 ${schedule.dailyLimit} 页。${readingStatus?.lastRun ? `上次完成：${date(readingStatus.lastRun)}。` : '等待首次执行。'}${readingStatus?.lastError ? `最近失败：${readingStatus.lastError}` : ''}`
    : '尚未启用。可以在设置中添加阅读地址和时间间隔。';
  renderAccounts();
  renderBackupStatus(state.data.backupStatus);
  renderAutonomyStatus(state.data.autonomyStatus);
  renderSelfExpressionStatus(state.data.selfExpressionStatus);
  renderMoodStatus();
  renderChatMemoryStatus();
  renderProactiveStatus(state.data.proactiveStatus);
  renderMateStatus();
  renderFollowups();
  renderBookStatus(state.data.bookStatus);
  const dsh = state.data.dshStatus;
  $('dsh-summary').textContent = dsh?.error || (dsh?.enabled ? `已配置只读运行层。今日视频阅读尝试 ${dsh.reading?.attempts ?? 0}/${dsh.reading?.dailyLimit ?? 6} 次（UTC）。表情选择：${dsh.expressions?.configuredEngine === 'dsh-meme' ? '按需关键词检索' : '当前图库目录'}。主动拟聊选择：${dsh.proactive?.configuredEngine === 'dsh-speak-up' ? '原版主动搭话插件' : 'DSH 原生回合'}。${dsh.proactive?.lastCompletedTurn ? `本次服务启动后最近完成拟聊：${date(dsh.proactive.lastCompletedTurn.completedAt)}。` : '本次服务启动后尚未完成拟聊回合。'}长期记忆保存在栖忆书架。` : '尚未启用。当前聊天与书架继续由栖忆服务运行。');
  $('dsh-test').disabled = !dsh?.enabled || dsh.busy;
  const biliAccount = state.data.biliAccountStatus;
  $('bili-account-summary').textContent = (biliAccount?.readReady ?? biliAccount?.configured) ? `专用账号 ${biliAccount.accountId || ''}：视频读取凭据已保存；社交凭据${biliAccount.socialReady ? '已保存' : '尚未齐备，可重新导入登录'}。此状态不表示当前平台认证仍有效。`
    : biliAccount?.browserOpen ? '专用登录窗口已打开。登录完成后点击“完成登录，保存状态”。' : '尚未保存 B站专用账号；读取时使用匿名公开接口。';
  $('bili-login-confirm').disabled = !biliAccount?.browserOpen;
  const heyboxAccount = state.data.heyboxAccountStatus;
  $('heybox-account-summary').textContent = heyboxAccount?.browserOpen
    ? '栖忆专用登录窗口已打开。请完成正常登录和验证，再点击“完成登录与验证，保存状态”。'
    : heyboxAccount?.configured ? `栖忆专用账号 ${heyboxAccount.accountId || ''} 的登录状态已保存在本机；不表示当前平台认证仍有效。`
      : '尚未保存小黑盒专用浏览器登录状态；与创建人身份绑定分开管理。';
  $('heybox-login-confirm').disabled = !heyboxAccount?.browserOpen;
  const qqChat = state.data.qqChatStatus;
  $('qq-chat-summary').textContent = qqChat ? `今日 QQ 智能对话 ${qqChat.attempts} / ${qqChat.dailyLimit} 次，剩余 ${qqChat.remaining} 次（UTC）。${qqChat.dailyLimit === 0 ? '已暂停新的智能对话。' : ''}` : '正在读取 QQ 智能对话额度…';
  const feishu = state.data.feishuStatus, connection = state.data.feishuConnection;
  $('feishu-summary').textContent = !feishu?.enabled ? '飞书接入已关闭。' : connection?.error || `${connection?.connecting ? '正在连接' : feishu.connected ? '连接已就绪' : '尚未连接'} · 今日聊天尝试 ${feishu.chat.attempts} / ${feishu.chat.dailyLimit} 次（UTC）。`;
  $('feishu-reconnect').disabled = !feishu?.enabled || connection?.connecting;
  $('feishu-binding-code').disabled = !feishu?.connected;
  if (fill) { fillSettings(); fillBackupSettings(); }
}

async function enterApp() {
  await loadState({ fill: true });
  $('auth-screen').hidden = true;
  $('boot-screen').hidden = true;
  $('app').hidden = false;
  $('auth-password').value = '';
  $('setup-key').value = '';
  await navigate(state.page);
}

async function navigate(page) {
  if (!labels[page]) return;
  state.page = page;
  document.querySelectorAll('.page').forEach(section => { section.hidden = section.id !== `page-${page}`; });
  document.querySelectorAll('[data-page]').forEach(button => button.classList.toggle('active', button.dataset.page === page));
  $('breadcrumb').textContent = labels[page];
  try {
    if (page === 'chat') await loadMessages();
    if (page === 'memories') await loadMemories();
    if (page === 'reading') await Promise.all([loadEvents(), loadState()]);
    if (page === 'books') await Promise.all([loadBooks(), loadState()]);
    if (page === 'expressions') await loadExpressions();
    if (page === 'identity') { await loadState(); fillBackupSettings(); }
    if (page === 'settings') await loadState({ fill: true });
  } catch (error) { toast(error.message, true); }
}

function appendMessage(message, pending = false) {
  const user = message.role === 'user';
  const name = user ? '我' : state.data?.settings.persona.name || '未央';
  const row = node('div', null, `message ${user ? 'user' : 'assistant'}${pending ? ' pending' : ''}`);
  row.append(node('span', name.slice(0, 1), 'avatar'));
  const body = node('div', null, 'message-body');
  const meta = node('div', null, 'message-meta');
  meta.append(node('span', name));
  if (message.createdAt) meta.append(node('time', date(message.createdAt)));
  body.append(meta, node('div', message.content, 'message-text'));
  if (!user && !pending && Array.isArray(message.metadata?.expressionIds)) {
    const expression = state.expressions.get(message.metadata.expressionIds[0]);
    if (expression && (expression.builtin || expression.custom || expression.scope === (message.scope || state.scope))) {
      const picture = expressionImage(expression, 'message-expression');
      body.append(picture);
    }
  }
  row.append(body);
  $('chat-messages').append(row);
  return row;
}

async function loadMessages() {
  const requestedScope = state.scope;
  const [{ messages }] = await Promise.all([api(`/api/messages?scope=${encodeURIComponent(requestedScope)}`), loadExpressions({ render: false }).catch(() => state.expressions.clear())]);
  if (requestedScope !== state.scope) return;
  $('chat-messages').replaceChildren();
  if (!messages.length) empty($('chat-messages'), '留下一句今天的开场白。', state.scope === 'owner' ? '可以聊聊你的兴趣，或试着告诉她一件值得记住的事。' : '这是本地群聊演练。创建人的私密记忆不会用于这里的回应。', '✳');
  else messages.forEach(message => appendMessage(message));
  $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
}

function expressionImage(expression, className) {
  const image = node('img', undefined, className);
  image.src = expression.previewPath;
  image.alt = expression.name || '表情';
  image.loading = 'lazy';
  image.addEventListener('error', () => image.replaceWith(node('span', '图片暂不可用', 'caption')), { once: true });
  return image;
}

async function loadExpressions({ render = true } = {}) {
  const catalog = await api('/api/expressions');
  const mapping = new Map();
  const clean = (entries, kind) => (Array.isArray(entries) ? entries : []).filter(entry => {
    if (!entry || typeof entry.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(entry.id) || mapping.has(entry.id)) return false;
    const builtin = kind === 'builtin', custom = kind === 'custom';
    if (custom && (entry.origin !== 'custom' || entry.scope !== 'public')) return false;
    const expected = builtin ? `/expressions/${entry.id}.png` : `/api/expressions/${entry.id}/image`;
    if (entry.previewPath !== expected) return false;
    mapping.set(entry.id, { ...entry, builtin, custom });
    return true;
  }).map(entry => mapping.get(entry.id));
  const builtins = clean(catalog.builtins, 'builtin'), custom = clean(catalog.custom, 'custom'), collected = clean(catalog.collected, 'collected');
  state.expressions = mapping;
  if (!render) return;
  $('builtin-expression-count').textContent = `${builtins.length} 款`;
  $('custom-expression-count').textContent = `${custom.length} 张`;
  $('collected-expression-count').textContent = `${collected.length} 张`;
  const maxItems = Number.isSafeInteger(catalog.limits?.maxItems) ? catalog.limits.maxItems : 64;
  const maxBytes = Number.isFinite(catalog.limits?.maxBytes) ? catalog.limits.maxBytes : 8388608;
  $('expression-limits').textContent = `上传与收藏共用表情库：每张不超过 2 MiB，总共不超过 ${Math.round(maxBytes / 1048576)} MiB，最多 ${maxItems} 张。`;
  function renderCards(container, entries, kind) {
    container.replaceChildren();
    const builtin = kind === 'builtin', custom = kind === 'custom';
    if (!entries.length) return empty(container, builtin ? '内置表情正在等待就绪。' : custom ? '还没有上传的表情。' : '还没有收藏的表情。', builtin ? '准备好图片后，刷新即可查看。' : custom ? '选择一张图片，告诉她适合在什么时候使用。' : '聊天中收藏的图片会出现在这里，并保留原来的使用场合。', '☺');
    for (const entry of entries) {
      const card = node('article', null, 'panel expression-card');
      const preview = node('div', null, 'expression-preview');
      preview.append(expressionImage(entry, 'expression-image'));
      card.append(preview, node('h3', entry.name || '收藏的表情'), node('p', entry.description || '', 'expression-description'));
      if (!builtin) {
        const place = entry.scope === 'owner' ? '原创建人私聊' : entry.scope?.startsWith('group:') ? `原群聊 · ${entry.scope.slice(6)}` : entry.scope?.startsWith('person:') ? `原私聊 · ${entry.scope.slice(7)}` : '原聊天场合';
        card.append(node('p', custom ? '所有聊天可选' : `仅用于${place}`, 'expression-scope'), node('p', custom ? '来源：你上传的图片' : `来源：${entry.origin || '未记录'}`, 'expression-origin'), node('time', date(entry.createdAt), 'caption'));
        const remove = node('button', custom ? '删除表情' : '删除收藏', 'text-button expression-remove');
        remove.type = 'button';
        remove.addEventListener('click', () => action(remove, async () => {
          if (!confirm(`删除${custom ? '表情' : '收藏'}「${entry.name || '这张表情'}」？删除后，她不会再使用这张图片。`)) return;
          await api(`/api/expressions/${encodeURIComponent(entry.id)}`, { method: 'DELETE', data: {} });
          await loadExpressions();
          toast(custom ? '这张上传的表情已删除。' : '这张表情已从收藏中删除。');
        }));
        card.append(remove);
      }
      container.append(card);
    }
  }
  renderCards($('builtin-expressions'), builtins, 'builtin');
  renderCards($('custom-expressions'), custom, 'custom');
  renderCards($('collected-expressions'), collected, 'collected');
}

async function loadBooks() {
  const result = await api('/api/books');
  state.books = (Array.isArray(result.books) ? result.books : []).filter(book => book && typeof book.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(book.id));
  if (state.data) state.data.bookStatus = result.status || {};
  const totalBytes = state.books.reduce((sum, book) => sum + (Number.isFinite(book.byteLength) ? Math.max(0, book.byteLength) : 0), 0);
  $('book-library-size').textContent = `${state.books.length} / 10 本 · ${(totalBytes / 1048576).toFixed(2)} / 5 MiB`;
  const list = $('book-list'); list.replaceChildren();
  if (!state.books.length) empty(list, '留一盏灯，等第一本书。', '导入文本或一页公开正文后，就可以从第一段开始。', '▥');
  for (const book of state.books) {
    const total = Number.isFinite(book.totalChars) ? Math.max(0, book.totalChars) : 0;
    const current = Math.min(total, Number.isFinite(book.currentOffset) ? Math.max(0, book.currentOffset) : 0);
    const percent = total ? Math.floor(current / total * 100) : 0;
    const card = node('article', null, 'panel book-card');
    const heading = node('div', null, 'book-card-heading');
    heading.append(node('span', current >= total && total ? '已读完' : current ? '阅读中' : '准备开始', 'tag'), node('span', `${percent}%`, 'caption'));
    const progress = node('progress', undefined, 'book-progress'); progress.max = 100; progress.value = percent;
    progress.setAttribute('aria-label', `${book.title || '书籍'}的阅读进度`);
    card.append(heading, node('h3', book.title || '未命名书籍'), progress, node('p', `已读 ${current.toLocaleString('zh-CN')} / ${total.toLocaleString('zh-CN')} 字符`, 'caption'));
    let source;
    try { const url = new URL(book.sourceRef); if (url.protocol === 'https:' && !url.username && !url.password) source = url; } catch {}
    if (source) {
      const link = node('a', `来源：${source.hostname} · 当前页`, 'book-source'); link.href = source.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; card.append(link);
    } else card.append(node('p', '来源：本地文本', 'book-source'));
    card.append(node('p', book.lastReadAt ? `最近读到这里：${date(book.lastReadAt)}` : `导入时间：${date(book.createdAt)}`, 'caption'));
    const remove = node('button', '移出书房', 'text-button book-remove'); remove.type = 'button';
    remove.addEventListener('click', () => action(remove, async () => {
      if (!confirm(`将「${book.title || '这本书'}」移出书房？正文和阅读位置会移除，已有笔记仍保留在记忆书架。`)) return;
      await api(`/api/books/${encodeURIComponent(book.id)}`, { method: 'DELETE', data: {} });
      await loadBooks(); toast('已移出书房，已有笔记仍保留。');
    }));
    card.append(remove); list.append(card);
  }
  renderBookStatus(result.status || {});
}

function renderBookStatus(status = {}) {
  const config = state.data?.settings.books || {};
  const inDay = Date.now() >= Date.parse(status.dayStartAt) && Date.now() < Date.parse(status.dayEndAt);
  const count = inDay ? status.attempts || 0 : 0;
  const limit = inDay && Number.isFinite(status.target) ? Math.min(status.target, config.dailyLimit || 2) : config.dailyLimit || 2;
  const hour = value => `${String(value ?? 0).padStart(2, '0')}:00`;
  $('book-schedule-summary').textContent = config.enabled
    ? `每天最多 ${config.dailyLimit} 次，每次约 ${config.chunkChars} 字符，随机安排在 ${hour(config.startHour)}–${hour(config.endHour)}（${config.timeZone}）。`
    : '自主读书尚未启用。仍可在 QQ 私聊让她读一小段，或在这里手动阅读；每日次数共用。';
  const unread = state.books.some(book => book.currentOffset < book.totalChars);
  let next = config.enabled ? '等待安排' : '启用后安排';
  if (config.enabled && !unread) next = state.books.length ? '书房里的内容已读完' : '添加书籍后安排';
  else if (config.enabled && inDay) next = status.nextRunAt && count < limit
    ? new Date(status.nextRunAt).toLocaleString('zh-CN', { timeZone: config.timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '今天暂无后续安排';
  $('book-next').textContent = next;
  $('book-count').textContent = `${count} / ${limit} 次`;
  const outcomes = { success: '一段阅读完成', reading: '正在阅读…', empty: '暂无未读内容', missed: '错过的安排已跳过', error: '未能完成', cancelled: '已取消', busy: '稍后再读' };
  $('book-outcome').textContent = status.busy ? '正在阅读并写笔记…' : outcomes[status.lastOutcome] || '还没有记录';
  $('book-last').hidden = !status.lastAttempt;
  $('book-last').textContent = status.lastAttempt ? `最近尝试：${date(status.lastAttempt)}${status.lastTitle ? ` · 《${status.lastTitle}》` : ''}` : '';
  $('book-error').hidden = !status.lastError; $('book-error').textContent = status.lastError || '';
  $('book-run').disabled = Boolean(status.busy || !unread || count >= limit || !state.data?.settings.model.hasApiKey);
}

function renderSources(memories) {
  $('source-count').textContent = memories.length;
  $('sources-list').replaceChildren();
  if (!memories.length) $('sources-list').append(node('p', '本次没有检索到可用的相关记忆。', 'muted'));
  for (const memory of memories) {
    const item = node('div', null, 'source-item');
    item.append(node('strong', memory.title || '记忆'), node('p', memory.content?.slice(0, 350) || memory.excerpt || ''));
    if (memory.sourceRef) item.append(node('p', `来源：${memory.sourceRef}`));
    $('sources-list').append(item);
  }
}

async function loadMemories() {
  const query = new URLSearchParams({ q: $('memory-query').value.trim(), scope: $('memory-scope').value });
  const { memories } = await api(`/api/memories?${query}`);
  state.memories = memories;
  $('memory-count').textContent = `${memories.length} 条记忆`;
  $('memory-list').replaceChildren();
  if (!memories.length) return empty($('memory-list'), '书架还在等待新的经历。', $('memory-query').value ? '没有找到匹配的记忆，试试其他关键词或范围。' : '添加一条记忆，或去阅读一篇网页，留下第一段经历。', '▤');
  for (const memory of memories) {
    const card = node('article', null, 'memory-card');
    const top = node('div', null, 'memory-card-top');
    const tag = node('span', categories[memory.category] || memory.category, 'tag');
    tag.dataset.category = memory.category;
    top.append(tag, node('span', scopes[memory.scope] || memory.scope, 'scope-label'));
    const source = node('div', memory.sourceRef ? `来源：${memory.sourceRef}` : `来源：${memory.sourceType === 'manual' ? '手动记录' : memory.sourceType}`, 'memory-card-source');
    source.title = memory.sourceRef || memory.sourceType;
    const footer = node('div', null, 'memory-card-footer');
    const actions = node('div', null, 'memory-card-actions');
    const edit = node('button', '查看 / 编辑', 'text-button');
    edit.addEventListener('click', () => editMemory(memory));
    const remove = node('button', '删除', 'text-button');
    remove.addEventListener('click', () => action(remove, async () => {
      if (!confirm(`删除记忆「${memory.title}」？这条记忆将不再参与检索。`)) return;
      await api(`/api/memories/${encodeURIComponent(memory.id)}`, { method: 'DELETE', data: {} });
      await Promise.all([loadMemories(), loadState()]);
      toast('记忆已删除。');
    }));
    actions.append(edit, remove);
    footer.append(node('time', date(memory.updatedAt)), actions);
    card.append(top, node('h3', memory.title), node('p', memory.content, 'memory-content'), source, footer);
    $('memory-list').append(card);
  }
}

function ensureOption(select, value, label) {
  if (![...select.options].some(option => option.value === value)) select.add(new Option(label || value, value));
}

async function editMemory(memory = null) {
  $('memory-form').reset();
  $('memory-id').value = memory?.id || '';
  $('memory-dialog-title').textContent = memory ? '查看与修订记忆' : '添加一段记忆';
  $('memory-title').value = memory?.title || '';
  if (memory) {
    ensureOption($('memory-category'), memory.category, categories[memory.category]);
    ensureOption($('memory-edit-scope'), memory.scope, scopes[memory.scope]);
  }
  $('memory-category').value = memory?.category || 'event';
  $('memory-edit-scope').value = memory?.scope || 'owner';
  $('memory-content').value = memory?.content || '';
  $('memory-source').value = memory?.sourceRef || '';
  $('memory-form').dataset.sourceType = memory?.sourceType || 'manual';
  $('revision-details').hidden = !memory;
  $('revision-details').open = false;
  $('revision-list').replaceChildren(node('p', '正在读取修订记录…', 'muted'));
  $('memory-dialog').showModal();
  if (memory) {
    try {
      const { revisions } = await api(`/api/memories/${encodeURIComponent(memory.id)}/revisions`);
      if ($('memory-id').value !== memory.id) return;
      $('revision-list').replaceChildren();
      if (!revisions.length) $('revision-list').append(node('p', '还没有历史修订。', 'muted'));
      for (const revision of revisions) {
        const snapshot = revision.snapshot || revision;
        const item = node('div', null, 'revision');
        item.append(node('time', date(revision.createdAt)), node('strong', ` · ${snapshot.title || '历史版本'}`), node('p', snapshot.content || ''));
        $('revision-list').append(item);
      }
    } catch (error) { $('revision-list').textContent = error.message; }
  }
}

async function loadEvents() {
  const { events } = await api('/api/events');
  $('event-list').replaceChildren();
  if (!events.length) return empty($('event-list'), '还没有经历记录。', '对话与网页阅读产生的记录会显示在这里。', '◎');
  for (const event of events.slice(0, 12)) {
    const row = node('div', null, 'event-row');
    const content = node('div');
    const proactiveResult = event.type === 'proactive' ? ` · ${proactiveOutcomes[event.metadata?.outcome] || '结果未确认'}` : '';
    content.append(node('p', event.type === 'autonomy' ? event.content?.slice(0, 300) : event.metadata?.title || event.content?.slice(0, 140) || event.type), node('span', `${scopes[event.scope] || event.scope} · ${event.type === 'reading' ? '网页阅读' : event.type === 'autonomy' ? '自主浏览' : event.type === 'proactive' ? '主动私聊' : event.type === 'memory_change' ? event.metadata?.action === 'forget' ? '记忆移除' : '记忆更正' : event.type === 'error' ? '未完成的任务' : event.type}${proactiveResult}${event.sourceRef && !['proactive', 'memory_change'].includes(event.type) ? ` · ${event.sourceRef}` : ''}`));
    row.append(node('time', date(event.createdAt)), content);
    $('event-list').append(row);
  }
}

function renderAccounts() {
  $('accounts-list').replaceChildren();
  if (!state.data.accounts.length) { $('accounts-list').append(node('p', '暂未绑定平台账号。你仍可在本机对话实验室中使用创建人身份。', 'caption')); return; }
  for (const account of state.data.accounts) {
    const row = node('div', null, 'account-row');
    const info = node('div');
    info.append(node('strong', account.label || account.platform.toUpperCase()), node('p', `${account.platform} · ${account.userId} · ${account.personId === 'owner' ? '创建人' : account.personId}`));
    const remove = node('button', '解除绑定', 'text-button');
    remove.addEventListener('click', () => action(remove, async () => {
      if (!confirm(`解除 ${account.platform} 账号 ${account.userId} 的创建人身份绑定？`)) return;
      await api(`/api/bindings/${encodeURIComponent(account.id)}`, { method: 'DELETE', data: {} });
      await loadState(); toast('账号绑定已解除。');
    }));
    row.append(info, remove); $('accounts-list').append(row);
  }
}

function fillSettings() {
  const { persona, model, qq, feishu = {}, reading, autonomy = {}, drawing = {}, selfExpression = {}, books = {}, proactive = {}, dshReading = {}, mood = {}, chatMemory = {} } = state.data.settings;
  $('chat-memory-enabled').checked = chatMemory.enabled !== false;
  $('chat-memory-interval').value = chatMemory.intervalMinutes ?? 180;
  $('chat-memory-limit').value = chatMemory.dailyLimit ?? 4;
  $('dsh-reading-limit').value = dshReading.dailyReadLimit ?? 6;
  $('mood-enabled').checked = Boolean(mood.enabled);
  $('mood-interval').value = mood.intervalMinutes ?? 15;
  $('mood-limit').value = mood.dailyLimit ?? 48;
  $('persona-name').value = persona.name;
  $('persona-description').value = persona.description;
  $('model-base-url').value = model.baseUrl;
  $('model-name').value = model.model;
  $('model-daily-request-limit').value = model.dailyRequestLimit ?? 3000;
  $('model-owner-reserve').value = model.ownerChatReserve ?? 20;
  $('model-api-key').value = '';
  $('model-api-key').disabled = false;
  $('model-clear-api-key').checked = false;
  $('model-key-status').textContent = model.hasApiKey ? '已配置密钥。留空保存会保留当前密钥。' : '尚未配置密钥，目前使用离线演示。';
  $('qq-enabled').checked = qq.enabled;
  $('qq-chat-limit').value = qq.dailyChatLimit ?? 200;
  $('qq-merge-window').value = qq.mergeWindowMs ?? 700;
  $('qq-group-reply-chance').value = qq.groupReplyChance ?? 0;
  $('qq-group-reply-cooldown').value = qq.groupReplyCooldownSeconds ?? 300;
  $('qq-reply-split').checked = qq.replySplitEnabled ?? false;
  $('qq-reply-delay').value = qq.replyDelayMs ?? 0;
  $('qq-api-url').value = qq.apiBaseUrl;
  $('qq-bot-id').value = qq.botId;
  $('qq-access-token').value = '';
  $('qq-access-token').placeholder = qq.hasAccessToken ? '已配置，留空保留已有令牌' : '尚未配置';
  $('qq-webhook-secret').value = qq.webhookSecret || '';
  $('qq-users').value = qq.allowedUsers.join('\n');
  $('qq-groups').value = qq.allowedGroups.join('\n');
  $('feishu-enabled').checked = Boolean(feishu.enabled);
  $('feishu-bot-id').value = feishu.botId || '';
  $('feishu-fingerprint').value = feishu.expectedFingerprint || '';
  $('feishu-users').value = (feishu.allowedUsers || []).join('\n');
  $('feishu-groups').value = (feishu.allowedGroups || []).join('\n');
  $('feishu-chat-limit').value = feishu.dailyChatLimit ?? 200;
  $('reading-enabled').checked = reading.enabled;
  $('reading-urls').value = reading.urls.join('\n');
  $('reading-interval').value = reading.intervalMinutes;
  $('reading-limit').value = reading.dailyLimit;
  $('autonomy-enabled').checked = Boolean(autonomy.enabled);
  $('autonomy-source-heybox').checked = (autonomy.sources || ['heybox']).includes('heybox');
  $('autonomy-source-bilibili').checked = (autonomy.sources || ['heybox']).includes('bilibili');
  $('autonomy-interests').value = autonomy.interests ?? '游戏与玩家社区';
  $('autonomy-daily-min').value = autonomy.dailyMin ?? 3;
  $('autonomy-daily-max').value = autonomy.dailyMax ?? 6;
  $('autonomy-start-hour').value = autonomy.startHour ?? 9;
  $('autonomy-end-hour').value = autonomy.endHour ?? 23;
  $('autonomy-time-zone').value = autonomy.timeZone || 'Asia/Shanghai';
  $('drawing-provider').value = drawing.provider || 'qwen';
  $('drawing-base-url').value = drawing.baseUrl || 'https://dashscope.aliyuncs.com';
  $('drawing-model').value = drawing.model || 'qwen-image-3.0';
  $('drawing-api-key').value = '';
  $('drawing-api-key').disabled = false;
  $('drawing-clear-api-key').checked = false;
  $('drawing-key-status').textContent = drawing.hasApiKey ? '已保存密钥。留空保存会保留当前密钥；绘图尚未接入。' : '尚未保存密钥。可以先留空，后续接入时再填写。';
  $('drawing-daily-limit').value = drawing.dailyLimit ?? 1;
  $('drawing-weekly-limit').value = drawing.weeklyLimit ?? 3;
  $('self-expression-enabled').checked = Boolean(selfExpression.enabled);
  $('self-expression-desire').value = selfExpression.desire ?? 45;
  $('self-expression-daily-limit').value = selfExpression.dailyLimit ?? 80;
  $('self-expression-cooldown').value = selfExpression.cooldownMinutes ?? 360;
  $('self-expression-start-hour').value = selfExpression.startHour ?? 9;
  $('self-expression-end-hour').value = selfExpression.endHour ?? 23;
  $('self-expression-time-zone').value = selfExpression.timeZone || 'Asia/Shanghai';
  $('self-expression-avatar-days').value = selfExpression.avatarIntervalDays ?? 7;
  const expressionQQ = selfExpression.platforms?.qq || {};
  for (const name of ['enabled', 'post', 'signature', 'avatar']) $('self-expression-qq-' + name).checked = expressionQQ[name] ?? true;
  $('self-expression-qq-daily-limit').value = expressionQQ.dailyLimit ?? 80;
  $('self-expression-qq-visibility').value = expressionQQ.qzoneVisibility ?? 4;
  const expressionHeybox = selfExpression.platforms?.heybox || {};
  $('self-expression-heybox-enabled').checked = Boolean(expressionHeybox.enabled);
  $('self-expression-heybox-post').checked = expressionHeybox.post ?? true;
  $('self-expression-heybox-comment').checked = Boolean(expressionHeybox.comment);
  $('self-expression-heybox-reply').checked = Boolean(expressionHeybox.reply);
  $('self-expression-heybox-daily-limit').value = expressionHeybox.dailyLimit ?? 80;
  $('self-expression-heybox-topic').value = expressionHeybox.topic || '盒友杂谈';
  const expressionBili = selfExpression.platforms?.bilibili || {};
  $('self-expression-bilibili-enabled').checked = Boolean(expressionBili.enabled);
  $('self-expression-bilibili-post').checked = Boolean(expressionBili.post);
  $('self-expression-bilibili-reply').checked = Boolean(expressionBili.reply);
  $('self-expression-bilibili-daily-limit').value = expressionBili.dailyLimit ?? 80;
  $('self-expression-bilibili-inbox-minutes').value = expressionBili.inboxIntervalMinutes ?? 3;
  $('books-enabled').checked = Boolean(books.enabled);
  $('books-daily-limit').value = books.dailyLimit ?? 2;
  $('books-chunk-chars').value = books.chunkChars ?? 3000;
  $('books-start-hour').value = books.startHour ?? 9;
  $('books-end-hour').value = books.endHour ?? 23;
  $('books-time-zone').value = books.timeZone || 'Asia/Shanghai';
  $('proactive-enabled').checked = Boolean(proactive.enabled);
  $('proactive-desire').value = proactive.desire ?? 35;
  $('proactive-daily-limit').value = proactive.dailyLimit ?? 1;
  $('proactive-cooldown').value = proactive.cooldownMinutes ?? 360;
  $('proactive-idle').value = proactive.idleMinutes ?? 60;
  $('proactive-start-hour').value = proactive.startHour ?? 10;
  $('proactive-end-hour').value = proactive.endHour ?? 22;
  $('proactive-time-zone').value = proactive.timeZone || 'Asia/Shanghai';
}

function renderProactiveStatus(status = {}) {
  const config = state.data?.settings.proactive || {};
  const inDay = Date.now() >= Date.parse(status.dayStartAt) && Date.now() < Date.parse(status.dayEndAt);
  const quiet = Boolean(config.quietUntil && Date.now() < Date.parse(config.quietUntil));
  const quietEnd = quiet ? new Date(config.quietUntil).toLocaleString('zh-CN', { timeZone: config.timeZone || 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
  $('proactive-summary').textContent = config.enabled
    ? `已开启 · 今日已考虑 ${inDay ? status.decisionAttempts || 0 : 0} / 6 次。先核对到期约定；${state.data?.dshStatus?.error ? 'DSH 状态异常，近期私聊与旧主题拟聊当前不可用，请核对接入状态。' : state.data?.mateStatus?.enabled && state.data?.mateStatus?.ready ? '随机话题优先延续近期私聊，也可从核验过的旧主题生发。' : '随机话题优先延续近期私聊、分享实际见闻；没有新线索时也可核对旧主题，未回应后暂停这条补充路径。'}她会在允许的时段内等待合适的开口机会。`
    : '主动私聊已关闭。保存开启后才安排；已经发起的发送无法保证撤回。';
  if (quiet) $('proactive-summary').textContent += ` 临时免打扰至 ${quietEnd}；原开关、额度和约定截止时间不变，结束后仍按原条件判断，过期不补发。`;
  $('proactive-next').textContent = !config.enabled ? '启用后安排' : quiet ? `免打扰至 ${quietEnd}` : inDay && status.nextRunAt
    ? new Date(status.nextRunAt).toLocaleString('zh-CN', { timeZone: config.timeZone || 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    : '等待下次安排';
  $('proactive-count').textContent = `${inDay ? status.sendAttempts || 0 : 0} / ${config.dailyLimit ?? 1} 次`;
  $('proactive-outcome').textContent = status.busy ? '正在考虑开口…' : proactiveOutcomes[status.lastOutcome] || '还没有记录';
  $('proactive-last').hidden = !status.lastAttempt && !status.lastSuccess;
  $('proactive-last').textContent = [status.lastAttempt ? `最近尝试：${date(status.lastAttempt)}` : '', status.lastSuccess ? `最近确认发送：${date(status.lastSuccess)}` : ''].filter(Boolean).join(' · ');
  $('proactive-error').hidden = !status.lastError;
  $('proactive-error').textContent = status.lastError || '';
}

function renderMateStatus() {
  const status = state.data?.mateStatus;
  const version = /^\d+\.\d+\.\d+$/.test(status?.version || '') ? ` ${status.version}` : '';
  $('mate-summary').textContent = status?.error ? '陪伴内核暂不可用，请核对本机配置；若数值状态损坏或积压，可重置节奏。'
    : status?.busy ? '正在计算本次陪伴节奏，不调用模型或发送消息。'
      : !status?.enabled ? '可选陪伴内核尚未启用。安装与本机配置方法见部署说明，原有主动私聊规则继续适用。'
        : !status.ready ? '陪伴内核尚未就绪，请核对本机运行环境。'
          : `Mate${version} 本机算法已就绪。随机话题会参考交流节奏；启用内核不会开启主动私聊，发送仍需满足原有条件。`;
  $('mate-reset').disabled = Boolean(state.mateResetPending || status?.busy || state.data?.proactiveStatus?.busy);
}

function renderFollowups() {
  const list = $('followups-list'), timeZone = state.data?.settings.proactive?.timeZone || 'Asia/Shanghai';
  const items = Array.isArray(state.data?.followups) ? state.data.followups.slice(0, 20) : [];
  list.replaceChildren();
  $('followups-summary').textContent = `待跟进优先，最多显示 20 条（含最近结果）。时间按 ${timeZone} 显示；到期后仍需等待允许的时段与空闲机会。`;
  if (!items.length) { list.append(node('p', '还没有聊天约定。可在创建人私聊中说：明晚20:00问问我考试情况。', 'caption')); return; }
  const time = value => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? '时间未记录' : parsed.toLocaleString('zh-CN', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  };
  for (const item of items) {
    const row = node('div', null, 'account-row'), info = node('div');
    info.append(node('strong', item.title), node('p', followupStatuses[item.status] || '状态待核对', 'caption'),
      node('p', `跟进起点：${time(item.dueAt)} · 截止：${time(item.expiresAt)}`, 'caption'));
    row.append(info); list.append(row);
  }
}

function renderMoodStatus() {
  const mood = state.data?.mood || {}, status = state.data?.moodStatus || {}, config = state.data?.settings.mood || {};
  const outcomes = { success: '已完成心情评估', low_confidence: '这次判断没有足够把握，保留原状态', unchanged: '这次保持原状态', error: '本次评估未完成', cancelled: '本次评估已取消', interrupted: '上次评估未完成', evaluating: '正在评估', busy: '等待空闲时间' };
  $('mood-label').textContent = mood.label || '平静';
  $('mood-value').textContent = `${Number.isFinite(mood.value) ? mood.value.toFixed(1) : '70'} / 100`;
  $('mood-updated').textContent = mood.updatedAt ? date(mood.updatedAt) : '尚未评估';
  const today = status.day === new Date().toISOString().slice(0, 10);
  $('mood-count').textContent = `${today ? status.attempts || 0 : 0} / ${config.dailyLimit ?? 4} 次`;
  const runtimeMood = state.data?.dshStatus?.mood;
  const engine = runtimeMood?.configuredConversationEngine === 'dsh-feiyu-mood' ? '原版鱼的心情插件' : 'DSH 原生评估';
  $('mood-summary').textContent = config.enabled
    ? `对话使用${engine}，公开阅读使用 DSH 原生评估。每 ${config.intervalMinutes ?? 180} 分钟最多评估一次；无新资料便保持安静，心境会随时间回稳。${runtimeMood?.lastCompletedEvaluation ? `本次服务启动后最近完成评估：${date(runtimeMood.lastCompletedEvaluation.completedAt)}；是否应用以评估结果为准。` : ''}`
    : '间歇评估尚未开启，已有状态仍会自然回稳。可在「人格与设置」调整。';
  $('mood-outcome').textContent = status.busy ? '正在评估…' : outcomes[status.lastOutcome] || '尚无评估记录；初始状态为平静。';
  $('mood-error').hidden = !status.lastError;
  $('mood-error').textContent = status.lastError || '';
  $('mood-run').disabled = Boolean(status.busy || !config.enabled || !state.data?.dshStatus?.enabled || !state.data?.settings.model.hasApiKey);
}

function renderChatMemoryStatus() {
  const config = state.data?.settings.chatMemory || {}, status = state.data?.chatMemoryStatus || {};
  const outcomes = { evaluating: '正在整理新交流…', success: '已将原话摘记放上书架', quiet: '这次没有新增摘记', error: '这次未能完成', cancelled: '已让出时间，等待下次整理', interrupted: '上次整理中断，未自动重试' };
  $('chat-memory-summary').textContent = !config.enabled ? '已暂停。再次开启时，从新的交流开始整理。'
    : !state.data?.settings.model.hasApiKey ? '已开启，等待配置模型 API。'
      : config.dailyLimit === 0 ? '每日上限为 0，暂停新的整理尝试。'
        : `已开启，每 ${config.intervalMinutes ?? 180} 分钟最多整理一次。${status.nextRunAt ? `下次最早整理：${date(status.nextRunAt)}。` : '等待新的交流和空闲时间。'}`;
  const today = status.day === new Date().toISOString().slice(0, 10);
  $('chat-memory-count').textContent = `今日整理尝试 ${today ? status.attempts || 0 : 0} / ${config.dailyLimit ?? 4} 次（UTC） · 上次新增 ${status.savedCount || 0} 条`;
  $('chat-memory-outcome').textContent = `${status.busy ? '正在整理新交流…' : outcomes[status.lastOutcome] || '还没有整理记录'}${status.lastAttemptAt ? ` · 最近尝试：${date(status.lastAttemptAt)}` : ''}`;
  $('chat-memory-error').hidden = !status.lastError;
  $('chat-memory-error').textContent = status.lastError || '';
}

function renderSelfExpressionStatus(status = {}) {
  const config = state.data?.settings.selfExpression || {};
  const inDay = Date.now() >= Date.parse(status.dayStartAt) && Date.now() < Date.parse(status.dayEndAt);
  const count = inDay ? status.postAttempts || 0 : 0;
  const qq = config.platforms?.qq || {};
  const qqCounts = inDay ? status.platformAttempts?.qq || {} : {};
  const heybox = config.platforms?.heybox || {};
  const heyboxCounts = inDay ? status.platformAttempts?.heybox || {} : {};
  const bilibili = config.platforms?.bilibili || {}, biliCounts = inDay ? status.platformAttempts?.bilibili || {} : {};
  const biliAccount = state.data?.biliAccountStatus, biliSocial = state.data?.biliSocialStatus;
  const socialSummary = biliSocial?.paused ? '社交访问已暂停，请先核对账号和平台状态。'
    : biliSocial?.error || biliSocial?.enabled && biliSocial?.ready === false ? '社交环境或凭据尚未就绪，请核对本机配置。'
      : biliSocial?.busy ? '正在核对或处理本次通知。'
        : biliSocial?.enabled ? '独立社交宿主已启用，账号与目标在执行时核验。' : '独立社交宿主尚未启用；尚未安装时请先按部署说明配置。';
  const inboxSummary = bilibili.reply ? `通知检查机会间隔 ${bilibili.inboxIntervalMinutes ?? 3} 分钟，沿用表达欲与活跃时段。` : '通知回复尚未启用。';
  $('self-expression-bilibili-summary').textContent = `${inboxSummary}本机视频读取凭据${(biliAccount?.readReady ?? biliAccount?.configured) ? '已保存' : '未保存'}，社交凭据${biliAccount?.socialReady ? '已保存' : '尚未齐备'}。${socialSummary}这些状态不证明平台登录有效、提交通过审核或公开可见。`;
  const outcomes = { success: '已确认完成', review: '已提交，待平台审核', unknown: '结果未确认', error: '未能完成', pending: '等待平台确认', quiet: '这次保持安静', limit: '暂无可执行动作', missed: '错过的机会已跳过', checking: '正在检查平台连接', unavailable: '平台接入暂不可用', deciding: '正在思考', decided: '已形成想法', busy: '等空闲时再表达', cancelled: '已取消' };
  const actionNames = { post: '空间动态', signature: '签名', avatar: '头像' };
  const avatarNames = { hello: '打招呼', happy: '开心', thinking: '思考', comfort: '安慰' };
  $('self-expression-summary').textContent = !config.enabled ? '自主表达尚未启用。可以在「人格与设置」中安排表达习惯。'
    : `表达欲 ${config.desire ?? 45}% · 自动机会间隔至少 ${config.cooldownMinutes ?? 360} 分钟 · ${String(config.startHour ?? 9).padStart(2, '0')}:00–${String(config.endHour ?? 23).padStart(2, '0')}:00（${config.timeZone || 'Asia/Shanghai'}）。`;
  $('self-expression-mood').textContent = status.mood || '还没有表达状态';
  $('self-expression-reason').textContent = status.reason || '有想法时，也可以选择安静。';
  let next = config.enabled ? '等待安排' : '启用后安排';
  if (config.enabled && inDay) next = status.nextRunAt
    ? new Date(status.nextRunAt).toLocaleString('zh-CN', { timeZone: config.timeZone || 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    : '今天暂无后续机会';
  $('self-expression-next').textContent = next;
  $('self-expression-count').textContent = `${count} / ${config.dailyLimit ?? 80} 次（全平台合计）`;
  $('self-expression-outcome').textContent = status.busy ? '正在考虑表达…' : outcomes[status.lastOutcome] || '还没有记录';
  const heyboxTotal = (heyboxCounts.post || 0) + (heyboxCounts.comment || 0) + (heyboxCounts.reply || 0);
  $('self-expression-decisions').textContent = `今日已思考 ${inDay ? status.decisionAttempts || 0 : 0} / ${Math.max(6, config.dailyLimit ?? 80)} 次；QQ 动态 ${qqCounts.post || 0} / ${qq.dailyLimit ?? 80} 次，签名 ${qqCounts.signature || 0} / 1 次，头像 ${qqCounts.avatar || 0} 次；小黑盒公开表达 ${heyboxTotal} / ${heybox.dailyLimit ?? 80} 次（发帖 ${heyboxCounts.post || 0}、评论 ${heyboxCounts.comment || 0}、回复 ${heyboxCounts.reply || 0}）；B站通知回复 ${biliCounts.reply || 0} / ${bilibili.dailyLimit ?? 80} 次。尝试失败也计次。`;
  const platformStatus = $('self-expression-platform-status');
  platformStatus.replaceChildren();
  for (const [name, label] of Object.entries(actionNames)) {
    const item = status.outcomes?.qq?.[name];
    if (!item) continue;
    platformStatus.append(node('p', `QQ ${label} · ${outcomes[item.outcome] || '结果未确认'} · ${date(item.at)}`, 'caption'));
  }
  for (const [action, label] of [['post', '发帖'], ['comment', '评论'], ['reply', '回复']]) {
    const item = status.outcomes?.heybox?.[action];
    if (!item) continue;
    platformStatus.append(node('p', `小黑盒${label} · ${outcomes[item.outcome] || '结果未确认'} · ${date(item.at)}`, 'caption'));
    if (item.modified) platformStatus.append(node('p', '平台替换了部分文字，下方显示客户端中的正文。', 'caption'));
  }
  const biliReply = status.outcomes?.bilibili?.reply;
  const biliPost = status.outcomes?.bilibili?.post;
  if (biliPost) platformStatus.append(node('p', `B站文字动态 · ${biliPost.outcome === 'success' ? '已取得提交回执，审核与可见性未确认' : outcomes[biliPost.outcome] || '结果未确认'} · ${date(biliPost.at)}`, 'caption'));
  if (biliReply) platformStatus.append(node('p', `B站通知回复 · ${biliReply.outcome === 'success' ? '已取得提交回执，审核与可见性未确认' : outcomes[biliReply.outcome] || '结果未确认'} · ${date(biliReply.at)}`, 'caption'));
  const recent = $('self-expression-recent');
  recent.replaceChildren();
  for (const [label, value] of [[status.lastPostPlatform === 'bilibili' && status.lastPostState === 'success' ? '最近取得提交回执的动态' : status.lastPostState === 'review' ? '最近已提交动态（待审核）' : '最近已确认动态', [status.lastPostTitle, status.lastPostText].filter(Boolean).join('\n\n')], ['最近已确认签名', status.lastSignature], ['最近已确认头像', avatarNames[status.lastAvatarId]]]) {
    if (!value) continue;
    const row = node('div'); row.append(node('span', label, 'caption'), node('p', value)); recent.append(row);
  }
  recent.hidden = !recent.childElementCount;
  $('self-expression-error').hidden = !status.lastError;
  $('self-expression-error').textContent = status.lastError || '';
  $('self-expression-run').disabled = Boolean(status.busy || !config.enabled);
}

function renderAutonomyStatus(status = {}) {
  const config = state.data?.settings.autonomy || {};
  const hour = value => `${String(value).padStart(2, '0')}:00`;
  const inDay = Date.now() >= Date.parse(status.dayStartAt) && Date.now() < Date.parse(status.dayEndAt);
  const count = inDay ? status.attempts || 0 : 0;
  const limit = inDay ? Math.min(status.target, config.dailyMax) : null;
  $('autonomy-schedule-summary').textContent = config.enabled
    ? `${(config.sources || ['heybox']).map(source => source === 'bilibili' ? 'B站' : '小黑盒').join('、')} · 每天合计计划 ${config.dailyMin}–${config.dailyMax} 次，随机安排在 ${hour(config.startHour)}–${hour(config.endHour)}（${config.timeZone}）。`
    : '自主浏览尚未启用。可以在「人格与设置」中选择来源并安排日常。';
  let next = config.enabled ? '等待安排' : '启用后安排';
  if (config.enabled && inDay) {
    next = '今天暂无后续安排';
    if (status.nextRunAt && count < limit) next = new Date(status.nextRunAt).toLocaleString('zh-CN', { timeZone: config.timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  }
  $('autonomy-next').textContent = next;
  $('autonomy-count').textContent = limit !== null ? `${count} / ${limit} 次` : `${count} 次 · 尚未安排`;
  const outcomes = { success: '阅读完成', skipped: '未新增阅读', cancelled: '已取消', error: '未能完成' };
  $('autonomy-outcome').textContent = status.busy ? '正在浏览与思考…' : status.lastOutcome === 'success' && status.lastReflectionOutcome === 'success' ? '阅读与笔记已完成' : outcomes[status.lastOutcome] || '还没有记录';
  $('autonomy-last').hidden = !status.lastAttempt;
  $('autonomy-last').textContent = status.lastAttempt ? `最近活动：${date(status.lastAttempt)}${status.lastTitle ? ` · ${status.lastTitle}` : ''}${status.lastUrl ? ` · ${status.lastUrl}` : ''}` : '';
  $('autonomy-error').hidden = !status.lastError && !status.lastReflectionError;
  $('autonomy-error').textContent = status.lastError || status.lastReflectionError || '';
  $('autonomy-run').disabled = Boolean(status.busy || !config.enabled || (limit !== null && count >= limit));
}

function fillBackupSettings() {
  const backup = state.data.settings.backup || {};
  const webdav = backup.webdav || {};
  $('backup-enabled').checked = Boolean(backup.enabled);
  $('backup-interval').value = backup.intervalHours || 24;
  $('backup-keep-local').value = backup.keepLocal || 30;
  $('backup-local-directory').value = backup.localDirectory || '';
  $('backup-passphrase').value = '';
  $('backup-passphrase').disabled = false;
  $('backup-clear-passphrase').checked = false;
  $('backup-passphrase-status').textContent = backup.hasPassphrase ? '已保存口令。留空保留，界面不会回填口令。' : '尚未保存口令。首次备份前请设置并另行保管。';
  $('backup-webdav-enabled').checked = Boolean(webdav.enabled);
  $('backup-webdav-url').value = webdav.url || '';
  $('backup-webdav-username').value = webdav.username || '';
  $('backup-webdav-password').value = '';
  $('backup-webdav-password').disabled = false;
  $('backup-webdav-clear-password').checked = false;
  $('backup-webdav-password-status').textContent = webdav.hasPassword ? '已保存密码。留空保留，界面不会回填密码。' : '尚未保存 WebDAV 密码。';
}

function renderBackupStatus(status = {}) {
  const backup = state.data?.settings.backup || {};
  const remoteEnabled = Boolean(backup.webdav?.enabled);
  $('backup-schedule-summary').textContent = backup.enabled
    ? `每 ${backup.intervalHours} 小时备份一次，保留 ${backup.keepLocal} 个本地版本。${remoteEnabled ? '已启用 WebDAV 上传，实际结果见下方。' : '仅保存本地版本，未启用云盘同步。'}`
    : `定期备份尚未启用。${remoteEnabled ? '手动执行时将尝试 WebDAV 上传。' : '未启用云盘同步。'}`;
  const box = $('backup-status');
  box.replaceChildren();
  let title = '尚未执行备份';
  let kind = '';
  if (status.busy) title = '正在备份与校验…';
  else if (status.lastError) { title = status.lastLocalFile ? '最近备份未完成；已保存的本地文件见下方' : '最近一次备份失败'; kind = 'error'; }
  else if (status.remoteVerified) { title = '远端文件已下载校验成功'; kind = 'success'; }
  else if (status.lastSuccess || status.lastLocalFile) { title = '仅本地备份成功'; kind = 'success'; }
  box.append(node('strong', title, `backup-status-title ${kind}`));
  const details = [
    ['最近尝试', status.lastAttempt ? date(status.lastAttempt) : '尚无记录'],
    ['最近成功', status.lastSuccess ? date(status.lastSuccess) : '尚无记录'],
    ['本地文件', status.lastLocalFile],
    ['远端文件', status.lastRemoteUrl],
    ['最近错误', status.lastError],
  ];
  for (const [label, value] of details) {
    if (!value) continue;
    const row = node('div', null, 'backup-status-row');
    row.append(node('span', label), node('p', value));
    box.append(row);
  }
  $('backup-run').disabled = Boolean(status.busy);
}

async function refreshBackupStatus() {
  const result = await api('/api/backups/status');
  const status = result.status || result;
  state.data.backupStatus = status;
  renderBackupStatus(status);
}

const lines = id => $(id).value.split(/[\n,，]+/).map(value => value.trim()).filter(Boolean);

$('auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('auth-error').textContent = '';
  $('auth-submit').disabled = true;
  try {
    const setup = !state.status.initialized;
    await api(setup ? '/api/setup' : '/api/login', { method: 'POST', data: { password: $('auth-password').value, ...(setup ? { setupKey: $('setup-key').value.trim() } : {}) } });
    state.status = await api('/api/status');
    await enterApp();
  } catch (error) { $('auth-error').textContent = error.message; }
  finally { $('auth-submit').disabled = false; }
});

$('logout').addEventListener('click', () => action($('logout'), async () => {
  await api('/api/logout', { method: 'POST', data: {} });
  state.status.authenticated = false;
  state.data = null;
  state.expressions.clear();
  state.books = [];
  state.preview = null;
  $('export-passphrase').value = '';
  $('restore-passphrase').value = '';
  $('model-api-key').value = '';
  $('backup-passphrase').value = '';
  $('drawing-api-key').value = '';
  $('backup-webdav-password').value = '';
  $('qq-access-token').value = '';
  $('qq-webhook-secret').value = '';
  $('auth-error').textContent = '';
  showAuth();
}));

document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.page)));
document.querySelectorAll('[data-goto]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.goto)));
document.querySelectorAll('[data-chat-scope]').forEach(button => button.addEventListener('click', async () => {
  if (state.busyChat) return;
  state.scope = button.dataset.chatScope;
  document.querySelectorAll('[data-chat-scope]').forEach(item => item.classList.toggle('active', item === button));
  $('chat-scope-hint').textContent = state.scope === 'owner' ? '只有你们的对话' : '本地群聊场景演练';
  renderSources([]);
  try { await loadMessages(); } catch (error) { toast(error.message, true); }
}));

$('chat-form').addEventListener('submit', async event => {
  event.preventDefault();
  const message = $('chat-input').value.trim();
  if (!message || state.busyChat) return;
  state.busyChat = true;
  $('chat-send').disabled = true;
  $('chat-input').disabled = true;
  document.querySelectorAll('[data-chat-scope]').forEach(button => { button.disabled = true; });
  $('chat-messages').querySelector('.empty-state')?.remove();
  appendMessage({ role: 'user', content: message, createdAt: new Date().toISOString() });
  const pending = appendMessage({ role: 'assistant', content: '正在整理思绪…' }, true);
  $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
  let succeeded = false;
  try {
    const result = await api('/api/chat', { method: 'POST', data: { message, scope: state.scope } });
    succeeded = true;
    $('chat-input').value = '';
    renderSources(result.memories || []);
    pending.remove();
    appendMessage({ role: 'assistant', content: result.reply, scope: state.scope, metadata: { expressionIds: result.expressionIds || [] }, createdAt: new Date().toISOString() });
    await Promise.all([loadMessages(), loadState()]);
  } catch (error) {
    toast(error.message, true);
    pending.remove();
    if (!succeeded) { try { await loadMessages(); } catch {} }
  } finally {
    state.busyChat = false;
    $('chat-send').disabled = false;
    $('chat-input').disabled = false;
    document.querySelectorAll('[data-chat-scope]').forEach(button => { button.disabled = false; });
    if (state.page === 'chat' && state.status.authenticated) $('chat-input').focus();
  }
});
$('chat-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('chat-form').requestSubmit(); } });
$('memory-search').addEventListener('submit', event => { event.preventDefault(); action($('memory-search'), loadMemories); });
$('memory-scope').addEventListener('change', () => { loadMemories().catch(error => toast(error.message, true)); });
$('new-memory').addEventListener('click', () => editMemory());
['close-memory', 'cancel-memory'].forEach(id => $(id).addEventListener('click', () => $('memory-dialog').close()));
$('memory-form').addEventListener('submit', event => {
  event.preventDefault();
  action($('memory-form'), async () => {
    const id = $('memory-id').value;
    await api(id ? `/api/memories/${encodeURIComponent(id)}` : '/api/memories', {
      method: id ? 'PATCH' : 'POST', data: { title: $('memory-title').value.trim(), content: $('memory-content').value.trim(), category: $('memory-category').value, scope: $('memory-edit-scope').value, sourceRef: $('memory-source').value.trim(), sourceType: $('memory-form').dataset.sourceType || 'manual' },
    });
    $('memory-dialog').close();
    await Promise.all([loadMemories(), loadState()]);
    toast(id ? '记忆已修订，原版本已留存。' : '新的记忆已放进书架。');
  });
});

$('read-form').addEventListener('submit', event => {
  event.preventDefault();
  action($('read-form'), async () => {
    $('read-submit').textContent = '正在阅读…';
    try {
      const { page, memory, reusedMemory, memoryParts } = await api('/api/read', { method: 'POST', data: { url: $('read-url').value.trim(), scope: $('read-scope').value } });
      const saved = node('p', page.evidence?.sourceKind === 'bilibili-transcript' ? `已取得视频文字，保存为 ${memoryParts?.length || 1} 段书架资料` : reusedMemory ? '已重新阅读，正文未变化，沿用原有记忆' : '已阅读并保存到记忆书架', 'eyebrow');
      const link = node('a', page.url, 'article-url');
      const url = new URL(page.url);
      if (['http:', 'https:'].includes(url.protocol)) { link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; }
      const edit = node('button', '查看这条记忆 ↗', 'button secondary');
      edit.addEventListener('click', () => editMemory(memory));
      $('reading-result').replaceChildren(saved, node('h2', page.title), link, node('p', page.excerpt || page.text?.slice(0, 7000), 'article-body'), edit);
      if (page.truncated) $('reading-result').append(node('p', '正文超过本次提取上限，已保存前部内容；不代表读完原网页。', 'caption'));
      if (page.evidence?.sourceKind === 'bilibili-transcript') $('reading-result').append(node('p', '已保存本次取得的全部文字与时间戳；未观看画面或收听音频，也不保证完整覆盖视频。其他分段可在记忆书架按视频标题查找。', 'caption'));
      await Promise.all([loadEvents(), loadState()]);
      toast('阅读完成，内容与来源已保存。');
    } finally { $('read-submit').textContent = '阅读并保存 ↗'; }
  });
});
$('refresh-events').addEventListener('click', () => action($('refresh-events'), loadEvents));
$('refresh-books').addEventListener('click', () => action($('refresh-books'), () => Promise.all([loadBooks(), loadState()])));
$('book-file-form').addEventListener('submit', event => {
  event.preventDefault();
  action($('book-file-form'), async () => {
    const file = $('book-file').files[0], output = $('book-file-result'); let imported = false;
    output.textContent = '';
    if (!file || !/\.(?:txt|epub)$/i.test(file.name)) throw new Error('请选择 UTF-8 TXT 或 EPUB 电子书。');
    if (!file.size || file.size > 3 * 1024 * 1024) throw new Error('书籍文件须非空，且不超过 3 MiB。');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    const title = $('book-file-title').value.trim();
    try {
      output.textContent = '正在提取并导入文字…';
      await api('/api/books/file', { method: 'POST', data: { name: file.name, data: btoa(binary), ...(title ? { title } : {}) } }); imported = true;
      $('book-file-form').reset(); await loadBooks();
      output.textContent = '书籍文字已加入书房，尚未调用模型阅读；EPUB 不保留图片与排版。'; toast('书籍已导入书房。');
    } catch (error) { output.textContent = imported ? '已导入，列表刷新未完成。请点击「刷新书房」。' : '导入未完成，请检查文件后重试。'; throw error; }
  });
});
$('book-url-form').addEventListener('submit', event => {
  event.preventDefault();
  action($('book-url-form'), async () => {
    const output = $('book-url-result'); let imported = false;
    const url = $('book-url').value.trim(), title = $('book-url-title').value.trim();
    let parsed; try { parsed = new URL(url); } catch { throw new Error('请输入完整的公开网页地址。'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('请输入不含登录凭据的公开 HTTPS 网页地址。');
    try {
      output.textContent = '正在读取当前页正文…';
      await api('/api/books/import', { method: 'POST', data: { url, ...(title ? { title } : {}) } }); imported = true;
      $('book-url-form').reset(); await loadBooks();
      output.textContent = '当前页正文已加入书房；其他分页和章节未导入。'; toast('当前页正文已导入书房。');
    } catch (error) { output.textContent = imported ? '已导入当前页，列表刷新未完成。请点击「刷新书房」。' : '导入未完成，请确认页面可公开阅读。'; throw error; }
  });
});
$('book-run').addEventListener('click', () => action($('book-run'), async () => {
  renderBookStatus({ ...state.data.bookStatus, busy: true });
  try {
    const result = await api('/api/books/run', { method: 'POST', data: {} });
    await Promise.all([loadBooks(), loadState()]);
    toast(result.status?.lastOutcome === 'success' ? '已读完一小段，笔记保存到记忆书架。' : result.status?.skipped === 'no_unread_books' ? '书房里暂时没有未读内容。' : '本次阅读已结束，结果见上方。');
  } catch (error) { try { await Promise.all([loadBooks(), loadState()]); } catch {} throw error; }
}).finally(() => renderBookStatus(state.data?.bookStatus)));
$('refresh-expressions').addEventListener('click', () => action($('refresh-expressions'), () => loadExpressions()));
$('expression-upload-form').addEventListener('submit', event => {
  event.preventDefault();
  action($('expression-upload-form'), async () => {
    const output = $('expression-upload-result');
    output.textContent = '';
    const files = $('expression-upload-file').files;
    if (files.length !== 1) throw new Error('请只选择一张图片。');
    const file = files[0];
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) throw new Error('请选择 PNG、JPEG、WebP 或 GIF 图片。');
    if (!file.size || file.size > 2 * 1024 * 1024) throw new Error('图片须为非空文件，且不超过 2 MiB。');
    const name = $('expression-upload-name').value.trim(), description = $('expression-upload-description').value.trim();
    if (!name || name.length > 40 || !description || description.length > 300) throw new Error('请填写 1–40 字的名称与 1–300 字的适用情境。');
    output.textContent = '正在上传…';
    let uploaded = false;
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('无法读取图片文件。'));
        reader.onerror = () => reject(new Error('无法读取图片文件，请重新选择。'));
        reader.onabort = () => reject(new Error('图片读取已取消。'));
        reader.readAsDataURL(file);
      });
      await api('/api/expressions', { method: 'POST', data: { name, description, image: { mimeType: file.type, dataUrl } } });
      uploaded = true;
      $('expression-upload-form').reset();
      output.textContent = '上传完成，这张表情已可在所有聊天中选择。';
      await loadExpressions();
      toast('新表情已加入表情库。');
    } catch (error) {
      output.textContent = uploaded ? '表情已上传，列表刷新未完成。请点击「刷新表情库」。' : '上传未完成，请检查图片后重试。';
      throw error;
    }
  });
});
$('refresh-autonomy').addEventListener('click', () => action($('refresh-autonomy'), () => Promise.all([loadState(), loadEvents()])));
$('autonomy-run').addEventListener('click', () => action($('autonomy-run'), async () => {
  renderAutonomyStatus({ ...state.data.autonomyStatus, busy: true });
  try {
    const result = await api('/api/autonomy/run', { method: 'POST', data: {} });
    await Promise.all([loadState(), loadEvents()]);
    toast(result.status?.skipped ? '这次浏览已完成，没有新增可阅读的帖子。' : '这次浏览已完成，内容和来源已记下。');
  } catch (error) {
    try { await Promise.all([loadState(), loadEvents()]); } catch {}
    throw error;
  }
}).finally(() => renderAutonomyStatus(state.data?.autonomyStatus)));
$('refresh-self-expression').addEventListener('click', () => action($('refresh-self-expression'), () => Promise.all([loadState(), loadEvents()])));
$('refresh-mood').addEventListener('click', () => action($('refresh-mood'), () => loadState()));
$('mood-run').addEventListener('click', () => action($('mood-run'), async () => {
  const result = await api('/api/mood/run', { method: 'POST', data: {} });
  await Promise.all([loadState(), loadEvents()]);
  const notices = { disabled: '请先保存并启用心情评估。', busy: '她正在处理其他事情，稍后再评估。', daily_limit: '今日评估次数已用完。', no_new_input: '没有新的可评估资料。', no_input: '没有新的可评估资料。', cancelled: '本次评估已取消。', low_confidence: '这次判断把握不足，保留原状态。', unchanged: '没有新的明显变化，心境继续自然回稳。' };
  toast(notices[result.status?.skipped || result.status?.lastOutcome] || result.status?.lastError || '评估已结束，状态见上方。');
}));
$('mate-reset').addEventListener('click', () => action($('mate-reset'), async () => {
  state.mateResetPending = true;
  renderMateStatus();
  let reset = false;
  try {
    await api('/api/mate/reset', { method: 'POST', data: {} });
    reset = true;
    await loadState();
    toast('已重置数值节奏；记忆、发送记录、未回应记录与开关保持不变。');
  } catch {
    throw new Error(reset ? '节奏已重置，但状态刷新未完成，请刷新页面核对。' : '陪伴节奏未重置，请等待当前任务结束并核对本机配置后重试。');
  } finally { state.mateResetPending = false; }
}).finally(() => renderMateStatus()));
$('self-expression-run').addEventListener('click', () => action($('self-expression-run'), async () => {
  renderSelfExpressionStatus({ ...state.data.selfExpressionStatus, busy: true });
  try {
    const result = await api('/api/self-expression/run', { method: 'POST', data: {} });
    await Promise.all([loadState(), loadEvents()]);
    const status = result.status || result;
    const notices = { quiet: '这次选择安静，没有发布内容。', limit: '当前没有可执行的表达动作。', daily_limit: '今天的表达思考次数已用完。', busy: '她正在处理其他事情，稍后再安排。', disabled: '请先保存并启用自主表达。', cancelled: '这次表达机会已取消。', outside_hours: '当前不在表达活跃时段。', cooldown: '还在表达间隔内，稍后再安排。' };
    toast(notices[status.skipped || status.lastOutcome] || '这次表达机会已结束，结果见下方。');
  } catch (error) {
    try { await Promise.all([loadState(), loadEvents()]); } catch {}
    throw error;
  }
}).finally(() => renderSelfExpressionStatus(state.data?.selfExpressionStatus)));
$('refresh-accounts').addEventListener('click', () => action($('refresh-accounts'), () => loadState()));
$('heybox-binding-form').addEventListener('submit', event => {
  event.preventDefault();
  action(event.currentTarget, async () => {
    await api('/api/bindings/heybox', { method: 'POST', data: { userId: $('heybox-owner-id').value.trim() } });
    $('heybox-owner-id').value = '';
    await loadState(); toast('已记住创建人的小黑盒账号。');
  });
});
$('bilibili-binding-form').addEventListener('submit', event => {
  event.preventDefault();
  action(event.currentTarget, async () => {
    await api('/api/bindings/bilibili', { method: 'POST', data: { userId: $('bilibili-owner-id').value.trim() } });
    $('bilibili-owner-id').value = '';
    await loadState(); toast('已记住创建人的 B站账号。');
  });
});
$('binding-code').addEventListener('click', () => action($('binding-code'), async () => {
  const binding = await api('/api/bindings/code', { method: 'POST', data: {} });
  $('binding-command').textContent = binding.command;
  $('binding-expiry').textContent = `请在机器人 QQ 私聊中发送此命令。到期时间：${date(binding.expiresAt)}。发送后刷新账号列表。`;
  $('binding-result').hidden = false;
}));
$('copy-binding').addEventListener('click', () => action($('copy-binding'), async () => { await navigator.clipboard.writeText($('binding-command').textContent); toast('验证命令已复制。'); }));
$('feishu-binding-code').addEventListener('click', () => action($('feishu-binding-code'), async () => {
  const binding = await api('/api/bindings/feishu/code', { method: 'POST', data: {} });
  $('feishu-binding-command').textContent = binding.command;
  $('feishu-binding-expiry').textContent = `请在你的飞书账号与机器人私聊中发送。到期时间：${date(binding.expiresAt)}。发送后刷新账号列表确认。`;
  $('feishu-binding-result').hidden = false;
}));
$('feishu-reconnect').addEventListener('click', () => action($('feishu-reconnect'), async () => {
  await api('/api/feishu/reconnect', { method: 'POST', data: {} });
  await loadState(); toast('已重新核对飞书连接状态。');
}));

$('model-clear-api-key').addEventListener('change', () => { $('model-api-key').disabled = $('model-clear-api-key').checked; });
$('drawing-clear-api-key').addEventListener('change', () => { $('drawing-api-key').disabled = $('drawing-clear-api-key').checked; });
$('model-test').addEventListener('click', () => action($('model-test'), async () => {
  const output = $('model-test-result');
  output.hidden = false;
  output.classList.remove('error');
  output.textContent = '正在使用已保存的模型配置发送简短请求…';
  try {
    const result = await api('/api/model/test', { method: 'POST', data: {} });
    output.classList.toggle('error', !result.ok);
    output.textContent = result.ok ? `连接成功 · ${result.model}\n${result.reply || '模型已响应。'}` : result.message || '模型连接测试未通过。';
  } catch (error) { output.classList.add('error'); output.textContent = error.message; throw error; }
}));
$('qq-test').addEventListener('click', () => action($('qq-test'), async () => {
  const output = $('qq-test-result');
  output.hidden = false;
  output.classList.remove('error');
  output.textContent = '正在读取已保存协议端的登录和在线状态…';
  try {
    const result = await api('/api/qq/test', { method: 'POST', data: {} });
    output.classList.toggle('error', !result.ok || !result.online);
    const identity = [result.nickname, result.botId].filter(Boolean).join(' · ');
    output.textContent = `${result.message || (result.online ? '协议端在线。' : '协议端未在线。')}${identity ? `\n${identity}` : ''}${result.lastEventAt ? `\n最近收到事件：${date(result.lastEventAt)}` : ''}`;
  } catch (error) { output.classList.add('error'); output.textContent = error.message; throw error; }
}));
$('dsh-test').addEventListener('click', () => action($('dsh-test'), async () => {
  const output = $('dsh-test-result');
  output.hidden = false;
  output.classList.remove('error');
  output.textContent = '正在启动独立插件宿主并核对只读工具…';
  try {
    const result = await api('/api/dsh/check', { method: 'POST', data: {} });
    output.textContent = `运行层已响应。DSH ${result.versions.dsh} · B站阅读插件 ${result.versions.humanism}\n已加载栖忆只读书架工具；未调用模型、访问平台或发布内容。${result.proactive?.packageVerified ? '\n主动搭话原包已通过固定版本与文件校验；本次检测未执行拟聊回合。' : ''}${result.mood?.packageVerified ? '\n心情原包已通过固定版本与文件校验；本次检测未执行心情评估。' : ''}`;
  } catch (error) { output.classList.add('error'); output.textContent = error.message; throw error; }
}));
function showBiliLoginResult(result) {
  const output = $('bili-import-result');
  output.hidden = false; output.classList.remove('error');
  const readReady = result?.readReady === undefined ? result?.configured : result.readReady;
  if (readReady !== true) {
    output.classList.add('error'); output.textContent = '未确认B站登录状态已保存，请刷新状态或重新导入。';
    throw new Error(output.textContent);
  }
  output.textContent = result.socialReady === true
    ? 'B站登录已保存：阅读与社交凭据已齐备。这里只确认本机保存情况，不代表登录仍有效或评论回复已开启。'
    : '已保存B站阅读登录，社交凭据尚未齐备，暂不能用于评论回复。请重新登录专用账号，或将Chrome登录桥重载至1.1.0后重新导入。';
  toast(output.textContent);
}
$('bili-login').addEventListener('click', () => action($('bili-login'), async () => {
  await api('/api/bili/login', { method: 'POST', data: {} });
  await loadState(); toast('专用浏览器已打开，请手动登录后保存状态。');
}));
$('heybox-login').addEventListener('click', () => action($('heybox-login'), async () => {
  try {
    await api('/api/heybox/login', { method: 'POST', data: {} });
    toast('专用浏览器已打开，请手动完成小黑盒登录和验证。');
  } finally { await loadState(); }
}));
$('heybox-login-confirm').addEventListener('click', () => action($('heybox-login-confirm'), async () => {
  try {
    const result = await api('/api/heybox/login/confirm', { method: 'POST', data: {} });
    toast(result.configured && result.verifiedAt ? '已核验当前小黑盒专用账号并保存登录状态；核验只代表本次结果。' : '确认已结束，请核对专用账号配置后重试。', !(result.configured && result.verifiedAt));
  } finally { await loadState(); }
}).finally(() => { $('heybox-login-confirm').disabled = !state.data?.heyboxAccountStatus?.browserOpen; }));
$('bili-login-confirm').addEventListener('click', () => action($('bili-login-confirm'), async () => {
  const output = $('bili-import-result');
  output.hidden = false; output.classList.remove('error'); output.textContent = '正在确认B站专用账号登录…';
  try {
    const result = await api('/api/bili/login/confirm', { method: 'POST', data: {} });
    await loadState(); showBiliLoginResult(result);
  } catch (error) { output.classList.add('error'); output.textContent = error.message; throw error; }
}));
$('bili-login-import').addEventListener('click', () => action($('bili-login-import'), async () => {
  const output = $('bili-import-result');
  output.hidden = false; output.classList.remove('error'); output.textContent = '正在从当前 Chrome 导入 B站登录…';
  try {
    if (location.origin !== 'http://127.0.0.1:3210') throw new Error('请用已登录 B站的 Chrome 打开 http://127.0.0.1:3210 后导入。');
    const status = await api('/api/status');
    if (!status.authenticated) { state.status = status; showAuth(); throw new Error('请先登录创建人后台，再导入 B站登录。'); }
    if (!globalThis.chrome?.runtime?.sendMessage) throw new Error('请先在当前 Chrome 加载项目的 extensions/bili-login-bridge 扩展，再刷新后台。');
    const credentials = await new Promise((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('Chrome 登录桥未响应，请检查扩展已启用后重试。')), 10000);
      try {
        chrome.runtime.sendMessage('hkgopnkgggippabieimebcfgeicgohed', { action: 'memoria-import-bili' }, response => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) return reject(new Error('请先在当前 Chrome 加载项目的 extensions/bili-login-bridge 扩展，再刷新后台。'));
          if (response?.ok !== true || !response.credentials) return reject(new Error(response?.error === 'BILI_BRIDGE_NOT_LOGGED_IN'
            ? '当前 Chrome 未找到 B站登录，请在同一个 Chrome 资料中登录 B站后重试。' : 'Chrome 未返回有效的 B站登录状态，请检查扩展或重新登录后重试。'));
          accept(response.credentials);
        });
      } catch { clearTimeout(timer); reject(new Error('Chrome 登录桥未能连接，请检查扩展后重试。')); }
    });
    const result = await api('/api/bili/login/import', { method: 'POST', data: credentials });
    await loadState();
    showBiliLoginResult(result);
  } catch (error) { output.classList.add('error'); output.textContent = error.message; throw error; }
}));
$('settings-form').addEventListener('submit', event => {
  event.preventDefault();
  action($('settings-form'), async () => {
    if ($('qq-enabled').checked && !$('qq-bot-id').value.trim()) throw new Error('启用 QQ 前，请填写机器人 QQ 号。');
    if (Number($('drawing-weekly-limit').value) < Number($('drawing-daily-limit').value)) throw new Error('未来每周绘图限制不能小于每日限制。');
    if (Number($('self-expression-start-hour').value) >= Number($('self-expression-end-hour').value)) throw new Error('自主表达的开始时间须早于结束时间。');
    if (Number($('books-start-hour').value) >= Number($('books-end-hour').value)) throw new Error('读书的开始时间须早于结束时间。');
    if (Number($('proactive-start-hour').value) >= Number($('proactive-end-hour').value)) throw new Error('主动私聊的开始时间须早于结束时间。');
    $('settings-result').textContent = '正在保存…';
    try {
      await api('/api/settings', { method: 'PUT', data: {
        dshReading: { dailyReadLimit: Number($('dsh-reading-limit').value) },
        mood: { enabled: $('mood-enabled').checked, intervalMinutes: Number($('mood-interval').value), dailyLimit: Number($('mood-limit').value) },
        chatMemory: { enabled: $('chat-memory-enabled').checked, intervalMinutes: Number($('chat-memory-interval').value), dailyLimit: Number($('chat-memory-limit').value) },
        persona: { name: $('persona-name').value.trim(), description: $('persona-description').value.trim() },
        model: { baseUrl: $('model-base-url').value.trim(), model: $('model-name').value.trim(), apiKey: $('model-api-key').value.trim(), clearApiKey: $('model-clear-api-key').checked, dailyRequestLimit: Number($('model-daily-request-limit').value), ownerChatReserve: Number($('model-owner-reserve').value) },
        qq: { enabled: $('qq-enabled').checked, apiBaseUrl: $('qq-api-url').value.trim(), botId: $('qq-bot-id').value.trim(), accessToken: $('qq-access-token').value.trim(), webhookSecret: $('qq-webhook-secret').value.trim(), allowedUsers: lines('qq-users'), allowedGroups: lines('qq-groups'), dailyChatLimit: Number($('qq-chat-limit').value), mergeWindowMs: Number($('qq-merge-window').value), groupReplyChance: Number($('qq-group-reply-chance').value), groupReplyCooldownSeconds: Number($('qq-group-reply-cooldown').value), replySplitEnabled: $('qq-reply-split').checked, replyDelayMs: Number($('qq-reply-delay').value) },
        feishu: { enabled: $('feishu-enabled').checked, botId: $('feishu-bot-id').value.trim(), expectedFingerprint: $('feishu-fingerprint').value.trim(), allowedUsers: lines('feishu-users'), allowedGroups: lines('feishu-groups'), dailyChatLimit: Number($('feishu-chat-limit').value) },
        reading: { enabled: $('reading-enabled').checked, urls: lines('reading-urls'), intervalMinutes: Number($('reading-interval').value), dailyLimit: Number($('reading-limit').value) },
        autonomy: { enabled: $('autonomy-enabled').checked, sources: ['heybox', 'bilibili'].filter(source => $('autonomy-source-' + source).checked), interests: $('autonomy-interests').value.trim(), dailyMin: Number($('autonomy-daily-min').value), dailyMax: Number($('autonomy-daily-max').value), startHour: Number($('autonomy-start-hour').value), endHour: Number($('autonomy-end-hour').value), timeZone: $('autonomy-time-zone').value.trim() },
        drawing: { provider: $('drawing-provider').value, baseUrl: $('drawing-base-url').value.trim(), model: $('drawing-model').value.trim(), apiKey: $('drawing-api-key').value.trim(), clearApiKey: $('drawing-clear-api-key').checked, dailyLimit: Number($('drawing-daily-limit').value), weeklyLimit: Number($('drawing-weekly-limit').value) },
        selfExpression: { enabled: $('self-expression-enabled').checked, desire: Number($('self-expression-desire').value), dailyLimit: Number($('self-expression-daily-limit').value), cooldownMinutes: Number($('self-expression-cooldown').value), startHour: Number($('self-expression-start-hour').value), endHour: Number($('self-expression-end-hour').value), timeZone: $('self-expression-time-zone').value.trim(), avatarIntervalDays: Number($('self-expression-avatar-days').value), platforms: { qq: { enabled: $('self-expression-qq-enabled').checked, post: $('self-expression-qq-post').checked, signature: $('self-expression-qq-signature').checked, avatar: $('self-expression-qq-avatar').checked, dailyLimit: Number($('self-expression-qq-daily-limit').value), qzoneVisibility: Number($('self-expression-qq-visibility').value) }, heybox: { enabled: $('self-expression-heybox-enabled').checked, post: $('self-expression-heybox-post').checked, comment: $('self-expression-heybox-comment').checked, reply: $('self-expression-heybox-reply').checked, signature: false, avatar: false, dailyLimit: Number($('self-expression-heybox-daily-limit').value), topic: $('self-expression-heybox-topic').value.trim() }, bilibili: { enabled: $('self-expression-bilibili-enabled').checked, post: $('self-expression-bilibili-post').checked, comment: false, reply: $('self-expression-bilibili-reply').checked, signature: false, avatar: false, dailyLimit: Number($('self-expression-bilibili-daily-limit').value), inboxIntervalMinutes: Number($('self-expression-bilibili-inbox-minutes').value) } } },
        proactive: { enabled: $('proactive-enabled').checked, desire: Number($('proactive-desire').value), dailyLimit: Number($('proactive-daily-limit').value), cooldownMinutes: Number($('proactive-cooldown').value), idleMinutes: Number($('proactive-idle').value), startHour: Number($('proactive-start-hour').value), endHour: Number($('proactive-end-hour').value), timeZone: $('proactive-time-zone').value.trim() },
        books: { enabled: $('books-enabled').checked, dailyLimit: Number($('books-daily-limit').value), chunkChars: Number($('books-chunk-chars').value), startHour: Number($('books-start-hour').value), endHour: Number($('books-end-hour').value), timeZone: $('books-time-zone').value.trim() },
      } });
      await loadState({ fill: true });
      $('settings-result').textContent = `设置已保存 · ${date(new Date().toISOString())}`;
      toast('设置已保存。');
    } catch (error) { $('settings-result').textContent = '保存未完成，请检查后重试。'; throw error; }
  });
});

$('backup-clear-passphrase').addEventListener('change', () => { $('backup-passphrase').disabled = $('backup-clear-passphrase').checked; });
$('backup-webdav-clear-password').addEventListener('change', () => { $('backup-webdav-password').disabled = $('backup-webdav-clear-password').checked; });
$('backup-settings-form').addEventListener('submit', event => {
  event.preventDefault();
  action($('backup-settings-form'), async () => {
    const enabled = $('backup-enabled').checked;
    const clearPassphrase = $('backup-clear-passphrase').checked;
    const passphrase = $('backup-passphrase').value;
    const webdavEnabled = $('backup-webdav-enabled').checked;
    if (enabled && (clearPassphrase || (!passphrase && !state.data.settings.backup?.hasPassphrase))) throw new Error('启用定期备份前，请先设置至少 12 个字符的备份口令。');
    if (webdavEnabled && !$('backup-webdav-url').value.trim()) throw new Error('启用 WebDAV 前，请填写已有的远程目录地址。');
    $('backup-settings-result').textContent = '正在保存…';
    try {
      await api('/api/settings', { method: 'PUT', data: { backup: {
        enabled, intervalHours: Number($('backup-interval').value), keepLocal: Number($('backup-keep-local').value), localDirectory: $('backup-local-directory').value.trim(),
        passphrase: clearPassphrase ? '' : passphrase, clearPassphrase,
        webdav: { enabled: webdavEnabled, url: $('backup-webdav-url').value.trim(), username: $('backup-webdav-username').value.trim(), password: $('backup-webdav-clear-password').checked ? '' : $('backup-webdav-password').value, clearPassword: $('backup-webdav-clear-password').checked },
      } } });
      await loadState();
      fillBackupSettings();
      $('backup-settings-result').textContent = `备份设置已保存 · ${date(new Date().toISOString())}`;
      toast('备份设置已保存。可立即备份以验证结果。');
    } catch (error) { $('backup-settings-result').textContent = '保存未完成，请检查后重试。'; throw error; }
  });
});
$('refresh-backup').addEventListener('click', () => action($('refresh-backup'), refreshBackupStatus));
$('backup-run').addEventListener('click', () => action($('backup-run'), async () => {
  renderBackupStatus({ ...state.data.backupStatus, busy: true });
  try {
    const result = await api('/api/backups/run', { method: 'POST', data: {} });
    state.data.backupStatus = result.status;
    renderBackupStatus(result.status);
    if (result.status?.lastError) toast('备份未全部完成，请查看状态。', true);
    else toast(result.status?.remoteVerified ? '备份完成，远端文件已下载校验。' : '本地备份已完成。');
  } catch (error) {
    renderBackupStatus({ ...state.data.backupStatus, busy: false });
    try { await refreshBackupStatus(); } catch {}
    throw error;
  }
}));

$('export-form').addEventListener('submit', event => {
  event.preventDefault();
  action($('export-form'), async () => {
    const blob = await api('/api/backups/export', { method: 'POST', data: { passphrase: $('export-passphrase').value }, binary: true });
    const url = URL.createObjectURL(blob);
    const link = node('a'); link.href = url; link.download = `persona-${new Date().toISOString().slice(0, 10)}.pab`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('export-passphrase').value = '';
    toast('加密备份已生成，正在下载。请同时保管好备份口令。');
  });
});

function resetPreview() { state.preview = null; $('restore-preview').hidden = true; }
$('restore-file').addEventListener('change', resetPreview);
$('restore-passphrase').addEventListener('input', resetPreview);
$('preview-form').addEventListener('submit', event => {
  event.preventDefault();
  action($('preview-form'), async () => {
    resetPreview();
    const file = $('restore-file').files[0];
    if (!file) throw new Error('请先选择备份文件。');
    if (file.size > 30 * 1024 * 1024) throw new Error('备份文件超过当前支持的 30 MB。');
    const input = { archive: await file.text(), passphrase: $('restore-passphrase').value };
    const result = await api('/api/backups/preview', { method: 'POST', data: input });
    state.preview = input;
    const countLabels = { memories: '记忆', events: '经历', messages: '消息', accounts: '账号', revisions: '修订', tombstones: '删除记录', expressions: '表情', books: '书籍', followups: '聊天约定' };
    const counts = Object.entries(result.counts || {}).map(([key, value]) => `${countLabels[key] || key} ${value} ${key === 'books' ? '本' : '条'}`).join('，');
    $('restore-details').textContent = `备份检查通过。导出时间：${date(result.exportedAt)}。${counts}`;
    $('restore-preview').hidden = false;
  });
});
$('restore-confirm').addEventListener('click', () => action($('restore-confirm'), async () => {
  if (!state.preview) throw new Error('请先检查备份文件。');
  const result = await api('/api/backups/restore', { method: 'POST', data: { ...state.preview, confirm: true } });
  resetPreview();
  $('preview-form').reset();
  await loadState({ fill: true });
  toast(result.message || '备份恢复完成。');
}));

(async () => {
  try {
    state.status = await api('/api/status');
    if (state.status.authenticated) await enterApp();
    else showAuth();
  } catch (error) { $('boot-message').textContent = `${error.message} 刷新页面以重试。`; }
})();
