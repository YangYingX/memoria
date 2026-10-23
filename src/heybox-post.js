import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { validateHeyboxComment } from './heybox-comment.js';

export function validateHeyboxPost(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['title', 'text', 'topic'].includes(key))) throw new Error('小黑盒帖子仅接受标题、正文和分区。');
  const result = {};
  for (const [key, limit] of [['title', 30], ['text', 800], ['topic', 40]]) {
    const value = key === 'text' && typeof input[key] === 'string' ? input[key].replace(/\r\n/g, '\n') : input[key];
    if (typeof value !== 'string' || !value.trim() || value.trim().length > limit
      || (key === 'text' ? /[\x00-\x08\x0b-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value)) throw new Error(`小黑盒${key === 'title' ? '标题' : key === 'text' ? '正文' : '分区'}格式无效，最多 ${limit} 字。`);
    result[key] = value.trim();
  }
  return result;
}

export function verifyHeyboxPostView(view, input, nickname) {
  const post = validateHeyboxPost(input), prefix = 'com.max.xiaoheihe:id/';
  if (!['PicturePostPageActivityV2', 'WebNewsPostPageActivityV2'].some(name => view?.activity === `com.max.xiaoheihe/.module.bbs.post.ui.activitys.v2.${name}`)
    || !Array.isArray(view.nodes) || typeof nickname !== 'string' || !nickname.trim()) return null;
  const field = id => view.nodes.filter(node => node.id === prefix + id);
  const title = field('tv_title'), author = field('bbs_name'), body = field('tv_desc');
  if (title.length !== 1 || title[0].text.trim() !== post.title || author.length !== 1 || author[0].text !== nickname || body.length !== 1) return null;
  const observed = body[0].text.replace(/\r\n/g, '\n').trim();
  // Some submitted posts mask a few characters. Require the entire remaining body to match.
  let masked = 0;
  if (observed !== post.text) {
    if (observed.length !== post.text.length) return null;
    for (let index = 0; index < observed.length; index++) {
      if (observed[index] === post.text[index]) continue;
      if (observed[index] !== '*') return null;
      masked++;
    }
    if (!masked || masked > 8 || masked > Math.ceil(post.text.length * 0.05)) return null;
  }
  const review = field('tv_notice_reason').some(node => node.text === '内容审核中');
  return { confirmation: review ? 'review_view' : 'published_view', review, modified: masked > 0, text: observed };
}

export function createHeyboxPostJournal({ path, accountId, index, createdTimestamp, clock = Date.now }) {
  const hash = post => createHash('sha256').update(JSON.stringify(validateHeyboxPost(post))).digest('hex');
  const commentHash = input => {
    const { url, text, replyTo } = validateHeyboxComment(input);
    return createHash('sha256').update('comment:' + JSON.stringify({ url, text, replyTo })).digest('hex');
  };
  const stamp = () => new Date(clock()).toISOString();
  const blank = () => ({ version: 1, accountId, index, createdTimestamp, draft: null, attempts: [] });
  function load() {
    if (!existsSync(path)) return blank();
    try {
      if (statSync(path).size > 128 * 1024) throw new Error();
      const state = JSON.parse(readFileSync(path, 'utf8'));
      if (state.version !== 1 || state.accountId !== accountId || state.index !== index || state.createdTimestamp !== createdTimestamp
        || !Array.isArray(state.attempts) || state.attempts.length > 150) throw new Error();
      for (const item of [...state.attempts, ...(state.draft ? [state.draft] : []), ...(state.commentDraft ? [state.commentDraft] : [])]) {
        if (!item || !/^[a-f0-9]{64}$/.test(item.hash) || typeof item.at !== 'string' || !Number.isFinite(Date.parse(item.at))
          || new Date(item.at).toISOString() !== item.at) throw new Error();
      }
      for (const item of state.attempts) if (typeof item.id !== 'string' || !/^[0-9a-f-]{36}$/.test(item.id) || !['pending', 'success', 'review', 'unknown', 'rejected'].includes(item.outcome)) throw new Error();
      if (new Set(state.attempts.map(item => item.id)).size !== state.attempts.length) throw new Error();
      if (state.draft && (!['preparing', 'ready'].includes(state.draft.phase) || hash(state.draft.post) !== state.draft.hash
        || typeof state.draft.nickname !== 'string' || !state.draft.nickname.trim() || state.draft.nickname.length > 200)) throw new Error();
      if (state.commentDraft && (!['preparing', 'ready'].includes(state.commentDraft.phase) || commentHash(state.commentDraft.comment) !== state.commentDraft.hash
        || typeof state.commentDraft.nickname !== 'string' || !state.commentDraft.nickname.trim() || state.commentDraft.nickname.length > 200)) throw new Error();
      if (state.attempts.some(item => item.type !== undefined && !['comment', 'reply'].includes(item.type))) throw new Error();
      return state;
    } catch { throw new Error('小黑盒发帖记录无法核验，本次未继续；请检查本机记录。'); }
  }
  function save(state) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 }); renameSync(temporary, path); }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  function guardDigest(digest, { dailyLimit = 80, cooldownMinutes = 360, timeZone = 'Asia/Shanghai' } = {}) {
    if (!Number.isInteger(dailyLimit) || dailyLimit < 0 || dailyLimit > 100 || !Number.isInteger(cooldownMinutes)
      || cooldownMinutes < 60 || cooldownMinutes > 1440 || typeof timeZone !== 'string' || timeZone.length > 80) throw new Error('小黑盒发布额度配置无效。');
    let day;
    try { day = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }); }
    catch { throw new Error('小黑盒发布时间区无效。'); }
    const state = load(), time = Number(clock());
    if (state.attempts.some(item => item.hash === digest && item.outcome !== 'rejected')) return { ok: false, skipped: 'duplicate', message: '这份内容已有提交记录，不重复发布。' };
    const today = state.attempts.filter(item => day.format(Date.parse(item.at)) === day.format(time));
    if (today.some(item => ['pending', 'unknown'].includes(item.outcome))) return { ok: false, skipped: 'unknown', message: '今天有结果未确认的发布，先保留现场，不自动继续发布。' };
    if (today.length >= dailyLimit) return { ok: false, skipped: 'daily_limit', message: '小黑盒今日发布尝试额度已用完。' };
    const latest = Math.max(0, ...state.attempts.map(item => Date.parse(item.at)));
    if (latest && time - latest < cooldownMinutes * 60000) return { ok: false, skipped: 'cooldown', message: '尚未到小黑盒下一次允许发布的时间。' };
    return null;
  }
  const guard = (post, policy) => guardDigest(hash(post), policy);
  return {
    load,
    guard,
    guardComment: (comment, policy) => guardDigest(commentHash(comment), policy),
    clearCommentDraft(comment) {
      const state = load(), digest = commentHash(comment);
      if (!state.commentDraft || state.commentDraft.hash !== digest
        || state.attempts.some(item => item.hash === digest && item.outcome !== 'rejected')) throw new Error('不能清除不匹配或已有提交尝试的评论草稿。');
      state.commentDraft = null; save(state);
    },
    setCommentDraft(input, nickname, phase = 'preparing') {
      const comment = validateHeyboxComment(input);
      if (typeof nickname !== 'string' || !nickname.trim() || nickname.length > 200 || !['preparing', 'ready'].includes(phase)) throw new Error('专用账号或评论草稿状态无效。');
      const state = load(); state.commentDraft = { comment, nickname, phase, hash: commentHash(comment), at: stamp() }; save(state); return state.commentDraft;
    },
    reserveComment(input, policy) {
      const comment = validateHeyboxComment(input), digest = commentHash(comment);
      const blocked = guardDigest(digest, policy); if (blocked) return blocked;
      const state = load();
      if (!state.commentDraft || state.commentDraft.phase !== 'ready' || state.commentDraft.hash !== digest) throw new Error('评论尚未完整回读，不允许发送。');
      const attempt = { id: randomUUID(), hash: digest, type: comment.replyTo ? 'reply' : 'comment', title: comment.title,
        url: comment.url, targetKey: comment.replyTo?.key || '', at: stamp(), outcome: 'pending' };
      state.attempts = [...state.attempts.slice(-149), attempt]; save(state); return attempt;
    },
    setDraft(post, nickname, phase = 'preparing') {
      post = validateHeyboxPost(post);
      if (typeof nickname !== 'string' || !nickname.trim() || nickname.length > 200 || !['preparing', 'ready'].includes(phase)) throw new Error('专用账号或草稿状态无效。');
      const state = load(); state.draft = { post, nickname, phase, hash: hash(post), at: stamp() }; save(state); return state.draft;
    },
    reserve(post, policy) {
      const blocked = guard(post, policy); if (blocked) return blocked;
      const state = load(), digest = hash(post);
      if (!state.draft || state.draft.phase !== 'ready' || state.draft.hash !== digest) throw new Error('帖子尚未完整回读，不允许发布。');
      const attempt = { id: randomUUID(), hash: digest, title: post.title, at: stamp(), outcome: 'pending' };
      state.attempts = [...state.attempts.slice(-149), attempt]; save(state); return attempt;
    },
    finish(id, outcome) {
      if (!['success', 'review', 'unknown', 'rejected'].includes(outcome)) throw new Error('发布结果无效。');
      const state = load(), attempt = state.attempts.find(item => item.id === id);
      if (!attempt || attempt.outcome !== 'pending') throw new Error('没有待确认的发布记录。');
      attempt.outcome = outcome;
      if (['success', 'review'].includes(outcome)) {
        if (attempt.type) {
          if (state.commentDraft?.hash === attempt.hash) state.commentDraft = null;
        } else if (state.draft?.hash === attempt.hash) state.draft = null;
      }
      save(state); return attempt;
    },
  };
}
