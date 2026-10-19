'use strict';

const $ = id => document.getElementById(id);
const labels = { chat: '对话实验室', memories: '记忆书架', reading: '网页阅读', identity: '身份与备份', settings: '人格与设置' };
const categories = { event: '共同经历', person: '人物', interest: '兴趣', reading: '阅读', promise: '约定' };
const scopes = { owner: '仅创建人', public: '公开记忆', 'group:demo': '演练群聊' };
const state = { status: {}, data: null, page: 'chat', scope: 'owner', memories: [], busyChat: false, preview: null };
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
  $('stat-memories').textContent = stats.memories ?? 0;
  $('stat-events').textContent = stats.events ?? 0;
  $('app-version').textContent = `v${state.status.version || '0.1.0'} · 本地开发版`;
  const schedule = settings.reading;
  $('reading-schedule-summary').textContent = schedule.enabled
    ? `每 ${schedule.intervalMinutes} 分钟读取一次，每天最多 ${schedule.dailyLimit} 页。${readingStatus?.lastRun ? `上次完成：${date(readingStatus.lastRun)}。` : '等待首次执行。'}${readingStatus?.lastError ? `最近失败：${readingStatus.lastError}` : ''}`
    : '尚未启用。可以在设置中添加阅读地址和时间间隔。';
  renderAccounts();
  renderBackupStatus(state.data.backupStatus);
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
  row.append(body);
  $('chat-messages').append(row);
  return row;
}

async function loadMessages() {
  const requestedScope = state.scope;
  const { messages } = await api(`/api/messages?scope=${encodeURIComponent(requestedScope)}`);
  if (requestedScope !== state.scope) return;
  $('chat-messages').replaceChildren();
  if (!messages.length) empty($('chat-messages'), '留下一句今天的开场白。', state.scope === 'owner' ? '可以聊聊你的兴趣，或试着告诉她一件值得记住的事。' : '这是本地群聊演练。创建人的私密记忆不会用于这里的回应。', '✳');
  else messages.forEach(message => appendMessage(message));
  $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
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
    content.append(node('p', event.metadata?.title || event.content?.slice(0, 140) || event.type), node('span', `${scopes[event.scope] || event.scope} · ${event.type === 'reading' ? '网页阅读' : event.type === 'error' ? '未完成的任务' : event.type}${event.sourceRef ? ` · ${event.sourceRef}` : ''}`));
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
  const { persona, model, qq, reading } = state.data.settings;
  $('persona-name').value = persona.name;
  $('persona-description').value = persona.description;
  $('model-base-url').value = model.baseUrl;
  $('model-name').value = model.model;
  $('model-api-key').value = '';
  $('model-api-key').disabled = false;
  $('model-clear-api-key').checked = false;
  $('model-key-status').textContent = model.hasApiKey ? '已配置密钥。留空保存会保留当前密钥。' : '尚未配置密钥，目前使用离线演示。';
  $('qq-enabled').checked = qq.enabled;
  $('qq-api-url').value = qq.apiBaseUrl;
  $('qq-bot-id').value = qq.botId;
  $('qq-access-token').value = '';
  $('qq-access-token').placeholder = qq.hasAccessToken ? '已配置，留空保留已有令牌' : '尚未配置';
  $('qq-webhook-secret').value = qq.webhookSecret || '';
  $('qq-users').value = qq.allowedUsers.join('\n');
  $('qq-groups').value = qq.allowedGroups.join('\n');
  $('reading-enabled').checked = reading.enabled;
  $('reading-urls').value = reading.urls.join('\n');
  $('reading-interval').value = reading.intervalMinutes;
  $('reading-limit').value = reading.dailyLimit;
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
  state.preview = null;
  $('export-passphrase').value = '';
  $('restore-passphrase').value = '';
  $('model-api-key').value = '';
  $('backup-passphrase').value = '';
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
      const { page, memory } = await api('/api/read', { method: 'POST', data: { url: $('read-url').value.trim(), scope: $('read-scope').value } });
      const saved = node('p', '已阅读并保存到记忆书架', 'eyebrow');
      const link = node('a', page.url, 'article-url');
      const url = new URL(page.url);
      if (['http:', 'https:'].includes(url.protocol)) { link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; }
      const edit = node('button', '查看这条记忆 ↗', 'button secondary');
      edit.addEventListener('click', () => editMemory(memory));
      $('reading-result').replaceChildren(saved, node('h2', page.title), link, node('p', page.excerpt || page.text?.slice(0, 7000), 'article-body'), edit);
      await Promise.all([loadEvents(), loadState()]);
      toast('阅读完成，内容与来源已保存。');
    } finally { $('read-submit').textContent = '阅读并保存 ↗'; }
  });
});
$('refresh-events').addEventListener('click', () => action($('refresh-events'), loadEvents));
$('refresh-accounts').addEventListener('click', () => action($('refresh-accounts'), () => loadState()));
$('binding-code').addEventListener('click', () => action($('binding-code'), async () => {
  const binding = await api('/api/bindings/code', { method: 'POST', data: {} });
  $('binding-command').textContent = binding.command;
  $('binding-expiry').textContent = `请在机器人 QQ 私聊中发送此命令。到期时间：${date(binding.expiresAt)}。发送后刷新账号列表。`;
  $('binding-result').hidden = false;
}));
$('copy-binding').addEventListener('click', () => action($('copy-binding'), async () => { await navigator.clipboard.writeText($('binding-command').textContent); toast('验证命令已复制。'); }));

$('model-clear-api-key').addEventListener('change', () => { $('model-api-key').disabled = $('model-clear-api-key').checked; });
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
$('settings-form').addEventListener('submit', event => {
  event.preventDefault();
  action($('settings-form'), async () => {
    if ($('qq-enabled').checked && !$('qq-bot-id').value.trim()) throw new Error('启用 QQ 前，请填写机器人 QQ 号。');
    $('settings-result').textContent = '正在保存…';
    try {
      await api('/api/settings', { method: 'PUT', data: {
        persona: { name: $('persona-name').value.trim(), description: $('persona-description').value.trim() },
        model: { baseUrl: $('model-base-url').value.trim(), model: $('model-name').value.trim(), apiKey: $('model-api-key').value.trim(), clearApiKey: $('model-clear-api-key').checked },
        qq: { enabled: $('qq-enabled').checked, apiBaseUrl: $('qq-api-url').value.trim(), botId: $('qq-bot-id').value.trim(), accessToken: $('qq-access-token').value.trim(), webhookSecret: $('qq-webhook-secret').value.trim(), allowedUsers: lines('qq-users'), allowedGroups: lines('qq-groups') },
        reading: { enabled: $('reading-enabled').checked, urls: lines('reading-urls'), intervalMinutes: Number($('reading-interval').value), dailyLimit: Number($('reading-limit').value) },
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
    const countLabels = { memories: '记忆', events: '经历', messages: '消息', accounts: '账号', revisions: '修订', tombstones: '删除记录' };
    const counts = Object.entries(result.counts || {}).map(([key, value]) => `${countLabels[key] || key} ${value} 条`).join('，');
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
