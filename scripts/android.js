import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { createAndroidRuntime } from '../src/android-runtime.js';
import { createMumuRuntime } from '../src/mumu-runtime.js';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = resolve(process.env.PERSONA_DATA_DIR || join(project, 'data'));
const actions = { check: 'check', inspect: 'inspectHeybox', profile: 'openHeyboxProfile', home: 'openHeyboxHome', settings: 'openHeyboxSettings', editor: 'openHeyboxEditor',
  compose: 'openHeyboxComposer',
  'profile-apply': 'updateHeyboxProfile', 'avatar-apply': 'updateHeyboxAvatar', 'avatar-access': 'inspectAvatarAccess', refresh: 'refreshHeybox', capture: 'captureHeybox',
  configure: 'configure', start: 'start', stop: 'stop', install: 'installHeybox', open: 'openHeybox', setup: 'setup' };
try {
  const command = process.argv[2] || 'check';
  if (!Object.hasOwn(actions, command) || process.argv.length > 3) throw new Error(`用法：node scripts/android.js ${Object.keys(actions).join('|')}`);
  let config = {};
  try { config = JSON.parse(readFileSync(join(data, 'android-runtime.json'), 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('安卓专用环境配置无法读取，请核对本机配置文件。'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('安卓专用环境配置必须是 JSON 对象。');
  const root = process.env.PERSONA_ANDROID_HOME || config.root;
  if (!root) throw new Error('尚未配置安卓专用环境；请设置 PERSONA_ANDROID_HOME，或在本机 data/android-runtime.json 中填写 root。');
  if (config.provider !== undefined && !['avd', 'mumu'].includes(config.provider)) throw new Error('未知的安卓设备类型，请核对 provider。');
  const runtime = config.provider === 'mumu' ? createMumuRuntime({ root, manager: config.manager, index: config.index,
    createdTimestamp: config.createdTimestamp, deviceName: config.deviceName, androidVersion: config.androidVersion,
    expectedAccountId: config.expectedAccountId, androidCli: config.androidCli }) : createAndroidRuntime({ root });
  if (command === 'configure' && !runtime.configure) throw new Error('configure 仅用于 MuMu 专用设备。');
  if (command === 'inspect' && !runtime.inspectHeybox) throw new Error('inspect 仅用于 MuMu 专用设备。');
  if (command === 'profile' && !runtime.openHeyboxProfile) throw new Error('profile 仅用于 MuMu 专用设备。');
  if (['home', 'settings', 'editor', 'compose', 'profile-apply', 'avatar-apply', 'avatar-access', 'refresh', 'capture'].includes(command) && !runtime[actions[command]]) throw new Error(`${command} 仅用于 MuMu 专用设备。`);
  if (command === 'setup') {
    console.log((await runtime.start()).message);
    const deadline = Date.now() + 180000;
    let state;
    do {
      state = await runtime.check();
      if (state.booted) break;
      await setTimeout(3000);
    } while (Date.now() < deadline);
    if (!state.booted) throw new Error('Android 尚未启动完成，请检查专用模拟器窗口与日志后重试。');
    if (!state.heyboxInstalled) console.log((await runtime.installHeybox()).message);
    console.log((await runtime.openHeybox()).message);
  } else console.log(JSON.stringify(await runtime[actions[command]](command === 'profile-apply' ? config.profile : command === 'avatar-apply' ? config.avatar : undefined), null, 2));
} catch (error) {
  console.error(error.message || '安卓操作未完成。');
  process.exitCode = 1;
}
