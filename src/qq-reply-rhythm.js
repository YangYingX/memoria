import { abortableSleep, computeSegmentGapMs } from './vendor/dsh-im-humanize/send-delay.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export function normalizeQQReplySettings(input = {}, previous = {}) {
  if (!object(input) || !object(previous)) throw new Error('QQ 回复节奏设置格式无效。');
  const replySplitEnabled = input.replySplitEnabled === undefined ? previous.replySplitEnabled === undefined ? false : previous.replySplitEnabled : input.replySplitEnabled;
  const replyDelayMs = input.replyDelayMs === undefined ? previous.replyDelayMs === undefined ? 0 : previous.replyDelayMs : input.replyDelayMs;
  if (typeof replySplitEnabled !== 'boolean') throw new Error('QQ 分段回复开关须为布尔值。');
  if (!Number.isSafeInteger(replyDelayMs) || replyDelayMs < 0 || replyDelayMs > 5000) throw new Error('QQ 最长回复停顿须为 0–5000 毫秒的整数。');
  return { replySplitEnabled, replyDelayMs };
}

export function planQQReply(reply, config = {}) {
  const { replySplitEnabled } = normalizeQQReplySettings(config);
  if (typeof reply !== 'string' || !reply.trim() || reply.includes('\0')) throw new Error('QQ 回复正文无效。');
  let end = Math.min(reply.length, 5000);
  if (end < reply.length && /[\uD800-\uDBFF]/.test(reply[end - 1])) end--;
  const text = reply.slice(0, end);
  if (!replySplitEnabled || /(?:^|\n)[ \t]*(?:```|~~~)/.test(text)) return [{ text, endOffset: end }];
  const parts = [];
  let start = 0;
  for (const match of text.matchAll(/\r?\n[ \t]*\r?\n(?:[ \t]*\r?\n)*/g)) {
    if (parts.length >= 2) break;
    if (!text.slice(start, match.index).trim() || !text.slice(match.index + match[0].length).trim()) continue;
    parts.push({ text: text.slice(start, match.index), endOffset: match.index });
    start = match.index + match[0].length;
  }
  parts.push({ text: text.slice(start), endOffset: end });
  return parts;
}

export function qqReplyDelay(text, maximum, random = Math.random) {
  normalizeQQReplySettings({ replyDelayMs: maximum });
  if (!maximum) return 0;
  const delay = computeSegmentGapMs({ segmentText: text, random,
    segmentGap: { minMs: Math.min(200, maximum), maxMs: Math.min(500, maximum), charsPerSecond: 80, maxTotalMs: maximum },
    minSegmentGapMs: 0 });
  if (!Number.isFinite(delay) || delay < 0 || delay > maximum) throw new Error('QQ 回复停顿计算无效。');
  return Math.round(delay);
}

// A confirmed prefix is recorded synchronously after each receipt, before the next pause.
export async function deliverQQReply({ reply, expressionIds = [], config, send, onConfirmed, assertActive, signal }) {
  const { replyDelayMs } = normalizeQQReplySettings(config);
  if (typeof send !== 'function' || typeof onConfirmed !== 'function' || typeof assertActive !== 'function') throw new Error('QQ 回复发送方式无效。');
  if (!Array.isArray(expressionIds) || expressionIds.length > 1 || expressionIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id))) throw new Error('QQ 回复表情标识无效。');
  const parts = reply === '' && expressionIds.length === 1 ? [{ text: '', endOffset: 0 }] : planQQReply(reply, config);
  for (let index = 0; index < parts.length; index++) {
    signal?.throwIfAborted(); assertActive();
    const part = parts[index], delay = qqReplyDelay(part.text, replyDelayMs);
    if (delay) await abortableSleep(delay, signal);
    signal?.throwIfAborted(); assertActive();
    const receipt = await send(part.text, index === parts.length - 1 ? expressionIds : []);
    onConfirmed(part.endOffset, receipt);
  }
  return { parts: parts.length };
}
