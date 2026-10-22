import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { freemem } from 'node:os';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { DOMParser } from 'linkedom';
import { androidDevice, verifyHeyboxApk } from './android-runtime.js';

function execute(file, args, options) {
  return new Promise(resolve => execFile(file, args, { timeout: 12000, maxBuffer: 1024 * 1024, windowsHide: true, ...options },
    (error, stdout, stderr) => resolve({ ok: !error, exitCode: error?.code ?? 0, stdout: String(stdout || ''), stderr: String(stderr || '') })));
}

export function createMumuRuntime({ root, manager, index, createdTimestamp, deviceName, androidVersion = '15', expectedAccountId, run = execute, availableMemory = freemem }) {
  for (const path of [root, manager]) {
    if (typeof path !== 'string' || !isAbsolute(path) || path.length > 2048 || path.includes('\0') || /^\\\\/.test(path)) {
      throw new Error('请配置 MuMu 管理工具与安卓资源的本机绝对路径。');
    }
  }
  if (basename(manager).toLowerCase() !== 'mumumanager.exe') throw new Error('MuMu 管理工具路径必须指向 MuMuManager.exe。');
  if (!['string', 'number'].includes(typeof index) || !/^(0|[1-9]\d{0,3})$/.test(String(index))) {
    throw new Error('请指定单个 MuMu 专用设备编号。');
  }
  if (!Number.isSafeInteger(createdTimestamp) || createdTimestamp <= 0 || typeof deviceName !== 'string'
    || !deviceName.trim() || deviceName.length > 128 || /[\x00-\x1f]/.test(deviceName) || !['12', '15'].includes(androidVersion)) {
    throw new Error('请核对 MuMu 专用设备的名称、创建时间和 Android 版本。');
  }
  if (expectedAccountId !== undefined && (typeof expectedAccountId !== 'string' || !/^\d{5,16}$/.test(expectedAccountId))) {
    throw new Error('请核对小黑盒专用账号 ID。');
  }
  root = resolve(root);
  manager = resolve(manager);
  index = String(index);
  let busy = false;
  const control = (...args) => ['control', '-v', index, '--version', androidVersion, ...args];
  const defaults = { performance_mode: 'custom', 'performance_cpu.custom': '2', 'performance_mem.custom': '2',
    resolution_mode: 'custom', 'resolution_width.custom': '720', 'resolution_height.custom': '1280', 'resolution_dpi.custom': '320' };
  async function request(args, { json = true, timeout = 12000 } = {}) {
    const result = await run(manager, args, { timeout, cwd: dirname(manager) });
    if (!result.ok) throw new Error('MuMu 管理命令未确认成功，请检查专用设备状态。');
    const text = result.stdout.replace(/^\uFEFF/, '').trim();
    if (!text && !json) return null;
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('MuMu 返回了无法核验的结果，本次操作未标记为完成。'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)
      || (Object.hasOwn(data, 'errcode') && data.errcode !== 0)
      || (Object.hasOwn(data, 'error_code') && data.error_code !== 0)) {
      throw new Error('MuMu 未确认操作成功，请检查专用设备状态。');
    }
    return data;
  }
  async function ownDevice() {
    const device = await request(['info', '-v', index]);
    if (device.error_code !== 0 || device.index !== index
      || device.created_timestamp !== createdTimestamp || device.name !== deviceName || device.android_version !== `${androidVersion}.0`) {
      throw new Error('MuMu 设备与本机绑定不一致，未执行后续操作。');
    }
    if (typeof device.is_process_started !== 'boolean' || typeof device.is_android_started !== 'boolean'
      || (device.is_android_started && !device.is_process_started)) {
      throw new Error('MuMu 设备状态尚无法核验，请稍后重试。');
    }
    return device;
  }
  async function check() {
    const configured = existsSync(manager);
    if (!configured) return { provider: 'mumu', configured, online: false, booted: false, heyboxInstalled: false,
      message: 'MuMu 官方管理工具尚未安装或路径不正确。' };
    const device = await ownDevice();
    let heyboxInstalled = false;
    let heyboxRunning = false;
    if (device.is_android_started) {
      const app = await request(control('app', 'info', '-pkg', androidDevice.package));
      if (!['running', 'stopped', 'not_installed'].includes(app.state)) throw new Error('小黑盒的安装状态尚无法核验。');
      heyboxInstalled = app.state !== 'not_installed';
      heyboxRunning = app.state === 'running';
    }
    return { provider: 'mumu', configured, index, deviceName, online: device.is_process_started, booted: device.is_android_started, heyboxInstalled, heyboxRunning,
      freeMemoryGiB: Math.round(availableMemory() / 1024 ** 3 * 10) / 10,
      message: device.is_android_started ? 'MuMu 专用设备已启动。' : device.is_process_started ? 'MuMu 专用设备正在启动。' : 'MuMu 专用设备当前未启动。' };
  }
  async function exclusive(action) {
    if (busy) throw new Error('已有安卓操作进行中，请稍后重试。');
    busy = true;
    try { return await action(); } finally { busy = false; }
  }
  async function readyDevice() {
    const device = await ownDevice();
    if (!device.is_android_started) throw new Error('MuMu 专用设备尚未完成启动，本次未执行操作。');
  }
  async function androidShell(command) {
    await readyDevice();
    const result = await run(manager, ['adb', '-v', index, '-c', `shell ${command}`], { timeout: 30000, cwd: dirname(manager) });
    const dump = command.match(/^uiautomator dump (\/data\/local\/tmp\/memoria-heybox-[0-9a-f-]+\.xml)$/)?.[1];
    // MuMu Android 15 can exit 139 after writing the dump. The caller still verifies the fresh XML.
    const completedDump = dump && result.exitCode === 139 && result.stdout.trim() === `UI hierchary dumped to: ${dump}`;
    if (!result.ok && !completedDump) throw new Error('Android 状态读取未成功，请检查 MuMu 专用设备。');
    return result.stdout;
  }
  async function readHeyboxView() {
    const activities = await androidShell('dumpsys activity activities');
    const resumed = activities.split(/\r?\n/).find(line => /^\s*(?:topResumedActivity|mResumedActivity|ResumedActivity)\s*[:=]/.test(line));
    const activity = resumed?.match(/\bcom\.max\.xiaoheihe\/[a-zA-Z0-9._$]+/)?.[0];
    if (!activity) throw new Error('请先在 MuMu 专用设备中打开小黑盒，当前未读取其他应用。');
    const snapshot = `/data/local/tmp/memoria-heybox-${randomUUID()}.xml`;
    try {
      await androidShell(`uiautomator dump ${snapshot}`);
      const xml = await androidShell(`cat ${snapshot}`);
      if (!xml.trim().endsWith('</hierarchy>')) throw new Error('Android 界面快照不完整，本次未读取账号资料。');
      const document = new DOMParser().parseFromString(xml, 'text/xml');
      const redact = value => (value || '').replace(/(?<!\d)1\d{10}(?!\d)/g, '[手机号已隐藏]').slice(0, 200);
      const nodes = Array.from(document.querySelectorAll('node')).filter(node => node.getAttribute('package') === androidDevice.package)
        .map(node => ({ id: node.getAttribute('resource-id') || '', text: node.getAttribute('password') === 'true' ? '[密码字段已隐藏]' : redact(node.getAttribute('text')),
          description: node.getAttribute('password') === 'true' ? '[密码字段已隐藏]' : redact(node.getAttribute('content-desc')),
          bounds: node.getAttribute('bounds') || '', clickable: node.getAttribute('clickable') === 'true' }))
        .filter(node => node.id || node.text || node.description).slice(0, 160);
      if (!nodes.length) throw new Error('没有取得小黑盒的可核验界面，本次未读取账号资料。');
      return { source: 'android_ui', package: androidDevice.package, activity, nodes };
    } finally {
      await androidShell(`rm -f ${snapshot}`);
    }
  }
  async function tapHeyboxNode(view, id) {
    const matches = view.nodes.filter(node => node.id === id && node.clickable);
    if (matches.length !== 1) throw new Error('没有唯一可核验的小黑盒资料入口，本次未点击。');
    const bounds = matches[0].bounds.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/)?.slice(1).map(Number);
    if (!bounds || bounds[0] >= bounds[2] || bounds[1] >= bounds[3] || bounds.some(value => value > 8192)) {
      throw new Error('小黑盒资料入口的位置无法核验，本次未点击。');
    }
    const activities = await androidShell('dumpsys activity activities');
    const resumed = activities.split(/\r?\n/).find(line => /^\s*(?:topResumedActivity|mResumedActivity|ResumedActivity)\s*[:=]/.test(line));
    const currentActivity = resumed?.match(/\bcom\.max\.xiaoheihe\/[a-zA-Z0-9._$]+/)?.[0];
    if (currentActivity !== view.activity) throw new Error('小黑盒当前界面已变化，请重新读取。');
    await androidShell(`input tap ${Math.floor((bounds[0] + bounds[2]) / 2)} ${Math.floor((bounds[1] + bounds[3]) / 2)}`);
  }
  function profileResult(view) {
    const ids = view.nodes.filter(node => node.id === `${androidDevice.package}:id/tv_user_id` && /^\d{5,16}$/.test(node.text));
    if (view.activity !== `${androidDevice.package}/.MainActivity` || ids.length !== 1) throw new Error('没有读取到可核验的小黑盒账号 ID。');
    const accountId = ids[0].text;
    if (expectedAccountId && accountId !== expectedAccountId) throw new Error('当前小黑盒账号与本机绑定不一致，未执行后续操作。');
    return { ...view, accountId, accountVerified: Boolean(expectedAccountId) };
  }
  return {
    check,
    inspectHeybox: () => exclusive(readHeyboxView),
    openHeyboxProfile: () => exclusive(async () => {
      let view = await readHeyboxView();
      if (view.nodes.some(node => node.id === `${androidDevice.package}:id/tv_user_id` && /^\d{5,16}$/.test(node.text))) return profileResult(view);
      for (let step = 0; step < 2 && view.activity === `${androidDevice.package}/.module.account.GameAccountActivityV2`; step++) {
        await androidShell('input keyevent 4');
        view = await readHeyboxView();
      }
      if (view.activity !== `${androidDevice.package}/.MainActivity`) throw new Error('请先在小黑盒打开“我”页面，再读取个人主页。');
      if (!view.nodes.some(node => node.id === `${androidDevice.package}:id/tv_me_home_fragment_username`)) {
        await tapHeyboxNode(view, `${androidDevice.package}:id/rb_5`);
        view = await readHeyboxView();
      }
      await tapHeyboxNode(view, `${androidDevice.package}:id/tv_me_home_fragment_username`);
      return profileResult(await readHeyboxView());
    }),
    configure: () => exclusive(async () => {
      const device = await ownDevice();
      if (device.is_process_started) throw new Error('请先关闭 MuMu 专用设备，再调整启动配置。');
      await request(['setting', '-v', index, ...Object.entries(defaults).flatMap(([key, value]) => ['-k', key, '-val', value])], { json: false });
      const settings = await request(['setting', '-v', index, ...Object.keys(defaults).flatMap(key => ['-k', key])]);
      if (Object.entries(defaults).some(([key, value]) => key.endsWith('.custom')
        ? !['string', 'number'].includes(typeof settings[key]) || Number(settings[key]) !== Number(value) : settings[key] !== value)) {
        throw new Error('MuMu 启动配置未通过回读核验，请检查设备设置。');
      }
      await ownDevice();
      return { configured: true, message: 'MuMu 专用设备已设为 2 核、2 GiB 内存、720 × 1280 分辨率。' };
    }),
    start: () => exclusive(async () => {
      const state = await check();
      if (!state.configured) throw new Error(state.message);
      if (state.online) return { ...state, started: false };
      const settings = await request(['setting', '-v', index, '-k', 'performance_mode', '-k', 'performance_mem.custom']);
      const memory = settings['performance_mem.custom'];
      const memoryGiB = Number(memory);
      if (settings.performance_mode !== 'custom' || !['string', 'number'].includes(typeof memory)
        || !Number.isFinite(memoryGiB) || memoryGiB < 0.5 || memoryGiB > 32) {
        throw new Error('请先在 MuMu 专用设备中设置自定义性能和内存额度，再启动。');
      }
      if (availableMemory() < (memoryGiB + 1) * 1024 ** 3) throw new Error('当前可用内存不足以启动 MuMu 专用设备，请先腾出内存。');
      const current = await ownDevice();
      if (current.is_process_started) return { ...await check(), started: false };
      await request(control('launch'), { json: false });
      return { ...state, started: true, message: '已请求启动 MuMu 专用设备；请稍后检查 Android 是否启动完成。' };
    }),
    stop: () => exclusive(async () => {
      const device = await ownDevice();
      if (!device.is_process_started) return { stopRequested: false, stopped: false, message: 'MuMu 专用设备当前未启动。' };
      await request(control('shutdown'), { json: false });
      const current = await ownDevice();
      return { stopRequested: true, stopped: !current.is_process_started,
        message: current.is_process_started ? '已请求关闭 MuMu 专用设备；关闭尚未完成。' : 'MuMu 专用设备已关闭。' };
    }),
    installHeybox: () => exclusive(async () => {
      const apk = verifyHeyboxApk(root);
      await readyDevice();
      await request(control('app', 'install', '-apk', apk), { json: false, timeout: 180000 });
      const state = await check();
      if (!state.heyboxInstalled) throw new Error('未核验到小黑盒安装结果，本次安装未标记为完成。');
      return { ...state, message: '小黑盒已安装到 MuMu 专用设备。' };
    }),
    openHeybox: () => exclusive(async () => {
      const state = await check();
      if (!state.booted || !state.heyboxInstalled) throw new Error('请先完成 MuMu 专用设备启动和小黑盒安装。');
      await readyDevice();
      await request(control('app', 'launch', '-pkg', androidDevice.package), { json: false });
      return { launchRequested: true, message: '已请求打开小黑盒；请在 MuMu 专用设备窗口确认界面，并完成首次登录及验证。' };
    }),
  };
}
