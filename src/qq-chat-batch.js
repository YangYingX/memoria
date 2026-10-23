export const defaultQQMergeWindow = 700;

export function normalizeQQMergeWindow(value = defaultQQMergeWindow) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1500) throw new Error('QQ 消息合并窗口须为 0–1500 毫秒。');
  return value;
}

export function createQQChatBatch({ run, onError = () => {}, clock = Date.now }) {
  if (typeof run !== 'function' || typeof onError !== 'function' || typeof clock !== 'function') throw new Error('QQ 消息批处理方式无效。');
  const conversations = new Map();
  const activeTasks = new Set();
  let stopped = false, count = 0;

  function forget(state) {
    if (!state.active && !state.queue.length) conversations.delete(state.conversation);
  }

  function pump(state) {
    if (stopped || state.active || !state.queue[0]?.ready) return;
    const batch = state.queue.shift();
    const controller = new AbortController();
    state.active = { batch, controller };
    const task = Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      try { await run(batch.items, { signal: controller.signal }); }
      catch (error) {
        if (!controller.signal.aborted) {
          try { await onError(error, batch.items); } catch {}
        }
      }
    }).finally(() => {
      count--;
      state.active = null;
      activeTasks.delete(task);
      pump(state);
      forget(state);
    });
    activeTasks.add(task);
  }

  function sealState(state) {
    const batch = state.open;
    if (!batch) return;
    clearTimeout(batch.timer);
    state.open = null;
    batch.ready = true;
    pump(state);
  }

  function schedule(state, batch) {
    clearTimeout(batch.timer);
    const deadline = Math.min(batch.lastAt + batch.windowMs, batch.startedAt + 1800);
    batch.timer = setTimeout(() => {
      if (state.open === batch) sealState(state);
    }, Math.max(0, deadline - clock()));
    batch.timer.unref?.();
  }

  function cancel() {
    for (const state of conversations.values()) {
      if (state.open) clearTimeout(state.open.timer);
      state.open = null;
      count -= state.queue.length;
      state.queue = [];
      state.active?.controller.abort();
      forget(state);
    }
  }

  return {
    enqueue(input) {
      if (stopped) return false;
      const windowMs = normalizeQQMergeWindow(input.windowMs);
      const now = clock();
      let state = conversations.get(input.conversation);
      const previous = state?.open;
      if (previous && previous.mergeable && input.mergeable === true && windowMs > 0 && previous.mergeKey === input.mergeKey
        && now >= previous.lastAt && now - previous.lastAt <= windowMs && now - previous.startedAt <= 1800
        && previous.items.length < 3 && previous.textLength + 1 + input.text.length <= 8000) {
        previous.items.push({ ...input, windowMs });
        previous.textLength += 1 + input.text.length;
        previous.lastAt = now;
        previous.windowMs = windowMs;
        if (previous.items.length === 3) sealState(state);
        else schedule(state, previous);
        return true;
      }
      if (previous) sealState(state);
      if (count >= 100 || (state?.queue.length || 0) + (state?.active ? 1 : 0) >= 10) return false;
      if (!state) {
        state = { conversation: input.conversation, queue: [], open: null, active: null };
        conversations.set(input.conversation, state);
      }
      const batch = { items: [{ ...input, windowMs }], mergeKey: input.mergeKey, mergeable: input.mergeable === true,
        startedAt: now, lastAt: now, windowMs, textLength: input.text.length, ready: input.mergeable !== true || windowMs === 0 };
      state.queue.push(batch);
      count++;
      if (batch.ready) pump(state);
      else { state.open = batch; schedule(state, batch); }
      return true;
    },
    seal(conversation) {
      const state = conversations.get(conversation);
      if (state) sealState(state);
    },
    cancel,
    async stop() {
      stopped = true;
      cancel();
      await Promise.allSettled([...activeTasks]);
    },
    status() {
      return { busy: activeTasks.size, pending: count - activeTasks.size };
    },
  };
}
