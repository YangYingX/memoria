import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeCompanionState } from '../src/companion-state.js';
import { normalizeMateInput, verifyMatePackage } from '../src/mate-runtime.js';

let started = false;
function finish(message) {
  if (!process.connected) return;
  process.send(message, () => { if (process.connected) process.disconnect(); });
}
process.on('disconnect', () => {});
process.on('message', async message => {
  if (started) return;
  started = true;
  try {
    if (Number(process.versions.node.split('.')[0]) !== 24 || !message || message.type !== 'start'
      || Object.keys(message).some(key => !['type', 'packageDirectory', 'input'].includes(key))
      || Buffer.byteLength(JSON.stringify(message)) > 2 * 1024 * 1024) throw new Error();
    const input = normalizeMateInput(message.input), packageDirectory = verifyMatePackage(message.packageDirectory);
    process.env.TZ = input.timeZone;
    // The original kernel is used without the bundle, session hooks, prompt sections or persistence.
    // These application guards are not an operating-system sandbox.
    globalThis.fetch = () => { throw new Error('MATE_NETWORK_DISABLED'); };
    globalThis.setInterval = () => { throw new Error('MATE_TIMERS_DISABLED'); };
    const kernel = await import(pathToFileURL(join(packageDirectory, 'packages', 'mate', 'src', 'index.ts')));
    let state = input.state ?? kernel.birth({ born: input.contacts[0]?.at ?? input.now, seed: 0x4d454d4f,
      personality: { o: 0.5, c: 0.5, e: 0.5, a: 0.5, n: 0.5 } });
    const clock = kernel.systemClock();
    const advance = t => {
      state = kernel.catchUp(state, clock, t).state;
      if (state.t !== t) state = kernel.transition(state, { kind: 'tick', activations: {}, intent: 'chat', t }).state;
    };
    for (const contact of input.contacts) {
      advance(contact.at);
      state = kernel.transition(state, { kind: 'user_message', activations: {}, intent: 'chat', t: contact.at }).state;
    }
    advance(input.now);
    // The canonical owner ledger supplies this counter; the original kernel never increments it.
    state = { ...state, relationship: { ...state.relationship, unanswered: input.unanswered } };
    const native = kernel.tick(state, input.now, { userActive: false, recentProactive: input.recentProactive }, undefined, 'zh');
    state = normalizeCompanionState(native.state);
    finish({ type: 'result', result: { state, action: native.decision.action,
      kind: native.decision.thought?.kind ?? null, urgency: native.decision.thought?.urgency ?? 0,
      inclination: kernel.replyInclination(state, 0, 'zh').value,
      fatigue: state.allostasis.fatigue, drowsiness: kernel.drowsinessOf(state, input.now) } });
  } catch (error) { finish({ type: 'failure', code: error?.code === 'INPUT_INVALID' ? 'INPUT_INVALID' : 'FAILED' }); }
});
