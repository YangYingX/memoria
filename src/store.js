import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { imageMimeType } from './images.js';
import { assertPublicUrl } from './public-fetch.js';
import { normalizeMoodState } from './mood.js';

const LIMITS = { title: 200, memory: 30000, event: 30000, metadata: 16000, sourceRef: 2048 };
const EXPRESSION_LIMITS = { image: 2 * 1024 * 1024, total: 8 * 1024 * 1024, count: 64, perOrigin: 20 };
const BOOK_LIMITS = { chars: 1000000, bytes: 1024 * 1024, total: 5 * 1024 * 1024, count: 10 };

function invalid(message) {
  const error = new Error(message);
  error.validation = true;
  throw error;
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    invalid(`${label}必须是对象。`);
  }
  return value;
}

function text(value, label, max, { empty = false, trim = true } = {}) {
  if (typeof value !== 'string') invalid(`${label}必须是文本。`);
  const result = trim ? value.trim() : value;
  if ((!empty && !result.trim()) || result.length > max || result.includes('\0')) invalid(`${label}长度须为 ${empty ? 0 : 1}–${max} 字，且不能包含空字符。`);
  return result;
}

function identifier(value, label = '标识') {
  const result = text(value, label, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:@-]*$/.test(result)) invalid(`${label}格式无效。`);
  return result;
}

function scopeValue(value) {
  const result = text(value, '可见范围', 160);
  if (!/^(owner|public|(?:group|person):[a-zA-Z0-9][a-zA-Z0-9_.:@-]{0,127})$/.test(result)) invalid('可见范围须为 owner、public、group:<id> 或 person:<id>。');
  return result;
}

function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`${label}须为 ${min}–${max} 的整数。`);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) invalid(`${label}须为 ISO 时间。`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) invalid(`${label}无效。`);
  return value;
}

function jsonValue(value, label, max = LIMITS.metadata) {
  function check(item, depth) {
    if (depth > 10) invalid(`${label}嵌套过深。`);
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (Array.isArray(item)) {
      if (item.length > 2000) invalid(`${label}数组过长。`);
      for (const child of item) check(child, depth + 1);
      return;
    }
    record(item, label);
    const entries = Object.entries(item);
    if (entries.length > 2000) invalid(`${label}字段过多。`);
    for (const [key, child] of entries) {
      if (key.length > 200) invalid(`${label}字段名过长。`);
      check(child, depth + 1);
    }
  }
  check(value, 0);
  const encoded = JSON.stringify(value);
  if (encoded.length > max) invalid(`${label}超过 ${max} 字的大小限制。`);
  return JSON.parse(encoded);
}

function metadataValue(value = {}) {
  record(value, '附加信息');
  return jsonValue(value, '附加信息');
}

function memoryFields(input) {
  record(input, '记忆');
  return {
    title: text(input.title, '记忆标题', LIMITS.title),
    content: text(input.content, '记忆正文', LIMITS.memory),
    category: text(input.category === undefined ? 'event' : input.category, '记忆分类', 40),
    scope: scopeValue(input.scope === undefined ? 'owner' : input.scope),
    sourceType: text(input.sourceType === undefined ? 'manual' : input.sourceType, '来源类型', 40),
    sourceRef: text(input.sourceRef === undefined ? '' : input.sourceRef, '来源引用', LIMITS.sourceRef, { empty: true }),
  };
}

function eventFields(input) {
  record(input, '经历');
  return {
    type: text(input.type, '经历类型', 40),
    scope: scopeValue(input.scope),
    actor: text(input.actor === undefined ? 'owner' : input.actor, '参与者', 160),
    content: text(input.content, '经历正文', LIMITS.event),
    sourceRef: text(input.sourceRef === undefined ? '' : input.sourceRef, '来源引用', LIMITS.sourceRef, { empty: true }),
    metadata: metadataValue(input.metadata),
  };
}

function messageFields(input) {
  record(input, '消息');
  if (!['user', 'assistant'].includes(input.role)) invalid('消息角色须为 user 或 assistant。');
  return {
    scope: scopeValue(input.scope),
    role: input.role,
    content: text(input.content, '消息正文', input.role === 'user' ? 8000 : 16000),
    actor: text(input.actor === undefined ? 'owner' : input.actor, '参与者', 160),
    metadata: metadataValue(input.metadata),
  };
}

function accountFields(input) {
  record(input, '账号绑定');
  const platform = text(input.platform, '平台名称', 32).toLowerCase();
  if (!/^[a-z][a-z0-9_-]*$/.test(platform)) invalid('平台名称须使用字母、数字、下划线或短横线，并以字母开头。');
  const userId = text(input.userId, '平台用户 ID', 128);
  if (/[\u0000-\u001f\u007f]/.test(userId)) invalid('平台用户 ID 不能包含控制字符。');
  return {
    platform, userId,
    personId: identifier(input.personId === undefined ? 'owner' : input.personId, '人物 ID'),
    label: text(input.label === undefined ? '' : input.label, '账号备注', 120, { empty: true }),
  };
}

function personaValue(value) {
  if (value === null) return null;
  record(value, '人格设定');
  return {
    name: text(value.name, '人格名称', 80),
    description: text(value.description, '人格描述', 12000, { empty: true }),
  };
}

function expressionOrigin(value) {
  const origin = text(value, '表情来源会话', 48);
  if (origin !== 'custom' && !/^qq:(private|group):[1-9]\d{0,19}$/.test(origin)) invalid('表情来源须为管理员上传、明确的 QQ 私聊或群聊。');
  return origin;
}

function expressionId(value) {
  const id = text(value, '表情 ID', 64);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) invalid('表情 ID 格式无效。');
  return id;
}

function expressionFields(input) {
  record(input, '表情');
  const origin = expressionOrigin(input.origin);
  const scope = scopeValue(input.scope);
  const actor = text(input.actor === undefined ? 'owner' : input.actor, '收藏者', 160);
  const [, kind, account] = origin.split(':');
  if (origin === 'custom' ? scope !== 'public' || actor !== 'owner'
    : kind === 'group' ? scope !== `group:${account}` : !['owner', `person:qq:${account}`].includes(scope)) {
    invalid('表情可见范围与来源会话不一致。');
  }
  const image = record(input.image, '表情图片');
  if (typeof image.dataUrl !== 'string' || image.dataUrl.length > Math.ceil(EXPRESSION_LIMITS.image / 3) * 4 + 40) {
    invalid('单张表情不能超过 2 MiB。');
  }
  const match = image.dataUrl.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) invalid('表情须为 JPEG、PNG、WebP 或 GIF 图片数据。');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > EXPRESSION_LIMITS.image || bytes.toString('base64') !== match[2]) {
    invalid('表情编码无效或超过单张 2 MiB 限制。');
  }
  let mimeType;
  try { mimeType = imageMimeType(bytes); } catch { invalid('表情的实际图片格式不受支持。'); }
  if (mimeType !== image.mimeType || mimeType !== match[1]) invalid('表情的实际图片格式与声明不一致。');
  return {
    name: text(input.name, '表情名称', 40), description: text(input.description, '表情描述', 300),
    scope, origin, mimeType, data: match[2], hash: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length,
    actor,
  };
}

function expressionCapacity(items) {
  if (items.length > EXPRESSION_LIMITS.count) invalid('表情库已达到 64 张上限，请先在后台删除不需要的表情。');
  let bytes = 0;
  const origins = new Map();
  for (const item of items) {
    bytes += item.byteLength;
    if (item.origin === 'custom') continue;
    const count = (origins.get(item.origin) || 0) + 1;
    if (count > EXPRESSION_LIMITS.perOrigin) invalid('该会话的表情已达到 20 张上限，请先在后台删除不需要的表情。');
    origins.set(item.origin, count);
  }
  if (bytes > EXPRESSION_LIMITS.total) invalid('表情库已达到 8 MiB 容量上限，请先在后台删除不需要的表情。');
}

const expressionRow = row => row ? ({ id: row.id, name: row.name, description: row.description, scope: row.scope,
  origin: row.origin, mimeType: row.mime_type, createdAt: row.created_at }) : null;
const expressionImageRow = row => row ? ({ ...expressionRow(row), dataUrl: `data:${row.mime_type};base64,${row.data}` }) : null;

function bookId(value) {
  const id = text(value, '书籍 ID', 64);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) invalid('书籍 ID 格式无效。');
  return id;
}

function bookFields(input) {
  record(input, '书籍');
  const content = text(input.text, '书籍正文', BOOK_LIMITS.chars, { trim: false });
  if (Buffer.byteLength(content, 'utf8') > BOOK_LIMITS.bytes) invalid('单本书正文不能超过 1 MiB。');
  let sourceRef = text(input.sourceRef === undefined ? '' : input.sourceRef, '书籍来源', LIMITS.sourceRef, { empty: true });
  if (sourceRef) {
    if (/[\u0000-\u001f\u007f]/.test(sourceRef)) invalid('书籍来源不能包含控制字符。');
    try {
      const url = assertPublicUrl(sourceRef);
      if (url.protocol !== 'https:') invalid('在线书籍来源须使用 HTTPS。');
      sourceRef = url.href;
    } catch { invalid('书籍来源须为空或不含凭据的公开 HTTPS 地址。'); }
  }
  return { title: text(input.title, '书籍标题', 200), sourceRef, text: content };
}

function bookCapacity(books) {
  const active = books.filter(book => !book.deletedAt);
  if (active.length > BOOK_LIMITS.count) invalid('书架最多保存 10 本有效书籍，请先删除不需要的书。');
  if (active.reduce((sum, book) => sum + Buffer.byteLength(book.text, 'utf8'), 0) > BOOK_LIMITS.total) invalid('书架正文总量不能超过 5 MiB，请先删除不需要的书。');
}

const bookRow = row => row ? ({ id: row.id, title: row.title, sourceRef: row.source_ref, text: row.text,
  currentOffset: row.current_offset, createdAt: row.created_at, lastReadAt: row.last_read_at, deletedAt: row.deleted_at }) : null;
const bookMetadata = book => {
  if (!book) return null;
  const { text, ...metadata } = book;
  return { ...metadata, totalChars: text.length, byteLength: Buffer.byteLength(text, 'utf8') };
};

const memoryRow = row => row ? {
  id: row.id, title: row.title, content: row.content, category: row.category, scope: row.scope,
  sourceType: row.source_type, sourceRef: row.source_ref,
  createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at,
} : null;
const eventRow = row => ({ id: row.id, type: row.type, scope: row.scope, actor: row.actor, content: row.content, sourceRef: row.source_ref, metadata: JSON.parse(row.metadata), createdAt: row.created_at });
const messageRow = row => ({ id: row.id, scope: row.scope, role: row.role, content: row.content, actor: row.actor, metadata: JSON.parse(row.metadata), createdAt: row.created_at });
const accountRow = row => row ? ({ id: row.id, platform: row.platform, userId: row.user_id, personId: row.person_id, label: row.label, createdAt: row.created_at, updatedAt: row.updated_at }) : null;
const revisionRow = row => ({ id: row.id, memoryId: row.memory_id, snapshot: JSON.parse(row.snapshot), createdAt: row.created_at });
const normalize = value => value.normalize('NFKC').toLowerCase();

export function queryTokens(query) {
  const tokens = new Set();
  for (const match of normalize(query).matchAll(/[a-z0-9_]+|[\p{Script=Han}]+/gu)) {
    const word = match[0];
    if (/^[a-z0-9_]+$/.test(word) || word.length === 1) tokens.add(word);
    else for (let i = 0; i < word.length - 1; i++) tokens.add(word.slice(i, i + 2));
  }
  return [...tokens];
}

export function createStore(dbPath) {
  let db;
  try {
    if (typeof dbPath !== 'string' || !dbPath.trim()) invalid('数据库路径不能为空。');
    if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
    db = new DatabaseSync(dbPath);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, category TEXT NOT NULL,
        scope TEXT NOT NULL, source_type TEXT NOT NULL, source_ref TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS memories_scope_updated ON memories(scope, updated_at);
      CREATE TABLE IF NOT EXISTS revisions (id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, snapshot TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS revisions_memory ON revisions(memory_id, created_at);
      CREATE TABLE IF NOT EXISTS tombstones (memory_id TEXT PRIMARY KEY, deleted_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_blocks (
        scope TEXT NOT NULL, event_id TEXT NOT NULL, blocked_at TEXT NOT NULL, PRIMARY KEY(scope, event_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, scope TEXT NOT NULL, actor TEXT NOT NULL,
        content TEXT NOT NULL, source_ref TEXT NOT NULL, metadata TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_scope_created ON events(scope, created_at);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
        actor TEXT NOT NULL, metadata TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_scope_created ON messages(scope, created_at);
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, platform TEXT NOT NULL, user_id TEXT NOT NULL, person_id TEXT NOT NULL,
        label TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(platform, user_id)
      );
      CREATE TABLE IF NOT EXISTS deliveries (key TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS expressions (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, scope TEXT NOT NULL,
        origin TEXT NOT NULL, mime_type TEXT NOT NULL, data TEXT NOT NULL, hash TEXT NOT NULL,
        byte_length INTEGER NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(origin, hash)
      );
      CREATE TABLE IF NOT EXISTS expression_tombstones (
        origin TEXT NOT NULL, hash TEXT NOT NULL, deleted_at TEXT NOT NULL, PRIMARY KEY(origin, hash)
      );
      CREATE TABLE IF NOT EXISTS books (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, source_ref TEXT NOT NULL, text TEXT NOT NULL,
        current_offset INTEGER NOT NULL, created_at TEXT NOT NULL, last_read_at TEXT, deleted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS book_tombstones (book_id TEXT PRIMARY KEY, deleted_at TEXT NOT NULL);
    `);
  } catch (error) {
    try { db?.close(); } catch {}
    if (error.validation) throw error;
    throw new Error('无法打开本地数据库，请检查目录权限和数据库文件。');
  }

  const get = (sql, ...params) => db.prepare(sql).get(...params);
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const run = (sql, ...params) => db.prepare(sql).run(...params);
  function transaction(action) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }
  function insertMemory(memory) {
    run('INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', memory.id, memory.title, memory.content, memory.category, memory.scope, memory.sourceType, memory.sourceRef, memory.createdAt, memory.updatedAt, memory.deletedAt);
  }
  function insertEvent(event) {
    run('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?)', event.id, event.type, event.scope, event.actor, event.content, event.sourceRef, JSON.stringify(event.metadata), event.createdAt);
  }
  function insertMessage(message) {
    run('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)', message.id, message.scope, message.role, message.content, message.actor, JSON.stringify(message.metadata), message.createdAt);
  }
  function insertAccount(account) {
    run('INSERT INTO accounts VALUES (?, ?, ?, ?, ?, ?, ?)', account.id, account.platform, account.userId, account.personId, account.label, account.createdAt, account.updatedAt);
  }
  function insertRevision(revision) {
    run('INSERT INTO revisions VALUES (?, ?, ?, ?)', revision.id, revision.memoryId, JSON.stringify(revision.snapshot), revision.createdAt);
  }
  function insertExpression(expression) {
    run('INSERT INTO expressions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', expression.id, expression.name,
      expression.description, expression.scope, expression.origin, expression.mimeType, expression.data,
      expression.hash, expression.byteLength, expression.actor, expression.createdAt);
  }
  function insertBook(book) {
    run('INSERT INTO books VALUES (?, ?, ?, ?, ?, ?, ?, ?)', book.id, book.title, book.sourceRef, book.text,
      book.currentOffset, book.createdAt, book.lastReadAt, book.deletedAt);
  }
  function addRevision(memory, now) {
    insertRevision({ id: randomUUID(), memoryId: memory.id, snapshot: memory, createdAt: now });
  }

  function insertConversationBlock(scope, eventId, blockedAt) {
    run(`INSERT INTO conversation_blocks VALUES (?, ?, ?) ON CONFLICT(scope, event_id)
      DO UPDATE SET blocked_at = MAX(conversation_blocks.blocked_at, excluded.blocked_at)`, scope, eventId, blockedAt);
  }
  function blockConversationSource(memory, now) {
    if (memory.sourceType === 'conversation'
      && get("SELECT 1 FROM events WHERE id = ? AND scope = ? AND type = 'message'", memory.sourceRef, memory.scope)) {
      insertConversationBlock(memory.scope, memory.sourceRef, now);
    }
  }
  function backfillConversationBlocks() {
    // Revisions retain previous sources, including moves to another source or scope.
    for (const row of all(`SELECT m.* FROM memories m WHERE m.source_type = 'conversation'
      AND (m.deleted_at IS NOT NULL OR EXISTS (SELECT 1 FROM revisions r WHERE r.memory_id = m.id))`)) {
      blockConversationSource(memoryRow(row), row.deleted_at ?? row.updated_at);
    }
    for (const row of all("SELECT snapshot, created_at FROM revisions WHERE json_extract(snapshot, '$.sourceType') = 'conversation'")) {
      blockConversationSource(JSON.parse(row.snapshot), row.created_at);
    }
  }
  function conversationScopes(scopes) {
    if (!Array.isArray(scopes) || scopes.length > 100) invalid('对话查询须提供最多 100 个明确的可见范围。');
    return [...new Set(scopes.map(scopeValue))];
  }
  function conversationScore(content, tokens, before = '', after = '') {
    const normalized = normalize(content);
    before = normalize(before); after = normalize(after);
    const words = new Set([...(before + normalized + after).matchAll(/[a-z0-9_]+/g)]
      .filter(match => match.index >= before.length && match.index + match[0].length <= before.length + normalized.length)
      .map(match => match[0]));
    return tokens.reduce((sum, token) => sum + Number(/^[a-z0-9_]+$/.test(token) ? words.has(token) : normalized.includes(token)), 0);
  }
  function conversationExcerpt(content, tokens) {
    let bestOffset = 0, bestScore = -1;
    for (let offset = 0; offset < content.length; offset += 600) {
      const score = conversationScore(content.slice(offset, offset + 1200), tokens,
        content.slice(Math.max(0, offset - 1), offset), content.slice(offset + 1200, offset + 1201));
      if (score > bestScore) { bestOffset = offset; bestScore = score; }
    }
    return content.slice(bestOffset, bestOffset + 1200);
  }
  function conversationState(permitted) {
    if (!permitted.length) return { messages: [], turns: [], blockedUsers: new Set(), hiddenAssistants: new Set() };
    const placeholders = permitted.map(() => '?').join(',');
    // Scope filtering precedes content matching on every read.
    const messages = all(`SELECT * FROM messages WHERE scope IN (${placeholders}) ORDER BY created_at DESC, rowid DESC`, ...permitted).map(messageRow);
    const users = new Map(messages.filter(message => message.role === 'user').map(message => [message.id, message]));
    const sources = new Set();
    const events = all(`SELECT * FROM events WHERE type = 'message' AND scope IN (${placeholders})`, ...permitted);
    for (const row of events) {
      const event = eventRow(row);
      const messageId = event.metadata.messageId;
      const user = typeof messageId === 'string' ? users.get(messageId) : null;
      if (user && user.scope === event.scope && user.actor === event.actor && user.content === event.content) sources.add(user.id);
    }
    // Dependency IDs can cross scopes (for example a public source used in a private reply).
    // Only IDs and references cross this boundary; no outside-scope message text enters the result.
    const blockedUsers = new Set(all(`SELECT u.id FROM conversation_blocks b
      JOIN events e ON e.id = b.event_id AND e.scope = b.scope AND e.type = 'message'
      JOIN messages u ON u.role = 'user' AND u.scope = e.scope AND (
        (json_type(e.metadata, '$.messageId') = 'text' AND json_extract(e.metadata, '$.messageId') = u.id)
        OR (json_type(e.metadata, '$.messageId') IS NOT 'text' AND e.actor = u.actor AND e.content = u.content))`).map(row => row.id));
    const blockedMemoryIds = new Set(all('SELECT memory_id FROM tombstones').map(row => row.memory_id));
    for (const row of all(`SELECT m.id FROM memories m JOIN conversation_blocks b ON b.scope = m.scope AND b.event_id = m.source_ref
      WHERE m.source_type = 'conversation'`)) blockedMemoryIds.add(row.id);
    for (const row of all(`SELECT r.memory_id FROM revisions r JOIN conversation_blocks b
      ON b.scope = json_extract(r.snapshot, '$.scope') AND b.event_id = json_extract(r.snapshot, '$.sourceRef')
      WHERE json_extract(r.snapshot, '$.sourceType') = 'conversation'`)) blockedMemoryIds.add(row.memory_id);
    const hiddenAssistants = new Set(), replies = new Map(), dependents = new Map(), replyUsers = new Map();
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      const user = typeof message.metadata.replyTo === 'string' ? users.get(message.metadata.replyTo) : null;
      if (user && user.scope === message.scope && ['live', 'demo'].includes(message.metadata.mode)
        && message.createdAt >= user.createdAt && !replies.has(user.id)) replies.set(user.id, message);
    }
    const dependencies = all(`SELECT a.id, u.id AS user_id,
      CASE WHEN json_type(a.metadata, '$.memoryIds') = 'array' THEN json_extract(a.metadata, '$.memoryIds') ELSE '[]' END AS memory_ids,
      CASE WHEN json_type(a.metadata, '$.conversationIds') = 'array' THEN json_extract(a.metadata, '$.conversationIds') ELSE '[]' END AS conversation_ids,
      CASE WHEN json_type(a.metadata, '$.historyMessageIds') = 'array' THEN json_extract(a.metadata, '$.historyMessageIds') ELSE '[]' END AS history_message_ids
      FROM messages a LEFT JOIN messages u ON u.role = 'user' AND u.scope = a.scope
        AND json_type(a.metadata, '$.replyTo') = 'text' AND u.id = json_extract(a.metadata, '$.replyTo')
      WHERE a.role = 'assistant'`);
    for (const row of dependencies) {
      if (row.user_id) replyUsers.set(row.id, row.user_id);
      if (blockedUsers.has(row.user_id) || JSON.parse(row.memory_ids).some(id => typeof id === 'string' && blockedMemoryIds.has(id))) hiddenAssistants.add(row.id);
      for (const id of [...JSON.parse(row.conversation_ids), ...JSON.parse(row.history_message_ids), ...(row.user_id ? [row.user_id] : [])]) {
        if (typeof id !== 'string') continue;
        if (!dependents.has(id)) dependents.set(id, new Set());
        dependents.get(id).add(row.id);
      }
    }
    // A changed source can propagate through older replies. Keep unrelated user quotes visible.
    const blockedReplies = new Set([...blockedUsers, ...hiddenAssistants]);
    for (const id of hiddenAssistants) if (replyUsers.has(id)) blockedReplies.add(replyUsers.get(id));
    const queue = [...blockedReplies];
    for (let index = 0; index < queue.length; index++) {
      for (const id of dependents.get(queue[index]) ?? []) {
        hiddenAssistants.add(id);
        if (!blockedReplies.has(id)) { blockedReplies.add(id); queue.push(id); }
        const userId = replyUsers.get(id);
        if (userId && !blockedReplies.has(userId)) { blockedReplies.add(userId); queue.push(userId); }
      }
    }
    for (const [id, userId] of replyUsers) if (blockedReplies.has(userId)) hiddenAssistants.add(id);
    const turns = [];
    for (const user of users.values()) {
      const reply = replies.get(user.id);
      if (!sources.has(user.id) || blockedUsers.has(user.id) || !reply) continue;
      const assistantHidden = hiddenAssistants.has(reply.id);
      turns.push({ id: user.id, scope: user.scope, actor: user.actor, createdAt: user.createdAt, user: user.content,
        assistant: assistantHidden ? '' : reply.content, replyAt: reply.createdAt, assistantHidden });
    }
    return { messages, turns, blockedUsers, hiddenAssistants };
  }

  try { transaction(backfillConversationBlocks); }
  catch { db.close(); throw new Error('无法整理本地对话索引，请检查数据库文件。'); }

  const api = {
    getSetting(key, fallback = null) {
      const row = get('SELECT value FROM settings WHERE key = ?', identifier(key, '设置名'));
      return row ? JSON.parse(row.value) : fallback;
    },
    setSetting(key, value) {
      key = identifier(key, '设置名');
      const clean = jsonValue(value, '设置', 50000);
      run('INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(clean));
      return clean;
    },
    listMemories(options = {}) {
      record(options, '记忆筛选参数');
      let { q = '', scope = '', includeDeleted = false } = options;
      q = normalize(text(q, '搜索词', 500, { empty: true }));
      if (typeof includeDeleted !== 'boolean') invalid('是否包含已删除记忆须为布尔值。');
      if (scope !== '') scope = scopeValue(scope);
      const conditions = [];
      const params = [];
      if (!includeDeleted) conditions.push('deleted_at IS NULL');
      if (scope) { conditions.push('scope = ?'); params.push(scope); }
      const rows = all(`SELECT * FROM memories ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY updated_at DESC, rowid DESC`, ...params).map(memoryRow);
      return q ? rows.filter(memory => normalize(`${memory.title}\n${memory.content}\n${memory.category}\n${memory.sourceRef}`).includes(q)) : rows;
    },
    getMemory(id) {
      return memoryRow(get('SELECT * FROM memories WHERE id = ?', identifier(id, '记忆 ID')));
    },
    getMemorySource(id, scopes) {
      id = identifier(id, '记忆 ID');
      if (!Array.isArray(scopes) || scopes.length > 100) invalid('来源查询须提供最多 100 个明确的可见范围。');
      const permitted = [...new Set(scopes.map(scopeValue))];
      if (!permitted.length) return null;
      const source = get(`SELECT e.id AS eventId, e.actor, e.created_at AS createdAt, e.content
        FROM memories m JOIN events e ON e.id = m.source_ref AND e.scope = m.scope
        WHERE m.id = ? AND m.deleted_at IS NULL AND m.source_type = 'conversation' AND e.type = 'message'
          AND m.scope IN (${permitted.map(() => '?').join(',')})`, id, ...permitted);
      return source ? { ...source } : null;
    },
    saveMemory(input, { auditEvent } = {}) {
      const fields = memoryFields(input);
      const id = input.id === undefined ? randomUUID() : identifier(input.id, '记忆 ID');
      const now = new Date().toISOString();
      const audit = auditEvent === undefined ? null : { id: randomUUID(), ...eventFields(auditEvent), createdAt: now };
      return transaction(() => {
        const previous = memoryRow(get('SELECT * FROM memories WHERE id = ?', id));
        if (input.id !== undefined && !previous) invalid('要修改的记忆不存在。');
        if (previous?.deletedAt || get('SELECT 1 FROM tombstones WHERE memory_id = ?', id)) invalid('已删除的记忆不能直接恢复，请另建一条记忆。');
        const memory = { id, ...fields, createdAt: previous?.createdAt ?? now, updatedAt: now, deletedAt: null };
        if (previous) {
          addRevision(previous, now);
          blockConversationSource(previous, now);
          blockConversationSource(memory, now);
          run('UPDATE memories SET title = ?, content = ?, category = ?, scope = ?, source_type = ?, source_ref = ?, updated_at = ? WHERE id = ?', memory.title, memory.content, memory.category, memory.scope, memory.sourceType, memory.sourceRef, memory.updatedAt, id);
        } else insertMemory(memory);
        if (audit) insertEvent(audit);
        return memory;
      });
    },
    hasReadUrl(url, scope = 'owner') {
      const source = text(url, '网页地址', LIMITS.sourceRef);
      const visible = scopeValue(scope);
      // Reading events survive shelf edits/deletion, so autonomous browsing will not re-add deleted articles.
      return Boolean(get("SELECT 1 FROM events WHERE type = 'reading' AND scope = ? AND source_ref = ? LIMIT 1", visible, source));
    },
    recordReading({ page, scope, actor = 'owner' }) {
      record(page, '网页');
      const title = text(page.title, '网页标题', 500);
      const suppliedParts = page.parts !== undefined;
      if (suppliedParts && (!Array.isArray(page.parts) || !page.parts.length || page.parts.length > 50
        || page.text !== page.parts[0])) invalid('分段阅读须提供 1–50 段正文，且首段须与网页正文一致。');
      const contents = (suppliedParts ? page.parts : [page.text]).map(part => text(part, '阅读正文', LIMITS.memory));
      if (suppliedParts && page.parts.reduce((sum, part) => sum + part.length, 0) > 1000000) invalid('分段阅读正文合计不能超过 1000000 字。');
      const multipart = contents.length > 1;
      const evidence = page.evidence === undefined ? undefined : metadataValue(page.evidence);
      const readAt = timestamp(page.readAt, '阅读时间');
      const now = new Date().toISOString();
      const sections = contents.map((content, index) => {
        const suffix = contents.length > 1 ? ` · 文字 ${index + 1}/${contents.length}` : '';
        const fields = memoryFields({ title: title.slice(0, 150 - suffix.length) + suffix, content,
          category: 'reading', scope, sourceType: 'webpage', sourceRef: text(page.url, '网页地址', LIMITS.sourceRef) });
        const event = { id: randomUUID(), ...eventFields({ type: 'reading', scope: fields.scope, actor,
          content: fields.content, sourceRef: fields.sourceRef,
          metadata: { title: page.title, readAt, truncated: Boolean(page.truncated),
            ...(evidence === undefined ? {} : { evidence }),
            ...(multipart ? { partIndex: index + 1, partCount: contents.length } : {}) } }), createdAt: now };
        return { fields, event };
      });
      return transaction(() => {
        const readings = sections.map(({ fields, event }) => {
          const existing = memoryRow(get(`SELECT * FROM memories WHERE deleted_at IS NULL AND scope = ?
            AND source_type = 'webpage' AND category = 'reading' AND source_ref = ? AND title = ? AND content = ?
            ORDER BY updated_at DESC, rowid DESC LIMIT 1`, fields.scope, fields.sourceRef, fields.title, fields.content));
          const memory = existing || { id: randomUUID(), ...fields, createdAt: now, updatedAt: now, deletedAt: null };
          return { memory, event, reusedMemory: Boolean(existing) };
        });
        const memoryParts = multipart ? readings.map(({ memory }, index) => ({ id: memory.id, title: memory.title, partIndex: index + 1 })) : undefined;
        for (const [index, reading] of readings.entries()) {
          reading.event.metadata = metadataValue({ ...reading.event.metadata, memoryId: reading.memory.id,
            reusedMemory: reading.reusedMemory, ...(multipart ? { readingGroupId: readings[0].event.id } : {}),
            ...(multipart && index === 0 ? { memoryParts } : {}) });
        }
        for (const { memory, event, reusedMemory } of readings) {
          if (!reusedMemory) insertMemory(memory);
          insertEvent(event);
        }
        const first = readings[0];
        return { memory: first.memory, eventId: first.event.id, reusedMemory: first.reusedMemory, ...(multipart ? { memoryParts } : {}) };
      });
    },
    getReadingParts(id, scopes) {
      id = identifier(id, '记忆 ID');
      if (!Array.isArray(scopes) || scopes.length > 100) invalid('阅读分段索引须提供最多 100 个明确的可见范围。');
      const permitted = [...new Set(scopes.map(scopeValue))];
      if (!permitted.length) return [];
      const memory = memoryRow(get(`SELECT * FROM memories WHERE id = ? AND deleted_at IS NULL
        AND source_type = 'webpage' AND category = 'reading' AND scope IN (${permitted.map(() => '?').join(',')})`, id, ...permitted));
      if (!memory) return [];
      const origin = get(`SELECT * FROM events WHERE type = 'reading' AND scope = ? AND source_ref = ? AND content = ?
        AND json_extract(metadata, '$.memoryId') = ? AND json_type(metadata, '$.readingGroupId') = 'text'
        ORDER BY created_at DESC, rowid DESC LIMIT 1`, memory.scope, memory.sourceRef, memory.content, id);
      if (!origin) return [];
      const groupId = eventRow(origin).metadata.readingGroupId;
      const first = get("SELECT * FROM events WHERE id = ? AND type = 'reading' AND scope = ? AND source_ref = ?", groupId, memory.scope, memory.sourceRef);
      if (!first) return [];
      const metadata = eventRow(first).metadata;
      const originMetadata = eventRow(origin).metadata;
      const parts = metadata.memoryParts;
      if (metadata.readingGroupId !== groupId || !Array.isArray(parts) || parts.length < 2 || parts.length > 50
        || parts.some((part, index) => !part || typeof part !== 'object' || Array.isArray(part)
          || typeof part.id !== 'string' || part.partIndex !== index + 1)
        || new Set(parts.map(part => part.id)).size !== parts.length
        || metadata.memoryId !== parts[0].id || metadata.partIndex !== 1 || metadata.partCount !== parts.length
        || originMetadata.partCount !== parts.length
        || !parts.some(part => part.id === id && part.partIndex === originMetadata.partIndex)) return [];
      return parts.flatMap(part => {
        const current = memoryRow(get(`SELECT * FROM memories WHERE id = ? AND deleted_at IS NULL AND scope = ?
          AND source_type = 'webpage' AND category = 'reading' AND source_ref = ?`, part.id, memory.scope, memory.sourceRef));
        if (!current) return [];
        const matching = get(`SELECT 1 FROM events WHERE type = 'reading' AND scope = ? AND source_ref = ? AND content = ?
          AND json_extract(metadata, '$.memoryId') = ? AND json_extract(metadata, '$.readingGroupId') = ?
          AND json_extract(metadata, '$.partIndex') = ? AND json_extract(metadata, '$.partCount') = ? LIMIT 1`,
        current.scope, current.sourceRef, current.content, current.id, groupId, part.partIndex, parts.length);
        return matching ? [{ id: current.id, title: current.title, partIndex: part.partIndex }] : [];
      });
    },
    recordReadingReflection({ readingEventId, note }) {
      readingEventId = identifier(readingEventId, '阅读经历 ID');
      note = text(note, '读后思考', 2000);
      return transaction(() => {
        const row = get("SELECT * FROM events WHERE id = ? AND type = 'reading' AND actor = 'scheduler'", readingEventId);
        const reading = row && eventRow(row);
        const original = typeof reading?.metadata?.memoryId === 'string' && memoryRow(get('SELECT * FROM memories WHERE id = ?', reading.metadata.memoryId));
        if (!original || original.deletedAt || original.scope !== reading.scope || original.sourceType !== 'webpage'
          || original.category !== 'reading' || original.sourceRef !== reading.sourceRef || original.content !== reading.content) invalid('原阅读记录已改变，未保存读后思考。');
        if (get("SELECT 1 FROM events WHERE type = 'reading_reflection' AND json_extract(metadata, '$.readingEventId') = ?", readingEventId)) invalid('该次阅读已有思考记录，不重复生成。');
        const now = new Date().toISOString();
        const memory = { id: randomUUID(), ...memoryFields({ title: `读后思考 · ${original.title}`.slice(0, 200), content: note,
          category: 'reading-note', scope: original.scope, sourceType: 'reflection', sourceRef: original.sourceRef }), createdAt: now, updatedAt: now, deletedAt: null };
        const event = { id: randomUUID(), ...eventFields({ type: 'reading_reflection', scope: memory.scope, actor: 'scheduler',
          content: note, sourceRef: memory.sourceRef, metadata: { title: memory.title, memoryId: memory.id, readingMemoryId: original.id, readingEventId } }), createdAt: now };
        insertMemory(memory); insertEvent(event);
        return { memory, eventId: event.id };
      });
    },
    listReadingReflections(scopes, limit = 3) {
      if (!Array.isArray(scopes) || scopes.length > 100) invalid('思考索引须提供明确的可见范围。');
      const permitted = [...new Set(scopes.map(scopeValue))];
      limit = integer(limit, '思考条数', 1, 10);
      if (!permitted.length) return [];
      return all(`SELECT m.id AS memoryId, m.title, e.content AS note, e.source_ref AS sourceRef, e.created_at AS createdAt
        FROM events e JOIN memories m ON m.id = json_extract(e.metadata, '$.memoryId')
        JOIN events r ON r.id = json_extract(e.metadata, '$.readingEventId')
        JOIN memories original ON original.id = json_extract(e.metadata, '$.readingMemoryId')
        WHERE e.type = 'reading_reflection' AND e.actor = 'scheduler' AND r.type = 'reading' AND r.actor = 'scheduler'
          AND e.scope IN (${permitted.map(() => '?').join(',')}) AND m.scope = e.scope AND r.scope = e.scope AND original.scope = e.scope
          AND m.deleted_at IS NULL AND original.deleted_at IS NULL AND m.source_type = 'reflection' AND m.category = 'reading-note'
          AND m.source_ref = e.source_ref AND r.source_ref = e.source_ref AND original.source_ref = e.source_ref
          AND m.content = e.content AND original.content = r.content AND original.id = json_extract(r.metadata, '$.memoryId')
          AND m.updated_at = m.created_at AND original.updated_at = original.created_at
          AND NOT EXISTS (SELECT 1 FROM revisions revision WHERE revision.memory_id IN (m.id, original.id))
        ORDER BY e.created_at DESC, e.rowid DESC LIMIT ?`, ...permitted, limit);
    },
    deleteMemory(id, { auditEvent } = {}) {
      id = identifier(id, '记忆 ID');
      const audit = auditEvent === undefined ? null : { id: randomUUID(), ...eventFields(auditEvent), createdAt: new Date().toISOString() };
      return transaction(() => {
        const previous = memoryRow(get('SELECT * FROM memories WHERE id = ?', id));
        if (!previous || previous.deletedAt) return false;
        const now = new Date().toISOString();
        addRevision(previous, now);
        blockConversationSource(previous, now);
        run('UPDATE memories SET deleted_at = ?, updated_at = ? WHERE id = ?', now, now, id);
        run('INSERT INTO tombstones VALUES (?, ?) ON CONFLICT(memory_id) DO UPDATE SET deleted_at = excluded.deleted_at', id, now);
        if (audit) insertEvent(audit);
        return true;
      });
    },
    listRecentReadings(scopes, limit = 3) {
      if (!Array.isArray(scopes) || scopes.length > 100) invalid('阅读索引须提供最多 100 个明确的可见范围。');
      const permitted = [...new Set(scopes.map(scopeValue))];
      limit = integer(limit, '索引条数', 1, 100);
      if (!permitted.length) return [];
      // An index requires a successful reading event and its still-visible shelf entry.
      return all(`WITH readings AS (
        SELECT m.id AS memoryId, m.title, m.scope, e.type, e.created_at AS readAt, e.rowid AS sequence,
          ROW_NUMBER() OVER (PARTITION BY m.id ORDER BY e.created_at DESC, e.rowid DESC) AS occurrence
        FROM events e JOIN memories m ON m.id = json_extract(e.metadata, '$.memoryId')
        WHERE json_type(e.metadata, '$.memoryId') = 'text'
          AND e.scope IN (${permitted.map(() => '?').join(',')}) AND m.scope = e.scope
          AND m.deleted_at IS NULL AND m.source_ref = e.source_ref
          AND ((e.type = 'reading' AND m.source_type = 'webpage' AND m.category = 'reading')
            OR (e.type = 'book_reading' AND m.source_type = 'book' AND m.category = 'book-note')
            OR (e.type = 'reading_reflection' AND m.source_type = 'reflection' AND m.category = 'reading-note'))
      ) SELECT memoryId, title, scope, type, readAt FROM readings WHERE occurrence = 1
        ORDER BY readAt DESC, sequence DESC LIMIT ?`, ...permitted, limit)
        .map(item => ({ ...item, title: item.title.slice(0, 120) }));
    },
    searchMemories(query, scopes, limit = 6) {
      return api.searchMemoryPage(query, scopes, limit).items;
    },
    searchMemoryPage(query, scopes, limit = 6, offset = 0) {
      query = text(query, '记忆查询', 8000, { empty: true });
      if (!Array.isArray(scopes) || scopes.length > 100) invalid('记忆查询须提供最多 100 个明确的可见范围。');
      const permitted = [...new Set(scopes.map(scopeValue))];
      limit = integer(limit, '检索条数', 1, 100);
      offset = integer(offset, '检索位置', 0, Number.MAX_SAFE_INTEGER);
      if (!permitted.length) return { items: [], total: 0, offset, nextOffset: null };
      // Filter scopes in SQL before matching, so inaccessible content never enters scoring.
      const rows = all(`SELECT * FROM memories WHERE deleted_at IS NULL AND scope IN (${permitted.map(() => '?').join(',')}) ORDER BY updated_at DESC, rowid DESC`, ...permitted).map(memoryRow);
      let matches = rows;
      if (query) {
        const tokens = queryTokens(query);
        matches = tokens.length ? rows.map(memory => {
          const title = normalize(memory.title);
          const content = normalize(memory.content);
          const titleWords = new Set(title.match(/[a-z0-9_]+/g) ?? []);
          const contentWords = new Set(content.match(/[a-z0-9_]+/g) ?? []);
          const score = tokens.reduce((sum, token) => {
            const ascii = /^[a-z0-9_]+$/.test(token);
            return sum + ((ascii ? titleWords.has(token) : title.includes(token)) ? 4 : 0)
              + ((ascii ? contentWords.has(token) : content.includes(token)) ? 1 : 0);
          }, 0);
          return { memory, score };
        }).filter(item => item.score > 0).sort((a, b) => b.score - a.score).map(item => item.memory) : [];
      }
      const total = matches.length;
      const items = offset < total ? matches.slice(offset, offset + limit) : [];
      return { items, total, offset, nextOffset: offset + items.length < total ? offset + items.length : null };
    },
    listRevisions(id) {
      return all('SELECT * FROM revisions WHERE memory_id = ? ORDER BY created_at DESC, rowid DESC', identifier(id, '记忆 ID')).map(revisionRow);
    },
    addEvent(input) {
      const event = { id: randomUUID(), ...eventFields(input), createdAt: new Date().toISOString() };
      insertEvent(event);
      return event;
    },
    listEvents(options = {}) {
      record(options, '经历筛选参数');
      if (Object.keys(options).some(key => !['limit', 'scope', 'type', 'actor', 'readingHeadsOnly'].includes(key))) invalid('经历筛选包含未知字段。');
      let { limit = 50, scope, type, actor, readingHeadsOnly = false } = options;
      limit = integer(limit, '经历条数', 1, 1000);
      if (type !== undefined) type = text(type, '经历类型', 40);
      if (actor !== undefined) actor = text(actor, '参与者', 160);
      if (typeof readingHeadsOnly !== 'boolean' || (readingHeadsOnly && type !== 'reading')) invalid('阅读首段筛选须为布尔值，启用时经历类型须为reading。');
      const conditions = [], parameters = [];
      if (scope !== undefined) { conditions.push('scope = ?'); parameters.push(scopeValue(scope)); }
      if (type !== undefined) { conditions.push('type = ?'); parameters.push(type); }
      if (actor !== undefined) { conditions.push('actor = ?'); parameters.push(actor); }
      if (readingHeadsOnly) conditions.push("(json_type(metadata, '$.partIndex') IS NULL OR (json_type(metadata, '$.partIndex') IN ('integer', 'real') AND json_extract(metadata, '$.partIndex') = 1))");
      return all(`SELECT * FROM events${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY created_at DESC, rowid DESC LIMIT ?`, ...parameters, limit).map(eventRow);
    },
    addMessage(input) {
      const message = { id: randomUUID(), ...messageFields(input), createdAt: new Date().toISOString() };
      insertMessage(message);
      return message;
    },
    listMessages(scope, limit = 40) {
      scope = scopeValue(scope);
      limit = integer(limit, '消息条数', 1, 1000);
      return all('SELECT * FROM messages WHERE scope = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', scope, limit).reverse().map(messageRow);
    },
    searchConversationPage(query, scopes, limit = 6, offset = 0, excludeMessageId = '') {
      query = text(query, '对话查询', 8000, { empty: true });
      const permitted = conversationScopes(scopes);
      limit = integer(limit, '检索条数', 1, 100);
      offset = integer(offset, '检索位置', 0, Number.MAX_SAFE_INTEGER);
      if (excludeMessageId !== '') excludeMessageId = identifier(excludeMessageId, '当前消息 ID');
      const tokens = queryTokens(query);
      let matches = conversationState(permitted).turns.filter(turn => turn.id !== excludeMessageId);
      if (query) matches = tokens.length ? matches.map(turn => ({ turn,
        score: conversationScore(turn.user, tokens) + conversationScore(turn.assistant, tokens) }))
        .filter(item => item.score > 0).sort((a, b) => b.score - a.score).map(item => item.turn) : [];
      const total = matches.length;
      const items = offset < total ? matches.slice(offset, offset + limit).map(turn => ({ ...turn,
        user: conversationExcerpt(turn.user, tokens), assistant: conversationExcerpt(turn.assistant, tokens),
        userTruncated: turn.user.length > 1200, assistantTruncated: turn.assistant.length > 1200 })) : [];
      return { items, total, offset, nextOffset: offset + items.length < total ? offset + items.length : null };
    },
    getConversation(id, scopes, excludeMessageId = '') {
      id = identifier(id, '对话 ID');
      const permitted = conversationScopes(scopes);
      if (excludeMessageId !== '') excludeMessageId = identifier(excludeMessageId, '当前消息 ID');
      if (id === excludeMessageId) return null;
      return conversationState(permitted).turns.find(turn => turn.id === id) ?? null;
    },
    listConversationHistory(scope, limit = 16) {
      scope = scopeValue(scope);
      limit = integer(limit, '消息条数', 1, 1000);
      const state = conversationState([scope]);
      return state.messages.filter(message => message.scope === scope && (message.role === 'user'
        ? !state.blockedUsers.has(message.id) : !state.hiddenAssistants.has(message.id))).slice(0, limit).reverse();
    },
    listAccounts() {
      return all('SELECT * FROM accounts ORDER BY updated_at DESC, rowid DESC').map(accountRow);
    },
    bindAccount(input) {
      const fields = accountFields(input);
      const previous = accountRow(get('SELECT * FROM accounts WHERE platform = ? AND user_id = ?', fields.platform, fields.userId));
      const now = new Date().toISOString();
      const account = { id: previous?.id ?? randomUUID(), ...fields, createdAt: previous?.createdAt ?? now, updatedAt: now };
      if (previous) run('UPDATE accounts SET person_id = ?, label = ?, updated_at = ? WHERE id = ?', account.personId, account.label, now, previous.id);
      else insertAccount(account);
      return account;
    },
    removeAccount(id) {
      return run('DELETE FROM accounts WHERE id = ?', identifier(id, '账号绑定 ID')).changes > 0;
    },
    findAccount(platform, userId) {
      const fields = accountFields({ platform, userId });
      return accountRow(get('SELECT * FROM accounts WHERE platform = ? AND user_id = ?', fields.platform, fields.userId));
    },
    claimDelivery(key) {
      key = text(key, '消息去重标识', 256);
      return run('INSERT INTO deliveries VALUES (?, ?) ON CONFLICT(key) DO NOTHING', key, new Date().toISOString()).changes > 0;
    },
    hasDelivery(key) {
      return Boolean(get('SELECT 1 FROM deliveries WHERE key = ?', text(key, '消息去重标识', 256)));
    },
    hasProactiveAttempt(sourceKey) {
      return Boolean(get("SELECT 1 FROM events WHERE type = 'proactive' AND scope = 'owner' AND actor = 'scheduler' AND source_ref = ? AND json_extract(metadata, '$.outcome') = 'attempt' LIMIT 1", text(sourceKey, '阅读来源标识', 256)));
    },
    saveExpression(input) {
      const fields = expressionFields(input);
      if (input.id !== undefined) invalid('已有表情不能修改来源或可见范围；管理员上传须另建一张表情。');
      return transaction(() => {
        if (get('SELECT 1 FROM expression_tombstones WHERE origin = ? AND hash = ?', fields.origin, fields.hash)) {
          invalid('这张表情已在该会话删除，不会自动重新收藏。');
        }
        const previous = get('SELECT * FROM expressions WHERE origin = ? AND hash = ?', fields.origin, fields.hash);
        if (previous) return expressionRow(previous);
        expressionCapacity([...all('SELECT origin, byte_length AS byteLength FROM expressions'), fields]);
        const expression = { id: randomUUID(), ...fields, createdAt: new Date().toISOString() };
        insertExpression(expression);
        return expressionRow(get('SELECT * FROM expressions WHERE id = ?', expression.id));
      });
    },
    listExpressions(origin) {
      return (origin === undefined
        ? all('SELECT * FROM expressions ORDER BY created_at DESC, rowid DESC')
        : all('SELECT * FROM expressions WHERE origin = ? ORDER BY created_at DESC, rowid DESC', expressionOrigin(origin))).map(expressionRow);
    },
    getExpression(id, origin) {
      return expressionImageRow(get('SELECT * FROM expressions WHERE id = ? AND origin = ?', expressionId(id), expressionOrigin(origin)));
    },
    getExpressionForAdmin(id) {
      return expressionImageRow(get('SELECT * FROM expressions WHERE id = ?', expressionId(id)));
    },
    deleteExpression(id) {
      id = expressionId(id);
      return transaction(() => {
        const previous = get('SELECT origin, hash FROM expressions WHERE id = ?', id);
        if (!previous) return false;
        run('INSERT INTO expression_tombstones VALUES (?, ?, ?) ON CONFLICT(origin, hash) DO UPDATE SET deleted_at = excluded.deleted_at',
          previous.origin, previous.hash, new Date().toISOString());
        run('DELETE FROM expressions WHERE id = ?', id);
        return true;
      });
    },
    addBook(input, { deliveryKey } = {}) {
      const fields = bookFields(input);
      if (input.id !== undefined) invalid('导入新书不能指定已有书籍 ID。');
      return transaction(() => {
        if (deliveryKey && !api.claimDelivery(deliveryKey)) return null;
        bookCapacity([...all('SELECT * FROM books WHERE deleted_at IS NULL').map(bookRow), fields]);
        const book = { id: randomUUID(), ...fields, currentOffset: 0, createdAt: new Date().toISOString(), lastReadAt: null, deletedAt: null };
        insertBook(book);
        return bookMetadata(book);
      });
    },
    listBooks() {
      return all('SELECT * FROM books WHERE deleted_at IS NULL ORDER BY created_at, rowid').map(bookRow).map(bookMetadata);
    },
    getBook(id) {
      return bookRow(get('SELECT * FROM books WHERE id = ? AND deleted_at IS NULL', bookId(id)));
    },
    listBookReadingNotes(id, beforeOffset) {
      id = bookId(id);
      beforeOffset = integer(beforeOffset, '既往读书位置', 0, BOOK_LIMITS.chars);
      const book = get('SELECT current_offset FROM books WHERE id = ? AND deleted_at IS NULL', id);
      if (!book) invalid('书籍不存在或已经删除。');
      if (beforeOffset > book.current_offset) invalid('既往读书位置不能超过当前阅读进度。');
      const rows = all(`SELECT m.id AS memoryId, m.source_ref AS sourceRef, m.content AS note,
          m.created_at AS createdAt, e.metadata
        FROM events e JOIN memories m ON m.id = json_extract(e.metadata, '$.memoryId')
        WHERE e.type = 'book_reading' AND e.scope = 'owner' AND e.actor = 'scheduler'
          AND json_type(e.metadata, '$.memoryId') = 'text' AND json_type(e.metadata, '$.bookId') = 'text'
          AND json_extract(e.metadata, '$.bookId') = ? AND m.scope = 'owner' AND m.deleted_at IS NULL
          AND m.source_type = 'book' AND m.category = 'book-note' AND m.source_ref = e.source_ref
          AND m.created_at = e.created_at AND m.updated_at = m.created_at
          AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.memory_id = m.id)
        ORDER BY e.created_at DESC, e.rowid DESC`, id);
      const notes = new Map();
      for (const row of rows) {
        const { startOffset, endOffset } = JSON.parse(row.metadata);
        if (!Number.isSafeInteger(startOffset) || !Number.isSafeInteger(endOffset)
          || startOffset < 0 || startOffset >= endOffset || endOffset > beforeOffset
          || row.sourceRef !== `book:${id}:${startOffset}-${endOffset}`
          || !row.note.trim() || row.note.length > 4000) continue;
        notes.set(row.memoryId, { memoryId: row.memoryId, sourceRef: row.sourceRef, startOffset, endOffset,
          createdAt: row.createdAt, note: row.note.slice(0, 1000), truncated: row.note.length > 1000 });
      }
      return [...notes.values()].sort((a, b) => b.endOffset - a.endOffset).slice(0, 3);
    },
    deleteBook(id) {
      id = bookId(id);
      return transaction(() => {
        const previous = get('SELECT * FROM books WHERE id = ? AND deleted_at IS NULL', id);
        if (!previous) return false;
        const now = new Date().toISOString();
        run("UPDATE books SET deleted_at = ?, text = '' WHERE id = ?", now, id);
        run('INSERT INTO book_tombstones VALUES (?, ?) ON CONFLICT(book_id) DO UPDATE SET deleted_at = excluded.deleted_at', id, now);
        return true;
      });
    },
    recordBookReading(input) {
      record(input, '读书记录');
      const id = bookId(input.bookId), note = text(input.note, '读书笔记', 4000);
      const startOffset = integer(input.startOffset, '阅读起点', 0, BOOK_LIMITS.chars);
      const endOffset = integer(input.endOffset, '阅读终点', startOffset + 1, BOOK_LIMITS.chars);
      return transaction(() => {
        const book = bookRow(get('SELECT * FROM books WHERE id = ? AND deleted_at IS NULL', id));
        if (!book) invalid('书籍不存在或已经删除。');
        if (book.currentOffset !== startOffset || endOffset > book.text.length) invalid('阅读位置已变化或超出书籍正文，请重新读取当前进度。');
        const sourceRef = `book:${id}:${startOffset}-${endOffset}`;
        if (get("SELECT 1 FROM events WHERE type = 'book_reading' AND source_ref = ? LIMIT 1", sourceRef)) invalid('该书籍片段已有阅读记录，不能重复保存。');
        const now = new Date().toISOString();
        const memory = { id: randomUUID(), ...memoryFields({ title: `${book.title.slice(0, 150)} · ${startOffset + 1}–${endOffset}`,
          content: note, category: 'book-note', scope: 'owner', sourceType: 'book', sourceRef }), createdAt: now, updatedAt: now, deletedAt: null };
        const event = { id: randomUUID(), ...eventFields({ type: 'book_reading', scope: 'owner', actor: 'scheduler', sourceRef,
          content: `阅读《${book.title}》第 ${startOffset + 1}–${endOffset} 字，并保存读书笔记。`,
          metadata: { bookId: id, title: book.title, startOffset, endOffset, totalChars: book.text.length, memoryId: memory.id } }), createdAt: now };
        insertMemory(memory); insertEvent(event);
        run('UPDATE books SET current_offset = ?, last_read_at = ? WHERE id = ?', endOffset, now, id);
        return { book: bookMetadata({ ...book, currentOffset: endOffset, lastReadAt: now }), memory, eventId: event.id };
      });
    },
    stats() {
      return {
        memories: get('SELECT COUNT(*) AS count FROM memories WHERE deleted_at IS NULL').count,
        events: get('SELECT COUNT(*) AS count FROM events').count,
        messages: get('SELECT COUNT(*) AS count FROM messages').count,
        accounts: get('SELECT COUNT(*) AS count FROM accounts').count,
      };
    },
    exportData() {
      return {
        schemaVersion: 4, exportedAt: new Date().toISOString(),
        persona: personaValue(api.getSetting('persona', null)),
        moodState: normalizeMoodState(api.getSetting('moodState', null)),
        memories: all('SELECT * FROM memories ORDER BY rowid').map(memoryRow),
        revisions: all('SELECT * FROM revisions ORDER BY rowid').map(revisionRow),
        events: all('SELECT * FROM events ORDER BY rowid').map(eventRow),
        messages: all('SELECT * FROM messages ORDER BY rowid').map(messageRow),
        accounts: all('SELECT * FROM accounts ORDER BY rowid').map(accountRow),
        tombstones: all('SELECT * FROM tombstones ORDER BY rowid').map(row => ({ memoryId: row.memory_id, deletedAt: row.deleted_at })),
        conversationBlocks: all('SELECT * FROM conversation_blocks ORDER BY rowid').map(row => ({ scope: row.scope, eventId: row.event_id, blockedAt: row.blocked_at })),
        expressions: all('SELECT * FROM expressions ORDER BY rowid').map(row => ({ ...expressionRow(row), data: row.data,
          hash: row.hash, byteLength: row.byte_length, actor: row.actor })),
        expressionTombstones: all('SELECT * FROM expression_tombstones ORDER BY rowid').map(row => ({ origin: row.origin, hash: row.hash, deletedAt: row.deleted_at })),
        books: all('SELECT * FROM books WHERE deleted_at IS NULL ORDER BY rowid').map(bookRow),
        bookTombstones: all('SELECT * FROM book_tombstones ORDER BY rowid').map(row => ({ bookId: row.book_id, deletedAt: row.deleted_at })),
      };
    },
    importData(payload) {
      record(payload, '备份');
      if (![1, 2, 3, 4].includes(payload.schemaVersion)) invalid('不支持此备份版本。');
      if (payload.schemaVersion >= 2 && (!Array.isArray(payload.expressions) || !Array.isArray(payload.expressionTombstones))) {
        invalid('版本 2–4 备份必须包含表情及表情删除记录数组。');
      }
      if (payload.schemaVersion >= 3 && !Array.isArray(payload.books)) invalid('版本 3–4 备份必须包含书籍数组。');
      if (payload.schemaVersion === 4 && !Array.isArray(payload.conversationBlocks)) invalid('版本 4 备份必须包含对话屏蔽记录数组。');
      timestamp(payload.exportedAt, '备份时间');
      const persona = personaValue(payload.persona);
      const moodState = normalizeMoodState(Object.hasOwn(payload, 'moodState') ? payload.moodState : null);
      let total = 0;
      function rows(name, check, key = clean => clean.id ?? clean.memoryId) {
        if (!Array.isArray(payload[name]) || payload[name].length > 100000) invalid(`备份中的 ${name} 须为最多 100000 项的数组。`);
        total += payload[name].length;
        if (total > 250000) invalid('备份记录总数超过 250000 项。');
        const ids = new Set();
        return payload[name].map(item => {
          record(item, `备份 ${name} 记录`);
          const clean = check(item);
          const id = key(clean);
          if (ids.has(id)) invalid(`备份中的 ${name} 存在重复标识。`);
          ids.add(id);
          return clean;
        });
      }
      function dated(item, fields, updated = false) {
        const clean = { id: identifier(item.id), ...fields, createdAt: timestamp(item.createdAt, '创建时间') };
        if (updated) {
          clean.updatedAt = timestamp(item.updatedAt, '更新时间');
          if (clean.updatedAt < clean.createdAt) invalid('更新时间不能早于创建时间。');
        }
        return clean;
      }
      function requireFields(item, names) {
        for (const name of names) if (!Object.hasOwn(item, name)) invalid(`备份记录缺少 ${name} 字段。`);
      }
      function importedMemory(item) {
        requireFields(item, ['title', 'content', 'category', 'scope', 'sourceType', 'sourceRef', 'deletedAt']);
        const clean = dated(item, memoryFields(item), true);
        clean.deletedAt = item.deletedAt === null ? null : timestamp(item.deletedAt, '删除时间');
        if (clean.deletedAt && clean.deletedAt < clean.createdAt) invalid('删除时间不能早于创建时间。');
        return clean;
      }
      const memories = rows('memories', importedMemory);
      const memoryIds = new Set(memories.map(memory => memory.id));
      const revisions = rows('revisions', item => {
        const memoryId = identifier(item.memoryId, '修订的记忆 ID');
        if (!memoryIds.has(memoryId)) invalid('备份修订引用了不存在的记忆。');
        record(item.snapshot, '记忆修订快照');
        const snapshot = importedMemory(item.snapshot);
        if (snapshot.id !== memoryId) invalid('记忆修订快照与记忆 ID 不一致。');
        return dated(item, { memoryId, snapshot });
      });
      const events = rows('events', item => {
        requireFields(item, ['type', 'scope', 'actor', 'content', 'sourceRef', 'metadata']);
        return dated(item, eventFields(item));
      });
      const messages = rows('messages', item => {
        requireFields(item, ['scope', 'role', 'content', 'actor', 'metadata']);
        return dated(item, messageFields(item));
      });
      const accounts = rows('accounts', item => {
        requireFields(item, ['platform', 'userId', 'personId', 'label']);
        return dated(item, accountFields(item), true);
      });
      const accountKeys = new Set();
      for (const account of accounts) {
        const key = JSON.stringify([account.platform, account.userId]);
        if (accountKeys.has(key)) invalid('备份包含重复的平台账号绑定。');
        accountKeys.add(key);
      }
      const tombstones = rows('tombstones', item => ({ memoryId: identifier(item.memoryId, '已删除记忆 ID'), deletedAt: timestamp(item.deletedAt, '删除时间') }));
      const conversationBlocks = payload.conversationBlocks === undefined ? [] : rows('conversationBlocks', item => {
        const fields = ['scope', 'eventId', 'blockedAt'];
        requireFields(item, fields);
        if (Object.keys(item).some(key => !fields.includes(key))) invalid('对话屏蔽记录包含未知字段。');
        return { scope: scopeValue(item.scope), eventId: identifier(item.eventId, '对话来源 ID'), blockedAt: timestamp(item.blockedAt, '对话屏蔽时间') };
      }, item => JSON.stringify([item.scope, item.eventId]));
      const expressions = payload.expressions === undefined ? [] : rows('expressions', item => {
        requireFields(item, ['name', 'description', 'scope', 'origin', 'mimeType', 'data', 'hash', 'byteLength', 'actor']);
        if (typeof item.data !== 'string' || item.data.length > Math.ceil(EXPRESSION_LIMITS.image / 3) * 4) invalid('备份表情图片超过单张 2 MiB 限制。');
        const fields = expressionFields({ ...item, image: { mimeType: item.mimeType, dataUrl: `data:${item.mimeType};base64,${item.data}` } });
        if (item.hash !== fields.hash || item.byteLength !== fields.byteLength) invalid('备份表情的校验值或大小不一致。');
        expressionId(item.id);
        return dated(item, fields);
      });
      expressionCapacity(expressions);
      const expressionKeys = new Set();
      for (const expression of expressions) {
        const key = `${expression.origin}:${expression.hash}`;
        if (expressionKeys.has(key)) invalid('备份包含同一会话的重复表情。');
        expressionKeys.add(key);
      }
      const expressionTombstones = payload.expressionTombstones === undefined ? [] : rows('expressionTombstones', item => {
        const origin = expressionOrigin(item.origin);
        if (typeof item.hash !== 'string' || !/^[a-f0-9]{64}$/.test(item.hash)) invalid('备份表情删除记录的校验值无效。');
        return { origin, hash: item.hash, deletedAt: timestamp(item.deletedAt, '表情删除时间') };
      }, item => `${item.origin}:${item.hash}`);
      const books = payload.books === undefined ? [] : rows('books', item => {
        const fields = ['id', 'title', 'sourceRef', 'text', 'currentOffset', 'createdAt', 'lastReadAt', 'deletedAt'];
        requireFields(item, fields);
        if (Object.keys(item).some(key => !fields.includes(key))) invalid('备份书籍包含未知字段。');
        const clean = { id: bookId(item.id), ...bookFields(item), currentOffset: integer(item.currentOffset, '书籍进度', 0, item.text.length),
          createdAt: timestamp(item.createdAt, '书籍创建时间'), lastReadAt: item.lastReadAt === null ? null : timestamp(item.lastReadAt, '最后阅读时间'),
          deletedAt: item.deletedAt === null ? null : timestamp(item.deletedAt, '书籍删除时间') };
        if ((clean.currentOffset > 0 && !clean.lastReadAt) || (clean.currentOffset === 0 && clean.lastReadAt)) invalid('书籍进度与最后阅读时间不一致。');
        if ((clean.lastReadAt && clean.lastReadAt < clean.createdAt) || (clean.deletedAt && clean.deletedAt < clean.createdAt)
          || (clean.deletedAt && clean.lastReadAt && clean.deletedAt < clean.lastReadAt)) invalid('书籍记录时间顺序无效。');
        return clean;
      });
      bookCapacity(books);
      const bookTombstones = payload.bookTombstones === undefined ? [] : rows('bookTombstones', item => {
        requireFields(item, ['bookId', 'deletedAt']);
        if (Object.keys(item).some(key => !['bookId', 'deletedAt'].includes(key))) invalid('书籍删除记录包含未知字段。');
        return { bookId: bookId(item.bookId), deletedAt: timestamp(item.deletedAt, '书籍删除时间') };
      }, item => item.bookId);

      return transaction(() => {
        // Preserve deletions made after the backup. Restoring an older backup must not resurrect them.
        const deleted = new Map(all('SELECT * FROM tombstones').map(row => [row.memory_id, row.deleted_at]));
        for (const item of [...tombstones, ...memories.filter(memory => memory.deletedAt).map(memory => ({ memoryId: memory.id, deletedAt: memory.deletedAt }))]) {
          if (!deleted.has(item.memoryId) || deleted.get(item.memoryId) < item.deletedAt) deleted.set(item.memoryId, item.deletedAt);
        }
        const deletedExpressions = new Map(all('SELECT * FROM expression_tombstones').map(row => [`${row.origin}:${row.hash}`, { origin: row.origin, hash: row.hash, deletedAt: row.deleted_at }]));
        for (const item of expressionTombstones) {
          const key = `${item.origin}:${item.hash}`;
          if (!deletedExpressions.has(key) || deletedExpressions.get(key).deletedAt < item.deletedAt) deletedExpressions.set(key, item);
        }
        const deletedBooks = new Map(all('SELECT * FROM book_tombstones').map(row => [row.book_id, row.deleted_at]));
        for (const item of [...bookTombstones, ...books.filter(book => book.deletedAt).map(book => ({ bookId: book.id, deletedAt: book.deletedAt }))]) {
          if (!deletedBooks.has(item.bookId) || deletedBooks.get(item.bookId) < item.deletedAt) deletedBooks.set(item.bookId, item.deletedAt);
        }
        db.exec('DELETE FROM revisions; DELETE FROM memories; DELETE FROM events; DELETE FROM messages; DELETE FROM accounts; DELETE FROM tombstones; DELETE FROM expressions; DELETE FROM expression_tombstones; DELETE FROM books; DELETE FROM book_tombstones;');
        for (const memory of memories) {
          if (deleted.has(memory.id)) {
            memory.deletedAt = deleted.get(memory.id);
            if (memory.updatedAt < memory.deletedAt) memory.updatedAt = memory.deletedAt;
          }
          insertMemory(memory);
        }
        for (const revision of revisions) insertRevision(revision);
        for (const event of events) insertEvent(event);
        for (const message of messages) insertMessage(message);
        // This table is never cleared: even backups made before a memory existed cannot undo its block.
        for (const item of conversationBlocks) insertConversationBlock(item.scope, item.eventId, item.blockedAt);
        backfillConversationBlocks();
        // Account mappings remain in the export for review, but must be verified again after restore.
        // In particular, an old backup must not reactivate a revoked owner account.
        for (const [id, deletedAt] of deleted) run('INSERT INTO tombstones VALUES (?, ?)', id, deletedAt);
        for (const expression of expressions) {
          if (!deletedExpressions.has(`${expression.origin}:${expression.hash}`)) insertExpression(expression);
        }
        for (const item of deletedExpressions.values()) run('INSERT INTO expression_tombstones VALUES (?, ?, ?)', item.origin, item.hash, item.deletedAt);
        for (const book of books) if (!deletedBooks.has(book.id)) insertBook(book);
        for (const [id, deletedAt] of deletedBooks) run('INSERT INTO book_tombstones VALUES (?, ?)', id, deletedAt);
        // Only persona and the numeric mood snapshot are restored; runtime settings and credentials stay local.
        if (persona !== null) api.setSetting('persona', persona);
        api.setSetting('moodState', moodState);
        return api.stats();
      });
    },
    close() { db.close(); },
  };

  // SQLite errors can contain SQL details or filesystem paths. Only validation messages leave this module.
  return Object.fromEntries(Object.entries(api).map(([name, method]) => [name, (...args) => {
    try { return method(...args); }
    catch (error) {
      if (error.validation) throw error;
      throw new Error('本地数据操作失败，请检查数据库文件是否可用。');
    }
  }]));
}
