import { normalizeAutonomySettings } from './autonomy.js';
import { expressionPlatforms, normalizeExpressionSettings } from './self-expression.js';
import { validateHeyboxPost } from './heybox-post.js';

const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : '';
const currentDay = (state, time) => Date.parse(state.dayStartAt) <= time && time < Date.parse(state.dayEndAt);
const outcomes = new Set(['pending', 'unknown', 'error', 'success', 'review', 'cancelled', 'skipped', 'quiet', 'busy', 'limit', 'missed', 'deciding', 'decided', 'checking', 'unavailable']);
const outcome = value => outcomes.has(value) ? value : 'unrecorded';

// Only project selected fields: raw scheduler state can contain private settings and errors.
export function activitySnapshot(store, { readingStatus = {}, expressionStatus = {}, dshStatus = {}, qqChatStatus = {}, time = Date.now() } = {}) {
  const reading = normalizeAutonomySettings({}, store.getSetting('autonomy', {}));
  const expression = normalizeExpressionSettings({}, store.getSetting('selfExpression', {}));
  const readingToday = currentDay(readingStatus, time), expressionToday = currentDay(expressionStatus, time);
  const events = store.listEvents({ scope: 'owner', limit: 200 });
  const posts = events.filter(item => item.type === 'self_expression' && item.actor === 'scheduler'
    && ['post', 'comment', 'reply'].includes(item.metadata?.action) && Object.hasOwn(expressionPlatforms, item.metadata.platform) && item.metadata.outcome !== 'attempt')
    .slice(0, 5).map(item => ({ platform: item.metadata.platform, action: item.metadata.action, outcome: outcome(item.metadata.outcome),
      attemptedAt: date(item.metadata.at), recordedAt: date(item.createdAt),
      ...(item.metadata.action !== 'post' ? { targetUrl: text(item.metadata.targetUrl, 2048) } : {}),
      ...(['success', 'review'].includes(item.metadata.outcome) ? { title: text(item.metadata.title, 30), text: text(item.content, 800) } : {}) }));
  return {
    asOf: new Date(time).toISOString(),
    chat: { platform: 'qq', day: typeof qqChatStatus.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(qqChatStatus.day) ? qqChatStatus.day : '', timeZone: 'UTC',
      dailyLimit: count(qqChatStatus.dailyLimit), attempts: count(qqChatStatus.attempts), remaining: count(qqChatStatus.remaining) },
    reading: { enabled: reading.enabled, sources: reading.sources, busy: readingStatus.busy === true, dailyMax: reading.dailyMax,
      attempts: readingToday ? count(readingStatus.attempts) : 0,
      plannedLimit: readingToday ? Math.min(count(readingStatus.target), reading.dailyMax) : null,
      nextRunAt: reading.enabled && readingToday ? date(readingStatus.nextRunAt) : '',
      budgetTimeZone: readingToday ? text(readingStatus.timeZone, 80) : reading.timeZone,
      lastOutcome: outcome(readingStatus.lastOutcome), lastAttempt: date(readingStatus.lastAttempt),
      recentReadings: store.listRecentReadings(['owner'], 5),
      dsh: dshStatus.reading && /^\d{4}-\d{2}-\d{2}$/.test(dshStatus.reading.day) ? {
        enabled: dshStatus.enabled === true, busy: dshStatus.busy === true, day: dshStatus.reading.day, timeZone: 'UTC',
        attempts: count(dshStatus.reading.attempts), dailyLimit: count(dshStatus.reading.dailyLimit), remaining: count(dshStatus.reading.remaining),
      } : null },
    expression: { enabled: expression.enabled, busy: expressionStatus.busy === true, desire: expression.desire,
      dailyLimit: expression.dailyLimit, attempts: expressionToday ? count(expressionStatus.postAttempts) : 0,
      cooldownMinutes: expression.cooldownMinutes,
      budgetTimeZone: expressionToday ? text(expressionStatus.timeZone, 80) : expression.timeZone,
      nextRunAt: expression.enabled && expressionToday ? date(expressionStatus.nextRunAt) : '',
      platforms: Object.entries(expressionPlatforms).map(([id, platform]) => ({ id, name: platform.name,
        enabled: expression.platforms[id].enabled, postEnabled: expression.platforms[id].post,
        commentEnabled: expression.platforms[id].comment === true, replyEnabled: expression.platforms[id].reply === true, dailyLimit: expression.platforms[id].dailyLimit,
        attempts: expressionToday ? ['post', 'comment', 'reply'].reduce((sum, action) => sum + count(expressionStatus.platformAttempts?.[id]?.[action]), 0) : 0,
        actions: ['post', 'comment', 'reply'].filter(action => expressionPlatforms[id].actions.includes(action)).map(action => ({ action,
          attempts: expressionToday ? count(expressionStatus.platformAttempts?.[id]?.[action]) : 0,
          outcome: outcome(expressionStatus.outcomes?.[id]?.[action]?.outcome), lastAttempt: date(expressionStatus.outcomes?.[id]?.[action]?.at) })),
        lastPostOutcome: outcome(expressionStatus.outcomes?.[id]?.post?.outcome),
        lastAttempt: date(expressionStatus.outcomes?.[id]?.post?.at) })),
      recentPosts: posts,
      recentChecks: events.filter(item => item.type === 'self_expression_check' && item.actor === 'owner' && item.metadata?.platform === 'heybox')
        .slice(0, 3).map(item => ({ title: text(item.metadata.title, 30), checkedAt: date(item.metadata.checkedAt),
          attemptedAt: date(item.metadata.attemptedAt), outcome: outcome(item.metadata.outcome) })) },
  };
}

export function communityReadingResult(store, status) {
  if (status.skipped || status.lastOutcome !== 'success') return { ok: false, skipped: text(status.skipped || status.lastOutcome, 80),
    message: '本次没有完成新的阅读；不把过去的成功记录当成本次结果。' };
  const note = typeof status.lastReflectionMemoryId === 'string' && status.lastReflectionMemoryId ? store.getMemory(status.lastReflectionMemoryId) : null;
  const hasNote = status.lastReflectionOutcome === 'success' && note && !note.deletedAt && note.scope === 'owner'
    && note.category === 'reading-note' && note.sourceType === 'reflection' && note.sourceRef === status.lastUrl;
  return { ok: true, title: text(status.lastTitle, 500), url: text(status.lastUrl, 2048), readAt: date(status.lastSuccess),
    recentReadings: store.listRecentReadings(['owner'], 5),
    reflection: hasNote ? { ok: true, memoryId: note.id, excerpt: text(note.content, 1200), truncated: note.content.length > 1200 }
      : { ok: false, message: '正文已读取，本次读后笔记尚未完成。' } };
}

export async function inspectRecentPost({ store, inspect, clock = Date.now }) {
  const state = store.getSetting('selfExpressionStatus', {});
  // An unconfirmed new attempt must never be replaced by evidence about an older successful post.
  const latest = state.outcomes?.heybox?.post;
  if (state.lastPostPlatform !== 'heybox' || !['success', 'review'].includes(latest?.outcome)
    || !['success', 'review'].includes(state.lastPostState)) return { ok: false, skipped: 'no_confirmed_post',
    message: '没有可供核对的最近小黑盒已提交正文；结果未知的尝试不会用旧帖子代替，也不会重新发布。' };
  const settings = normalizeExpressionSettings({}, store.getSetting('selfExpression', {}));
  const post = validateHeyboxPost({ title: state.lastPostTitle, text: state.lastPostText, topic: settings.platforms.heybox.topic });
  const fingerprint = JSON.stringify([latest, state.lastPostPlatform, state.lastPostTitle, state.lastPostText, state.lastPostState]);
  const result = await inspect(post);
  const current = store.getSetting('selfExpressionStatus', {});
  if (fingerprint !== JSON.stringify([current.outcomes?.heybox?.post, current.lastPostPlatform, current.lastPostTitle, current.lastPostText, current.lastPostState])) {
    return { ok: false, skipped: 'changed', message: '核对期间动态记录发生变化，本次结果未用于判断最新帖子。' };
  }
  if (result?.confirmed !== true || result.accountVerified !== true || !['published_view', 'review_view'].includes(result.confirmation)) {
    return { ok: false, skipped: 'unconfirmed', message: '本次未核对到标题、作者和正文一致的本人帖子；不能据此认定已删除、被拒绝或从未发布。' };
  }
  const checked = { ok: true, platform: 'heybox', title: post.title, checkedAt: new Date(clock()).toISOString(),
    outcome: result.confirmation === 'review_view' ? 'review' : 'success', confirmation: result.confirmation };
  store.addEvent({ type: 'self_expression_check', scope: 'owner', actor: 'owner', content: checked.outcome === 'review' ? '本人帖子仍显示审核中。' : '已回读本人帖子，未显示审核中提示。',
    metadata: { ...checked, attemptedAt: date(latest.at) } });
  return checked;
}
