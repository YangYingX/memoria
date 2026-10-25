import { randomUUID } from 'node:crypto';

const DAY_MS = 86400000;
export const defaultBookSettings = { enabled: false, discoverEnabled: true, dailyLimit: 2, chunkChars: 3000, startHour: 9, endHour: 23, timeZone: 'Asia/Shanghai' };

export function normalizeBookSettings(input = {}, previous = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('读书设置格式无效。');
  const config = Object.fromEntries(Object.entries(defaultBookSettings).map(([key, fallback]) => [key, Object.hasOwn(input, key) ? input[key] : previous?.[key] ?? fallback]));
  if (typeof config.enabled !== 'boolean') throw new Error('读书开关须为布尔值。');
  if (typeof config.discoverEnabled !== 'boolean') throw new Error('自主找书开关须为布尔值。');
  if (!Number.isInteger(config.dailyLimit) || config.dailyLimit < 1 || config.dailyLimit > 6) throw new Error('每天读书次数须为 1 至 6。');
  if (!Number.isInteger(config.chunkChars) || config.chunkChars < 1000 || config.chunkChars > 6000) throw new Error('每次阅读长度须为 1000 至 6000 字。');
  if (!Number.isInteger(config.startHour) || !Number.isInteger(config.endHour) || config.startHour < 0 || config.endHour > 24 || config.startHour >= config.endHour) throw new Error('读书时段须为同一天内的整点，开始时间应早于结束时间。');
  if (typeof config.timeZone !== 'string' || config.timeZone.length > 80) throw new Error('读书时区无效。');
  try { new Intl.DateTimeFormat('en', { timeZone: config.timeZone }).format(); } catch { throw new Error('读书时区无效。'); }
  return config;
}

function dayBounds(time, timeZone) {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const day = format.format(time);
  function boundary(low, high, start) {
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if ((format.format(middle) === day) === start) high = middle;
      else low = middle;
    }
    return new Date(high).toISOString();
  }
  return { day, timeZone, dayStartAt: boundary(time - 2 * DAY_MS, time, true), dayEndAt: boundary(time, time + 2 * DAY_MS, false) };
}

function chunkEnd(text, start, length) {
  let end = Math.min(text.length, start + length);
  if (end === text.length) return end;
  // Prefer a sentence or paragraph boundary in the final half of the requested chunk.
  const minimum = start + Math.floor(length / 2);
  for (let index = end - 1; index >= minimum; index--) {
    if (/[。！？.!?\n]/.test(text[index])) { end = index + 1; break; }
  }
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  return end;
}

function catalogCandidates(value) {
  if (!Array.isArray(value) || value.length > 10) throw new Error('公共书目须为最多 10 条的数组。');
  const ids = new Set(), sources = new Set();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some(key => !['id', 'title', 'author', 'sourceRef', 'description'].includes(key))) throw new Error('公共书目格式无效。');
    const clean = {};
    for (const [key, limit] of [['id', 128], ['title', 200], ['author', 200], ['sourceRef', 2048], ['description', 1000]]) {
      const text = item[key] ?? (['author', 'description'].includes(key) ? '' : null);
      if (typeof text !== 'string' || (!text.trim() && !['author', 'description'].includes(key)) || text.length > limit
        || !text.isWellFormed() || /[\u0000-\u001f\u007f]/.test(text)) throw new Error('公共书目字段无效。');
      clean[key] = text;
    }
    if (ids.has(clean.id) || sources.has(clean.sourceRef)) throw new Error('公共书目标识或来源重复。');
    ids.add(clean.id); sources.add(clean.sourceRef);
    return clean;
  });
}

function bookDecision(value, books, candidates) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('选书决定格式无效。');
  if (value.action === 'quiet' && Object.keys(value).length === 1) return value;
  if (value.action === 'read' && Object.keys(value).length === 2 && Object.hasOwn(value, 'bookId')
    && books.some(book => book.id === value.bookId)) return value;
  if (value.action === 'discover' && Object.keys(value).length === 2 && Object.hasOwn(value, 'candidateId')
    && candidates.some(candidate => candidate.id === value.candidateId)) return value;
  throw new Error('选书只能使用本轮书籍或公共书目标识。');
}

export function createBookJobs({ store, summarize, decide, discover, load, isBusy = () => false, clock = Date.now, random = Math.random }) {
  let busy = false, stopped = false, controller, activeRun, foregroundPending;
  let lastState = store.getSetting('bookStatus', {});
  const now = () => Number(clock());
  const draw = () => Math.min(0.999999999, Math.max(0, Number(random()) || 0));
  const settings = () => normalizeBookSettings({}, store.getSetting('books', {}));
  const status = () => ({ ...(stopped ? lastState : store.getSetting('bookStatus', {})), busy: busy || Boolean(foregroundPending) });
  const save = state => { if (!stopped) { store.setSetting('bookStatus', state); lastState = state; } return state; };

  function slots(config, state, from) {
    const hours = new Intl.DateTimeFormat('en-GB', { timeZone: config.timeZone, hour: '2-digit', hourCycle: 'h23' });
    const minutes = [];
    for (let time = Math.ceil(from / 60000) * 60000; time < Date.parse(state.dayEndAt); time += 60000) {
      const hour = Number(hours.format(time));
      if (hour >= config.startHour && hour < config.endHour) minutes.push(time);
    }
    const count = Math.min(Math.max(0, Math.min(state.target, config.dailyLimit) - state.attempts), minutes.length);
    return Array.from({ length: count }, (_, index) => new Date(minutes[Math.floor((index + draw()) * minutes.length / count)]).toISOString());
  }

  function plan(config, time) {
    let state = store.getSetting('bookStatus', {});
    const signature = JSON.stringify(config);
    if (!state.dayId || !Number.isFinite(Date.parse(state.dayEndAt)) || time >= Date.parse(state.dayEndAt)) {
      state = { ...state, ...dayBounds(time, config.timeZone), dayId: randomUUID(), attempts: 0, target: config.dailyLimit, daySlots: [] };
      state.daySlots = slots(config, state, Date.parse(state.dayStartAt));
    } else if (state.configSignature !== signature) {
      // Editing settings does not refresh today's original budget or day boundary.
      state.daySlots = slots(config, state, time);
    }
    state.configSignature = signature;
    state.nextRunAt = state.daySlots[0] || '';
    if (JSON.stringify(state) !== JSON.stringify(store.getSetting('bookStatus', {}))) save(state);
    return state;
  }

  async function execute({ force = false, bookId, signal, assertActive } = {}) {
    if (stopped) return { ...status(), skipped: 'stopped' };
    signal?.throwIfAborted(); assertActive?.();
    if (busy || isBusy()) return { ...status(), skipped: 'busy' };
    const config = settings(), time = now();
    if ((!config.enabled && !force) || !store.getSetting('admin')) return { ...status(), skipped: 'disabled' };
    const state = plan(config, time);
    if (state.attempts >= Math.min(state.target, config.dailyLimit)) return { ...status(), skipped: 'daily_limit' };
    if (!force) {
      // Missed opportunities expire; waking or restarting never causes catch-up reads.
      const missed = state.daySlots.filter(value => Date.parse(value) < time - 10 * 60000).length;
      if (missed) {
        state.daySlots.splice(0, missed); state.nextRunAt = state.daySlots[0] || ''; state.lastOutcome = 'missed'; save(state);
      }
      const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: config.timeZone, hour: '2-digit', hourCycle: 'h23' }).format(time));
      if (hour < config.startHour || hour >= config.endHour) return { ...status(), skipped: 'outside_hours' };
      if (!state.daySlots.length || Date.parse(state.daySlots[0]) > time) return { ...status(), skipped: 'not_due' };
    }
    const selecting = !force && typeof decide === 'function';
    const unread = store.listBooks().filter(book => book.currentOffset < book.totalChars && (!bookId || book.id === bookId)).slice(0, 10);
    if (!selecting && !unread.length) {
      if (force || (state.daySlots[0] && Date.parse(state.daySlots[0]) <= time)) state.daySlots.shift();
      save({ ...state, nextRunAt: state.daySlots[0] || '', lastOutcome: 'empty', lastError: '' });
      return { ...status(), skipped: 'no_unread_books' };
    }
    const sources = (selecting ? unread : unread.length ? [unread[Math.floor(draw() * unread.length)]] : []).map(item => {
      const book = store.getBook(item.id);
      return { book, previousNotes: store.listBookReadingNotes(book.id, book.currentOffset).slice(0, 3) };
    });
    const books = sources.map(({ book, previousNotes }) => ({ id: book.id, title: book.title, sourceRef: book.sourceRef,
      currentOffset: book.currentOffset, totalChars: book.text.length, previousNotes }));
    const sourceSignature = () => JSON.stringify({ persona: store.getSetting('persona', {}), model: store.getSetting('model', {}),
      interests: store.getSetting('autonomy', {}).interests, moodState: store.getSetting('moodState', {}) });
    const inputSignature = sourceSignature();
    signal?.throwIfAborted(); assertActive?.();
    state.daySlots.shift(); state.attempts += 1; state.nextRunAt = state.daySlots[0] || '';
    state.lastAttempt = new Date(time).toISOString(); state.lastOutcome = 'choosing'; state.lastError = ''; state.lastCatalogError = '';
    save(state); busy = true;
    const activeController = controller = new AbortController();
    let finish;
    const running = activeRun = { forced: Boolean(force), controller: activeController, finished: new Promise(resolve => { finish = resolve; }) };
    const abort = () => activeController.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const sameDay = () => !stopped && store.getSetting('bookStatus', {}).dayId === state.dayId;
    const current = () => {
      try {
        signal?.throwIfAborted(); assertActive?.();
        if (!sameDay() || activeController.signal.aborted || now() < Date.parse(state.dayStartAt) || now() >= Date.parse(state.dayEndAt)
          || isBusy() || !store.getSetting('admin') || JSON.stringify(settings()) !== state.configSignature || sourceSignature() !== inputSignature) return false;
        return sources.every(source => {
          const latest = store.getBook(source.book.id);
          return latest && JSON.stringify(latest) === JSON.stringify(source.book)
            && JSON.stringify(store.listBookReadingNotes(source.book.id, source.book.currentOffset).slice(0, 3)) === JSON.stringify(source.previousNotes);
        });
      } catch { return false; }
    };
    try {
      let book, previousNotes, candidates = [];
      if (selecting) {
        if (config.discoverEnabled && typeof discover === 'function' && typeof load === 'function') {
          try {
            candidates = catalogCandidates(await discover({ signal: activeController.signal })).filter(candidate => !store.hasBookSource(candidate.sourceRef));
          } catch (error) {
            if (!current()) throw new Error('读书已取消。');
            state.lastCatalogError = String(error.message || '公共书目暂不可用。').replace(/\0/g, '').slice(0, 300);
            if (!books.length) throw error;
          }
          if (!current()) throw new Error('读书已取消。');
        }
        if (books.length || candidates.length) {
          const decision = bookDecision(await decide({ books: structuredClone(books), candidates: structuredClone(candidates), signal: activeController.signal }), books, candidates);
          if (!current()) throw new Error('读书已取消。');
          state.lastDecision = decision.action;
          if (decision.action === 'quiet') {
            save({ ...state, lastOutcome: 'quiet', lastError: '' });
            return { ...status(), busy: false };
          }
          if (decision.action === 'discover') {
            const candidate = candidates.find(item => item.id === decision.candidateId);
            if (store.hasBookSource(candidate.sourceRef)) throw new Error('该公开书籍已经收录或已被移除。');
            const loaded = await load(structuredClone(candidate), { signal: activeController.signal });
            if (!current()) throw new Error('读书已取消。');
            if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded) || Object.keys(loaded).some(key => !['title', 'text', 'sourceRef'].includes(key))
              || loaded.sourceRef !== candidate.sourceRef) throw new Error('公开书籍正文与本轮选定来源不一致。');
            if (store.hasBookSource(candidate.sourceRef)) throw new Error('该公开书籍已经收录或已被移除。');
            const imported = store.addDiscoveredBook(loaded);
            if (!imported) throw new Error('该公开书籍已经收录或已被移除。');
            state.lastImportedBookId = imported.id; save(state);
            book = store.getBook(imported.id);
            if (!book) throw new Error('新收录书籍已被移除。');
            previousNotes = store.listBookReadingNotes(book.id, book.currentOffset).slice(0, 3);
            sources.push({ book, previousNotes });
          } else ({ book, previousNotes } = sources.find(source => source.book.id === decision.bookId));
        }
      } else if (sources.length) ({ book, previousNotes } = sources[0]);
      if (!book) {
        save({ ...state, lastOutcome: 'empty', lastError: '' });
        return { ...status(), busy: false, skipped: 'no_unread_books' };
      }
      if (!current()) throw new Error('读书已取消。');
      const startOffset = book.currentOffset, endOffset = chunkEnd(book.text, startOffset, config.chunkChars);
      const excerpt = book.text.slice(startOffset, endOffset);
      state.lastOutcome = 'reading'; state.lastBookId = book.id; state.lastTitle = book.title;
      state.lastStartOffset = startOffset; state.lastEndOffset = endOffset; save(state);
      const note = await summarize({ title: book.title, excerpt, startOffset, endOffset, sourceRef: book.sourceRef, previousNotes, signal: activeController.signal });
      if (!current()) throw new Error('读书已取消。');
      if (typeof note !== 'string' || !note.trim() || note.length > 4000 || note.includes('\0')) throw new Error('读书笔记须为 1–4000 字的有效文本。');
      const reading = store.recordBookReading({ bookId: book.id, startOffset, endOffset, note, previousNotes });
      save({ ...state, lastOutcome: 'success', lastSuccess: new Date(now()).toISOString(), lastMemoryId: reading.memory.id, lastError: '' });
      return { ...status(), busy: false };
    } catch (error) {
      if (stopped) return { ...status(), busy: false, skipped: 'stopped' };
      if (!current()) {
        if (sameDay()) save({ ...store.getSetting('bookStatus', {}), lastOutcome: 'cancelled', lastError: '' });
        return { ...status(), busy: false, skipped: 'cancelled' };
      }
      const message = String(error.message || '读书未完成。').replace(/\0/g, '').slice(0, 300);
      save({ ...state, lastOutcome: 'error', lastError: message });
      throw new Error(message);
    } finally {
      signal?.removeEventListener('abort', abort);
      busy = false;
      if (controller === activeController) controller = null;
      if (activeRun === running) activeRun = null;
      finish();
    }
  }
  async function run(options = {}) {
    if (foregroundPending) return { ...status(), skipped: 'busy' };
    return execute(options);
  }
  async function runForeground({ bookId, signal, assertActive } = {}) {
    if (stopped) return { ...status(), skipped: 'stopped' };
    signal?.throwIfAborted(); assertActive?.();
    if (foregroundPending) return { ...status(), skipped: 'busy' };
    const pending = foregroundPending = new AbortController();
    const abort = () => pending.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const checkActive = () => { signal?.throwIfAborted(); pending.signal.throwIfAborted(); assertActive?.(); };
    async function handoff() {
      checkActive();
      const previous = activeRun;
      if (previous) {
        if (previous.forced || isBusy()) return { ...status(), skipped: 'busy' };
        const config = settings(), state = store.getSetting('bookStatus', {}), time = now();
        if (time >= Date.parse(state.dayStartAt) && time < Date.parse(state.dayEndAt)
          && state.attempts >= Math.min(state.target, config.dailyLimit)) return { ...status(), skipped: 'daily_limit' };
        previous.controller.abort();
        let timer;
        try {
          const finished = await Promise.race([previous.finished.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 2000); })]);
          checkActive();
          if (!finished) return { ...status(), skipped: 'busy' };
        } finally { clearTimeout(timer); }
      }
      if (stopped) return { ...status(), skipped: 'stopped' };
      checkActive();
      return execute({ force: true, bookId, signal: pending.signal, assertActive: checkActive });
    }
    let result;
    try { result = await handoff(); }
    finally {
      signal?.removeEventListener('abort', abort);
      if (foregroundPending === pending) foregroundPending = null;
    }
    return { ...result, busy };
  }
  async function tick() { try { return await run(); } catch { return status(); } }
  function cancel() { controller?.abort(); foregroundPending?.abort(); }
  function stop() { stopped = true; cancel(); }
  return { status, tick, run, runForeground, cancel, stop };
}
