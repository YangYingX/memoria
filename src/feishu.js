import { normalizeFeishuEvent, normalizeFeishuSettings, defaultFeishuSettings, feishuConversation } from './feishu-message.js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function createFeishuChat({ store, chat, transport, onError = () => {}, onOwnerMessage = () => {} }) {
  let stopped = false, started = false, running, controller, activeKey = '', binding;
  const sourceEpochs = new Map();
  const settings = () => normalizeFeishuSettings(store.getSetting('feishu', defaultFeishuSettings));
  function report(code) { try { onError(code); } catch {} }
  function cancelReceived() {
    let items;
    while ((items = store.listReceivedFeishuMessages(100)).length) {
      for (const item of items) {
        store.finishFeishuMessage(item.key, 'canceled', 'CONFIG_CHANGED');
        sourceEpochs.delete(item.key);
      }
    }
  }
  function currentRoute(item, config) {
    const event = normalizeFeishuEvent({ ...item.input, eventId: item.input.messageId,
      replay: { kind: 'provider-redelivery', resumeCursor: false, gapPossible: true } }, config);
    const route = feishuConversation(event, { store, ...config });
    if (!route || route.key !== item.key || route.scope !== item.scope || route.actor !== item.actor) throw new Error('FEISHU_ROUTE_CHANGED');
    return event;
  }
  async function process(item) {
    const config = settings(), connection = transport.status();
    if (!config.enabled || !connection.connected) return;
    let event;
    try { event = currentRoute(item, config); }
    catch { sourceEpochs.delete(item.key); store.finishFeishuMessage(item.key, 'interrupted', 'IDENTITY_CHANGED'); return; }
    if (!connection.epoch || connection.botId !== config.botId || connection.fingerprint !== config.expectedFingerprint) {
      sourceEpochs.delete(item.key); store.finishFeishuMessage(item.key, 'interrupted', 'ACCOUNT_CHANGED'); return;
    }
    const reservation = store.beginFeishuMessage(item.key, { dailyLimit: config.dailyChatLimit });
    if (!reservation.allowed) {
      sourceEpochs.delete(item.key);
      if (reservation.message?.state === 'received') store.finishFeishuMessage(item.key, 'failed', 'CHAT_LIMIT');
      return;
    }
    const recovered = sourceEpochs.get(item.key) !== connection.epoch;
    sourceEpochs.delete(item.key);
    const configSnapshot = JSON.stringify(config);
    controller = new AbortController(); activeKey = item.key;
    const taskController = controller;
    let sending = false;
    const check = () => {
      taskController.signal.throwIfAborted();
      const next = settings(), live = transport.status();
      if (stopped || JSON.stringify(next) !== configSnapshot || !live.connected || live.epoch !== connection.epoch
        || live.botId !== connection.botId || live.fingerprint !== connection.fingerprint) throw new Error('FEISHU_CONNECTION_CHANGED');
      const saved = store.getFeishuMessage(item.key);
      if (!saved || !['processing', 'reply_ready', 'sending'].includes(saved.state)) throw new Error('FEISHU_MESSAGE_CANCELED');
      currentRoute(saved, next);
    };
    try {
      check();
      const account = item.scope === 'owner' && item.actor === 'owner'
        ? store.findAccount('feishu', feishuConversation(event, { store, ...config }).accountId) : null;
      const result = await chat(item.scope, event.text, item.actor, { signal: taskController.signal, assertActive: check, textOnly: true,
        ...(account?.personId === 'owner' ? { conversationOrigin: { version: 1, platform: 'feishu', accountId: account.id,
          inboxKey: item.key, botId: event.botId, fingerprint: event.fingerprint,
          conversationId: event.conversation.id, actorId: event.actor.id } } : {}) });
      check();
      if (typeof result?.reply !== 'string' || !result.reply.trim() || result.reply.length > 4000) throw new Error('FEISHU_REPLY_INVALID');
      if (!store.saveFeishuReply(item.key, result.reply)) throw new Error('FEISHU_MESSAGE_CANCELED');
      check();
      if (!store.markFeishuSending(item.key)) throw new Error('FEISHU_MESSAGE_CANCELED');
      sending = true;
      const receipt = await transport.reply(event.reply, result.reply, { signal: taskController.signal, epoch: connection.epoch, recovered });
      if (receipt?.sent !== true || typeof receipt.messageId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(receipt.messageId)) {
        store.finishFeishuMessage(item.key, 'unknown', 'SEND_UNCONFIRMED');
      } else store.finishFeishuMessage(item.key, 'sent', '', { version: 1, messageId: receipt.messageId, conversationId: event.conversation.id });
    } catch {
      store.finishFeishuMessage(item.key, sending ? 'unknown' : taskController.signal.aborted ? 'canceled' : 'failed',
        sending ? 'SEND_UNCONFIRMED' : taskController.signal.aborted ? 'CANCELED' : 'CHAT_FAILED');
      report(sending ? 'SEND_UNCONFIRMED' : 'CHAT_FAILED');
    } finally {
      taskController.abort();
      if (controller === taskController) { controller = undefined; activeKey = ''; }
    }
  }
  function tick() {
    if (stopped || !started) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      while (!stopped && settings().enabled && transport.status().connected) {
        const item = store.listReceivedFeishuMessages(1)[0];
        if (!item) break;
        await process(item);
      }
    })().catch(() => report('PROCESS_FAILED')).finally(() => { running = undefined; });
    return running;
  }
  return {
    reserveChat() {
      const config = settings();
      if (stopped || !started || !config.enabled || !transport.status().connected) return { allowed: false };
      return store.reserveFeishuChat({ dailyLimit: config.dailyChatLimit });
    },
    status() {
      const config = settings(), day = new Date().toISOString().slice(0, 10);
      const saved = store.getSetting('feishuChatStatus', {}) || {};
      const attempts = saved.day === day && Number.isSafeInteger(saved.attempts) && saved.attempts >= 0 ? saved.attempts : 0;
      return { enabled: config.enabled, busy: Boolean(running), connected: transport.status().connected === true,
        pending: store.listReceivedFeishuMessages(100).length,
        chat: { day, timeZone: 'UTC', attempts, dailyLimit: config.dailyChatLimit, remaining: Math.max(0, config.dailyChatLimit - attempts) } };
    },
    start() { if (!started && !stopped) { store.recoverFeishuMessages(); started = true; } return tick(); },
    createBinding() {
      const config = settings(), connection = transport.status();
      if (stopped || !started || !config.enabled || !connection.connected || connection.botId !== config.botId
        || connection.fingerprint !== config.expectedFingerprint) throw new Error('请先连接并核对飞书机器人账号。');
      const code = randomBytes(9).toString('base64url');
      binding = { hash: createHash('sha256').update(code).digest(), expires: Date.now() + 10 * 60000,
        botId: config.botId, fingerprint: config.expectedFingerprint };
      return { command: `绑定 ${code}`, expiresAt: new Date(binding.expires).toISOString() };
    },
    receive(input) {
      if (stopped || !started) return { accepted: false };
      const config = settings();
      if (!config.enabled) return { accepted: true };
      let event;
      try { event = normalizeFeishuEvent(input, config); }
      catch { report('INVALID_EVENT'); return { accepted: false }; }
      const command = event.text.trim().match(/^(?:绑定|bind)\s+([A-Za-z0-9_-]{1,128})$/);
      if (command) {
        if (event.conversation.kind !== 'dm' || !binding || binding.expires <= Date.now() || binding.botId !== config.botId
          || binding.fingerprint !== config.expectedFingerprint || !timingSafeEqual(binding.hash, createHash('sha256').update(command[1]).digest())) return { accepted: true };
        try {
          const route = feishuConversation(event, { store, allowedUsers: [event.actor.id], allowedGroups: [] });
          controller?.abort(); cancelReceived();
          store.receiveFeishuMessage({ key: route.key, input: { ...event, text: '[创建人绑定命令，口令未保留]', control: 'owner-binding' }, scope: 'owner', actor: 'owner' });
          store.bindAccount({ platform: 'feishu', userId: route.accountId, personId: 'owner', label: '创建人飞书（私聊口令验证）' });
          onOwnerMessage();
          store.finishFeishuMessage(route.key, 'canceled', 'OWNER_BOUND');
          binding = undefined;
          return { accepted: true };
        } catch { report('BINDING_FAILED'); return { accepted: false }; }
      }
      const route = feishuConversation(event, { store, ...config });
      if (!route) return { accepted: true };
      try {
        const previous = store.getFeishuMessage(route.key);
        if (previous && (JSON.stringify(previous.input) !== JSON.stringify(event) || previous.scope !== route.scope || previous.actor !== route.actor)) {
          if (activeKey === route.key) controller?.abort();
          sourceEpochs.delete(route.key);
          store.finishFeishuMessage(route.key, 'canceled', 'SOURCE_CHANGED');
          report('SOURCE_CHANGED');
          return { accepted: true };
        }
        if (!previous && store.listReceivedFeishuMessages(100).length >= 100) return { accepted: false };
        const received = store.receiveFeishuMessage({ key: route.key, input: event, scope: route.scope, actor: route.actor });
        if (!previous && route.scope === 'owner' && route.actor === 'owner') onOwnerMessage();
        if (received.message.state === 'received') sourceEpochs.set(route.key, transport.status().epoch);
      } catch { report('INTAKE_FAILED'); return { accepted: false }; }
      queueMicrotask(tick);
      return { accepted: true };
    },
    tick,
    disconnect() { binding = undefined; controller?.abort(); },
    cancel() { binding = undefined; controller?.abort(); if (started) cancelReceived(); sourceEpochs.clear(); },
    async stop() { stopped = true; binding = undefined; controller?.abort(); if (started) cancelReceived(); sourceEpochs.clear(); await running; },
  };
}
