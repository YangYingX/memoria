import { randomUUID } from 'node:crypto';
import { queryTokens } from './store.js';

export const defaultAutonomySettings = {
  enabled: false, sources: ['heybox'], dailyMin: 3, dailyMax: 6,
  startHour: 9, endHour: 23, timeZone: 'Asia/Shanghai', interests: '游戏与玩家社区',
};
const SOURCE_URLS = { heybox: 'https://www.xiaoheihe.cn/app/bbs/home' };
const DAY_MS = 24 * 60 * 60 * 1000;

export function normalizeAutonomySettings(input = {}, previous = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('自主活动设置格式无效。');
  const config = Object.fromEntries(Object.entries(defaultAutonomySettings).map(([key, fallback]) => [key, input[key] ?? previous?.[key] ?? fallback]));
  if (typeof config.enabled !== 'boolean') throw new Error('自主活动开关须为布尔值。');
  if (!Array.isArray(config.sources) || config.sources.length !== 1 || config.sources[0] !== 'heybox') throw new Error('当前自主活动仅支持小黑盒。');
  config.sources = [...config.sources];
  for (const key of ['dailyMin', 'dailyMax']) if (!Number.isInteger(config[key]) || config[key] < 1 || config[key] > 24) throw new Error('每日活动次数须为 1 至 24 的整数。');
  if (config.dailyMin > config.dailyMax) throw new Error('每日最少次数不能超过最多次数。');
  if (!Number.isInteger(config.startHour) || !Number.isInteger(config.endHour) || config.startHour < 0 || config.endHour > 24 || config.startHour >= config.endHour) throw new Error('活跃时段须为同一天内的整点，开始时间应早于结束时间。');
  if (typeof config.timeZone !== 'string' || config.timeZone.length > 80) throw new Error('时区无效。');
  try { new Intl.DateTimeFormat('en', { timeZone: config.timeZone }).format(); } catch { throw new Error('时区无效。'); }
  if (typeof config.interests !== 'string' || config.interests.length > 1000 || config.interests.includes('\0')) throw new Error('兴趣须为不超过 1000 字的文本。');
  config.interests = config.interests.trim();
  return config;
}

function localDay(time, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(time);
}

function dayBounds(now, timeZone) {
  const day = localDay(now, timeZone);
  // Search real instants instead of assuming every local day has 24 hours.
  function boundary(low, high, start) {
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if ((localDay(middle, timeZone) === day) === start) high = middle;
      else low = middle;
    }
    return high;
  }
  return { day, dayStartAt: new Date(boundary(now - 2 * DAY_MS, now, true)).toISOString(),
    dayEndAt: new Date(boundary(now, now + 2 * DAY_MS, false)).toISOString(), timeZone };
}

function articleUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || value.length > 2048) return '';
    url.hash = '';
    return url.href;
  } catch { return ''; }
}

export function createAutonomyJobs({ store, discoverPosts, readPost, isBusy = () => false, clock = Date.now, random = Math.random }) {
  let busy = false, stopped = false, controller;
  const now = () => Number(clock());
  const draw = () => Math.min(0.999999999, Math.max(0, Number(random()) || 0));
  const settings = () => normalizeAutonomySettings({}, store.getSetting('autonomy', {}));
  const status = () => ({ ...store.getSetting('autonomyStatus', {}), busy });
  const save = state => { if (!stopped) store.setSetting('autonomyStatus', state); return state; };
  const hourAt = (time, config) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: config.timeZone, hour: '2-digit', hourCycle: 'h23' }).format(time));

  function slots(config, state, from) {
    const hours = new Intl.DateTimeFormat('en-GB', { timeZone: config.timeZone, hour: '2-digit', hourCycle: 'h23' });
    const minutes = [];
    for (let time = Math.ceil(from / 60000) * 60000; time < Date.parse(state.dayEndAt); time += 60000) {
      const hour = Number(hours.format(time));
      if (hour >= config.startHour && hour < config.endHour) minutes.push(time);
    }
    const count = Math.min(Math.max(0, Math.min(state.target, config.dailyMax) - state.attempts), minutes.length);
    return Array.from({ length: count }, (_, index) => new Date(minutes[Math.floor((index + draw()) * minutes.length / count)]).toISOString());
  }

  function plan(config, time) {
    let state = store.getSetting('autonomyStatus', {});
    const signature = JSON.stringify(config);
    if (!state.dayId || !Number.isFinite(Date.parse(state.dayEndAt)) || time >= Date.parse(state.dayEndAt)) {
      state = { ...state, ...dayBounds(time, config.timeZone), dayId: randomUUID(), attempts: 0,
        target: config.dailyMin + Math.floor(draw() * (config.dailyMax - config.dailyMin + 1)), daySlots: [], configSignature: '' };
      state.daySlots = slots(config, state, Date.parse(state.dayStartAt));
    } else if (state.configSignature !== signature) {
      // Keep the original day boundary and budget when hours, timezone or limits change.
      state.daySlots = slots(config, state, time);
    }
    state.failures = (state.failures || []).filter(item => Date.parse(item.retryAt) > time).slice(-50);
    state.configSignature = signature;
    state.nextRunAt = state.daySlots[0] || '';
    if (JSON.stringify(state) !== JSON.stringify(store.getSetting('autonomyStatus', {}))) save(state);
    return state;
  }

  async function run({ force = false } = {}) {
    if (stopped) return { ...status(), skipped: 'stopped' };
    if (busy || isBusy()) return { ...status(), skipped: 'busy' };
    const config = settings(), time = now();
    if (!config.enabled || !store.getSetting('admin')) return { ...status(), skipped: 'disabled' };
    const state = plan(config, time);
    if (state.attempts >= Math.min(state.target, config.dailyMax)) return { ...status(), skipped: 'daily_limit' };
    if (!force) {
      const hour = hourAt(time, config);
      if (hour < config.startHour || hour >= config.endHour) {
        state.daySlots = state.daySlots.filter(value => Date.parse(value) > time);
        state.nextRunAt = state.daySlots[0] || '';
        save(state);
        return { ...status(), skipped: 'outside_hours' };
      }
      const due = state.daySlots.filter(value => Date.parse(value) <= time).length;
      if (!due) return { ...status(), skipped: 'not_due' };
      // Consume just the latest missed slot; do not catch up in a burst after downtime.
      state.daySlots.splice(0, due - 1);
    }
    state.daySlots.shift();
    state.attempts += 1;
    state.nextRunAt = state.daySlots[0] || '';
    state.lastAttempt = new Date(time).toISOString();
    state.lastError = '';
    save(state);
    busy = true;
    const activeController = controller = new AbortController();
    const current = () => !stopped && !activeController.signal.aborted
      && store.getSetting('autonomyStatus', {}).dayId === state.dayId
      && JSON.stringify(settings()) === state.configSignature;
    const check = () => { if (!current()) throw new Error('自主活动已取消。'); };
    const source = config.sources[Math.floor(draw() * config.sources.length)];
    let url = SOURCE_URLS[source], title = '', selected = false;
    function event(outcome, content, metadata = {}) {
      store.addEvent({ type: outcome === 'error' ? 'error' : 'autonomy', scope: 'owner', actor: 'scheduler',
        content, sourceRef: url, metadata: { source, outcome, title, ...metadata } });
    }
    try {
      const discovered = await discoverPosts(source, { signal: activeController.signal });
      check();
      url = articleUrl(discovered.url) || url;
      const tokens = queryTokens(`${config.interests} ${store.getSetting('persona', {}).description || ''}`);
      const seen = new Set();
      const candidates = (Array.isArray(discovered.posts) ? discovered.posts : []).slice(0, 200).flatMap(post => {
        const postUrl = articleUrl(post?.url);
        if (!postUrl || seen.has(postUrl) || store.hasReadUrl(postUrl, 'owner') || state.failures.some(item => item.url === postUrl)) return [];
        seen.add(postUrl);
        const postTitle = String(post.title || '').replace(/\0/g, '').slice(0, 500);
        const text = `${postTitle} ${String(post.excerpt || '').slice(0, 2000)}`.normalize('NFKC').toLowerCase();
        const words = new Set(text.match(/[a-z0-9_]+/g) || []);
        const matched = tokens.filter(token => /^[a-z0-9_]+$/.test(token) ? words.has(token) : text.includes(token));
        return [{ url: postUrl, title: postTitle, matched, score: matched.length }];
      });
      if (!candidates.length) {
        event('skipped', '本次浏览未找到尚未阅读且不在失败冷却期的帖子。', { reason: 'no_unread_posts' });
        save({ ...state, lastOutcome: 'skipped', lastUrl: url, lastTitle: '', lastError: '' });
        return { ...status(), busy: false, skipped: 'no_unread_posts' };
      }
      const best = Math.max(...candidates.map(post => post.score));
      const choices = candidates.filter(post => post.score === best);
      const post = choices[Math.floor(draw() * choices.length)];
      url = post.url; title = post.title; selected = true;
      const reason = best ? `兴趣与人格关键词命中 ${best} 项，最高分同分候选随机选择。` : '未命中兴趣或人格关键词，从未读候选帖子中随机选择。';
      check();
      if (isBusy()) {
        event('skipped', '正在处理其他活动，本次自主浏览未继续读取帖子。', { reason: 'busy' });
        save({ ...state, lastOutcome: 'skipped', lastUrl: url, lastTitle: title });
        return { ...status(), busy: false, skipped: 'busy' };
      }
      const page = await readPost(url, { signal: activeController.signal });
      check();
      const finalUrl = articleUrl(page.url);
      if (!finalUrl) throw new Error('帖子返回了无效的来源地址。');
      url = finalUrl;
      if (store.hasReadUrl(url, 'owner')) {
        event('skipped', '该帖子已有阅读记录，本次不重复保存。', { reason: 'already_read' });
        save({ ...state, lastOutcome: 'skipped', lastUrl: url, lastTitle: title });
        return { ...status(), busy: false, skipped: 'already_read' };
      }
      const reading = store.recordReading({ page, scope: 'owner', actor: 'scheduler' });
      title = String(page.title).replace(/\0/g, '').slice(0, 500);
      event('success', `阅读了《${title}》。选择方式：${reason}`, { reason, matchedKeywords: post.matched.slice(0, 30), memoryId: reading.memory.id });
      save({ ...state, lastOutcome: 'success', lastSuccess: new Date(now()).toISOString(), lastUrl: url, lastTitle: title, lastError: '' });
      return { ...status(), busy: false };
    } catch (error) {
      if (stopped) return { ...state, busy: false, skipped: 'stopped' };
      if (!current()) {
        const latest = store.getSetting('autonomyStatus', {});
        if (latest.dayId === state.dayId) {
          event('skipped', '本次自主活动已取消，未继续读取或保存帖子。', { reason: 'cancelled' });
          save({ ...latest, lastOutcome: 'cancelled', lastError: '', lastUrl: url, lastTitle: title });
        }
        return { ...status(), busy: false, skipped: 'cancelled' };
      }
      const message = String(error.message || '未知错误').replace(/\0/g, '').slice(0, 500);
      if (selected) state.failures = [...state.failures.filter(item => item.url !== url), { url, retryAt: new Date(now() + DAY_MS).toISOString() }].slice(-50);
      event('error', `自主浏览失败：${message}`);
      save({ ...state, lastOutcome: 'error', lastError: message, lastUrl: url, lastTitle: title });
      throw new Error(message);
    } finally { busy = false; if (controller === activeController) controller = null; }
  }

  async function tick() { try { return await run(); } catch { return status(); } }
  function cancel() { controller?.abort(); }
  function stop() { stopped = true; cancel(); }
  return { status, tick, run, cancel, stop };
}
