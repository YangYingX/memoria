function invalid() {
  const error = new Error('QQ 合并消息的来源分段无效。');
  error.validation = true;
  throw error;
}

export function normalizeQQBatchSources(value, text) {
  if (value === undefined) return undefined;
  if (typeof text !== 'string' || !text || text.length > 8000 || text.trim() !== text || text.includes('\0')
    || !Array.isArray(value) || value.length < 2 || value.length > 3) invalid();
  const ids = new Set();
  let nextOffset = 0;
  return Array.from(value, (item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || ![Object.prototype, null].includes(Object.getPrototypeOf(item))
      || Object.keys(item).length !== 4 || Object.keys(item).some(key => !['platformMessageId', 'startOffset', 'endOffset', 'receivedAt'].includes(key))
      || typeof item.platformMessageId !== 'string' || !/^(?:0|-?[1-9]\d{0,19})$/.test(item.platformMessageId) || ids.has(item.platformMessageId)
      || !Number.isSafeInteger(item.startOffset) || !Number.isSafeInteger(item.endOffset)
      || item.startOffset !== nextOffset || item.endOffset <= item.startOffset || item.endOffset > text.length
      || typeof item.receivedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item.receivedAt)) invalid();
    const received = new Date(item.receivedAt);
    if (!Number.isFinite(received.getTime()) || received.toISOString() !== item.receivedAt) invalid();
    const part = text.slice(item.startOffset, item.endOffset);
    if (part.trim() !== part || (index === value.length - 1 ? item.endOffset !== text.length : text[item.endOffset] !== '\n')) invalid();
    ids.add(item.platformMessageId);
    nextOffset = item.endOffset + 1;
    return { platformMessageId: item.platformMessageId, startOffset: item.startOffset, endOffset: item.endOffset, receivedAt: item.receivedAt };
  });
}

export function qqBatchSourceInfo(value, text) {
  const sources = normalizeQQBatchSources(value, text);
  return sources ? { qqBatchCount: sources.length,
    qqBatchNotice: `同一发言者的${sources.length}条QQ消息按接收顺序合并；正文中的分隔换行由应用添加。` } : {};
}
