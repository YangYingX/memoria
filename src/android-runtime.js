import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { freemem } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const androidDevice = Object.freeze({ name: 'MemoriaHeybox', serial: 'emulator-5580', port: 5580, adbPort: 5038, package: 'com.max.xiaoheihe' });
const MIN_FREE_BYTES = 3 * 1024 ** 3;

function execute(file, args, options) {
  return new Promise(resolve => execFile(file, args, { timeout: 12000, maxBuffer: 1024 * 1024, windowsHide: true, ...options },
    (error, stdout, stderr) => resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || '') })));
}

export function verifyHeyboxApk(root) {
  const apk = join(root, 'downloads', 'heybox-release.apk');
  if (!existsSync(apk)) throw new Error('请先准备官方小黑盒安装包。');
  let packageInfo;
  try { packageInfo = JSON.parse(readFileSync(join(root, 'downloads', 'heybox-package.json'), 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('小黑盒安装包尚未完成来源和包名核验。'); }
  if (packageInfo?.package !== androidDevice.package || packageInfo.source !== 'https://dl.max-c.com/app/heybox/heybox-release.apk'
    || !/^[0-9a-f]{64}$/.test(packageInfo.sha256)
    || createHash('sha256').update(readFileSync(apk)).digest('hex') !== packageInfo.sha256) {
    throw new Error('小黑盒安装包与已核验版本不一致，本次未安装。');
  }
  return apk;
}

export function createAndroidRuntime({ root, run = execute, launch = spawn, availableMemory = freemem }) {
  if (typeof root !== 'string' || !isAbsolute(root) || root.length > 2048 || root.includes('\0') || /^\\\\/.test(root)) {
    throw new Error('请配置安卓专用环境的本机绝对目录。');
  }
  root = resolve(root);
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const paths = { root, sdk: join(root, 'sdk'), avd: join(root, 'avd'), user: join(root, 'user'), logs: join(root, 'logs'),
    adb: join(root, 'sdk', 'platform-tools', `adb${suffix}`), emulator: join(root, 'sdk', 'emulator', `emulator${suffix}`),
    device: join(root, 'avd', `${androidDevice.name}.avd`, 'config.ini'), apk: join(root, 'downloads', 'heybox-release.apk') };
  const env = () => ({ ...process.env, ANDROID_HOME: paths.sdk, ANDROID_SDK_ROOT: paths.sdk,
    ANDROID_AVD_HOME: paths.avd, ANDROID_USER_HOME: paths.user,
    ANDROID_ADB_SERVER_PORT: String(androidDevice.adbPort), ANDROID_ADB_SERVER_ADDRESS: '127.0.0.1',
    ADB_SERVER_SOCKET: `tcp:127.0.0.1:${androidDevice.adbPort}`, ADB_MDNS_AUTO_CONNECT: '0' });
  let busy = false;
  const serverArgs = ['-H', '127.0.0.1', '-P', String(androidDevice.adbPort)];
  const adb = (args, options) => run(paths.adb, [...serverArgs, '-s', androidDevice.serial, ...args], { env: env(), ...options });
  const requiredFiles = () => [paths.adb, paths.emulator, paths.device].every(existsSync);
  async function ownDevice() {
    const serverEnv = env();
    delete serverEnv.ADB_SERVER_SOCKET;
    delete serverEnv.ANDROID_ADB_SERVER_ADDRESS;
    delete serverEnv.ANDROID_ADB_SERVER_PORT;
    const server = await run(paths.adb, ['-L', `tcp:localhost:${androidDevice.adbPort}`, '--one-device', androidDevice.serial, 'start-server'], { env: serverEnv });
    if (!server.ok) throw new Error('专用安卓调试服务没有启动，请检查 5038 端口。');
    const state = await adb(['get-state']);
    if (!state.ok || state.stdout.trim() !== 'device') return false;
    const name = await adb(['emu', 'avd', 'name']);
    const identity = name.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean).join('\n');
    if (!name.ok || identity !== `${androidDevice.name}\nOK`) {
      const current = await adb(['get-state']);
      if (!current.ok || current.stdout.trim() !== 'device') return false;
      if (!name.ok || !identity || identity === 'OK' || identity === androidDevice.name) {
        throw new Error('专用设备身份查询暂未完成，请稍后重新检查。');
      }
      throw new Error('设备端口不是栖忆的专用虚拟设备，未执行操作。');
    }
    return true;
  }
  async function deviceStatus() {
    if (!existsSync(paths.adb)) return { online: false, booted: false, heyboxInstalled: false };
    const online = await ownDevice();
    if (!online) return { online: false, booted: false, heyboxInstalled: false };
    const boot = await adb(['shell', 'getprop', 'sys.boot_completed']);
    const installed = await adb(['shell', 'pm', 'path', androidDevice.package]);
    return { online, booted: boot.ok && boot.stdout.trim() === '1',
      heyboxInstalled: installed.ok && /^package:\//m.test(installed.stdout) };
  }
  async function check() {
    const configured = requiredFiles();
    if (!configured) return { configured, online: false, booted: false, heyboxInstalled: false, accelerationReady: false,
      message: '专用安卓组件或虚拟设备尚未安装完整。' };
    const acceleration = await run(paths.emulator, ['-accel-check'], { env: env() });
    const device = await deviceStatus();
    return { configured, ...device, accelerationReady: acceleration.ok,
      freeMemoryGiB: Math.round(availableMemory() / 1024 ** 3 * 10) / 10,
      message: !acceleration.ok ? process.platform === 'win32'
        ? '硬件加速尚不可用；请核对 Windows Hypervisor Platform，并在需要时重启电脑。'
        : '硬件加速尚不可用；请核对 KVM 和当前用户的访问权限。'
        : device.booted ? '栖忆专用虚拟设备已启动。' : device.online ? '虚拟设备正在启动。' : '专用组件已准备，可按需启动。' };
  }
  async function exclusive(action) {
    if (busy) throw new Error('已有安卓操作进行中，请稍后重试。');
    busy = true;
    try { return await action(); } finally { busy = false; }
  }
  return {
    check,
    start: () => exclusive(async () => {
      const state = await check();
      if (!state.configured || !state.accelerationReady) throw new Error(state.message);
      if (state.online) return { ...state, started: false };
      if (availableMemory() < MIN_FREE_BYTES) throw new Error('当前可用内存不足 3 GiB；请先关闭部分应用，再启动专用模拟器。');
      mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
      const output = openSync(join(paths.logs, 'emulator.log'), 'a', 0o600);
      const error = openSync(join(paths.logs, 'emulator.err.log'), 'a', 0o600);
      try {
        const child = launch(paths.emulator, ['-avd', androidDevice.name, '-port', String(androidDevice.port),
          '-accel', 'on', '-memory', '2048', '-cores', '2', '-gpu', 'auto', '-no-audio', '-no-boot-anim', '-no-snapshot', '-no-metrics',
          '-camera-back', 'none', '-camera-front', 'none'],
        { env: env(), cwd: root, detached: true, windowsHide: false, stdio: ['ignore', output, error] });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new Error('专用模拟器启动失败，请检查运行日志。'))); });
        child.unref();
        return { ...state, started: true, message: '专用模拟器已发起启动；请稍后检查 Android 是否启动完成。' };
      } finally { closeSync(output); closeSync(error); }
    }),
    stop: () => exclusive(async () => {
      if (!existsSync(paths.adb) || !(await ownDevice())) return { stopped: false, message: '专用设备当前不在线。' };
      const result = await adb(['emu', 'kill']);
      if (!result.ok) throw new Error('专用设备没有确认关闭，请检查模拟器窗口。');
      return { stopped: true, message: '已请求关闭栖忆的专用虚拟设备。' };
    }),
    installHeybox: () => exclusive(async () => {
      if (!requiredFiles() || !existsSync(paths.apk)) throw new Error('请先准备官方小黑盒安装包及专用安卓环境。');
      verifyHeyboxApk(root);
      const state = await deviceStatus();
      if (!state.online || !state.booted) throw new Error('请先启动栖忆专用虚拟设备，等待 Android 完成启动。');
      if (!(await ownDevice())) throw new Error('专用设备已离线，本次未安装。');
      const result = await adb(['install', '-r', paths.apk], { timeout: 180000 });
      if (!result.ok || !/\bSuccess\b/.test(result.stdout)) throw new Error('小黑盒安装未确认成功，请检查安装包与虚拟设备的兼容性。');
      const installed = await deviceStatus();
      if (!installed.heyboxInstalled) throw new Error('未核验到小黑盒包名，本次安装未标记为完成。');
      return { ...installed, message: '小黑盒已安装到栖忆专用虚拟设备。' };
    }),
    openHeybox: () => exclusive(async () => {
      const state = await deviceStatus();
      if (!state.booted || !state.heyboxInstalled) throw new Error('请先完成专用设备启动和小黑盒安装。');
      const resolved = await adb(['shell', 'cmd', 'package', 'resolve-activity', '--brief', androidDevice.package]);
      const activity = resolved.stdout.trim().split(/\r?\n/).find(line => /^com\.max\.xiaoheihe\/[a-zA-Z0-9._]+$/.test(line));
      if (!resolved.ok || !activity) throw new Error('没有取得小黑盒的有效启动入口。');
      if (!(await ownDevice())) throw new Error('专用设备已离线，本次未打开应用。');
      const opened = await adb(['shell', 'am', 'start', '-n', activity]);
      if (!opened.ok || /Error:|Exception/i.test(opened.stdout + opened.stderr)) throw new Error('未确认小黑盒已打开。');
      return { launchRequested: true, message: '已请求打开小黑盒；请在专用设备窗口确认界面，并完成首次登录及验证。' };
    }),
  };
}
