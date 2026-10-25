import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { DOMParser } from 'linkedom';
import { androidDevice, verifyHeyboxApk } from './android-runtime.js';
import { createHeyboxPostJournal, validateHeyboxPost, verifyHeyboxPostView } from './heybox-post.js';
import { parseHeyboxComments, validateHeyboxComment, verifyHeyboxComment } from './heybox-comment.js';

const POST_PAGES = new Set(['PicturePostPageActivityV2', 'WebNewsPostPageActivityV2']
  .map(name => `${androidDevice.package}/.module.bbs.post.ui.activitys.v2.${name}`));

function execute(file, args, options) {
  return new Promise(resolve => execFile(file, args, { timeout: 12000, maxBuffer: 1024 * 1024, windowsHide: true, ...options },
    (error, stdout, stderr) => resolve({ ok: !error, exitCode: error?.code ?? 0, stdout: String(stdout || ''), stderr: String(stderr || '') })));
}

export function createMumuRuntime({ root, manager, index, createdTimestamp, deviceName, androidVersion = '15', expectedAccountId, androidCli, run = execute, availableMemory = freemem }) {
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
  androidCli ??= join(root, 'user', 'bin', 'android-cli.exe');
  if (typeof androidCli !== 'string' || !isAbsolute(androidCli) || androidCli.includes('\0') || /^\\\\/.test(androidCli)
    || !['android-cli.exe', 'android.exe'].includes(basename(androidCli).toLowerCase())) throw new Error('请核对本机 Google Android CLI 路径。');
  const sdk = join(root, 'sdk');
  const adb = join(sdk, 'platform-tools', 'adb.exe');
  const avatarStatePath = join(root, 'user', 'heybox-avatar-state.json');
  const operationLockPath = join(root, 'user', `mumu-operation-${index}-${createdTimestamp}.lock`);
  const postJournal = expectedAccountId ? createHeyboxPostJournal({ path: join(root, 'user', `heybox-post-${index}-${createdTimestamp}-${expectedAccountId}.json`),
    accountId: expectedAccountId, index, createdTimestamp }) : null;
  let busy = false;
  let sdkConnection;
  const control = (...args) => ['control', '-v', index, '--version', androidVersion, ...args];
  const defaults = { performance_mode: 'custom', 'performance_cpu.custom': '2', 'performance_mem.custom': '2',
    resolution_mode: 'custom', 'resolution_width.custom': '720', 'resolution_height.custom': '1280', 'resolution_dpi.custom': '320' };
  const avatarPermissionMessages = ['要允许“小黑盒”访问此设备上的照片和视频吗？', '允许小黑盒访问此设备上的更多照片和视频？'];
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
    let token;
    try { token = acquireOperationLock(); return await action(); }
    finally {
      try {
        if (token && existsSync(operationLockPath) && JSON.parse(readFileSync(operationLockPath, 'utf8')).token === token) unlinkSync(operationLockPath);
      } finally { busy = false; }
    }
  }
  function acquireOperationLock() {
    mkdirSync(dirname(operationLockPath), { recursive: true, mode: 0o700 });
    const token = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(operationLockPath, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
        return token;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let previous, raw;
        try {
          if (statSync(operationLockPath).size > 4096) throw new Error();
          raw = readFileSync(operationLockPath, 'utf8'); previous = JSON.parse(raw);
          if (!Number.isSafeInteger(previous.pid) || previous.pid < 1 || typeof previous.token !== 'string'
            || !/^[0-9a-f-]{36}$/.test(previous.token)) throw new Error();
        } catch { throw new Error('安卓操作锁暂时无法核验，请稍后重试；持续出现时请检查本机锁文件。'); }
        try { process.kill(previous.pid, 0); }
        catch (probe) {
          if (probe.code === 'ESRCH' && readFileSync(operationLockPath, 'utf8') === raw) { unlinkSync(operationLockPath); continue; }
        }
        throw new Error('另一个项目进程正在使用专用安卓设备，请稍后重试。');
      }
    }
    throw new Error('未取得专用安卓设备的操作锁。');
  }
  async function readyDevice() {
    const device = await ownDevice();
    if (!device.is_android_started) throw new Error('MuMu 专用设备尚未完成启动，本次未执行操作。');
  }
  async function androidShell(command, { signal, beforeSend, assertActive, onDispatch } = {}) {
    await readyDevice();
    signal?.throwIfAborted();
    if (beforeSend) {
      if (await beforeSend() === false) throw new Error('小黑盒发布前检查未通过，未执行提交命令。');
      await readyDevice();
    }
    signal?.throwIfAborted(); assertActive?.(); onDispatch?.();
    const result = await run(manager, ['adb', '-v', index, '-c', `shell ${command}`], { timeout: 30000, cwd: dirname(manager) });
    const dump = command.match(/^uiautomator dump (\/data\/local\/tmp\/memoria-heybox-[0-9a-f-]+\.xml)$/)?.[1];
    // MuMu Android 15 can exit 139 after writing the dump. The caller still verifies the fresh XML.
    const completedDump = dump && result.exitCode === 139 && result.stdout.trim() === `UI hierchary dumped to: ${dump}`;
    if (!result.ok && !completedDump) throw new Error('Android 状态读取未成功，请检查 MuMu 专用设备。');
    return result.stdout;
  }
  async function readHeyboxView() {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await readHeyboxViewOnce(); }
      catch (error) {
        if (attempt === 2 || !/读取时小黑盒界面已变化|没有取得专用小黑盒的活动窗口/.test(error.message)) throw error;
        await setTimeout(300);
      }
    }
  }
  async function readHeyboxViewOnce() {
    const activities = await androidShell('dumpsys activity activities');
    const resumed = activities.split(/\r?\n/).find(line => /^\s*(?:topResumedActivity|mResumedActivity|ResumedActivity)\s*[:=]/.test(line));
    const activity = resumed?.match(/\bcom\.max\.xiaoheihe\/[a-zA-Z0-9._$]+/)?.[0];
    if (!activity) throw new Error('请先在 MuMu 专用设备中打开小黑盒，当前未读取其他应用。');
    const redact = (value, limit = 200) => String(value || '').replace(/(?<!\d)1\d{10}(?!\d)/g, '[手机号已隐藏]').slice(0, limit);
    if (existsSync(adb) && existsSync(androidCli)) {
      // Input and layout share the CLI's instrumentation connection; standalone uiautomator competes with it.
      // Animated composer hints may never become idle; activity and fields are checked again after the read.
      const result = await sdkCommand(serial => ['layout', `--device=${serial}`, '--flat', '--full', '--no-idle']);
      let windows;
      try { windows = JSON.parse(result.stdout); } catch { throw new Error('Android CLI 界面结果无法解析。'); }
      const active = Array.isArray(windows) ? windows.filter(window => window.type === 'APPLICATION' && window.active === true && window.focused === true) : [];
      const avatarAccessDialog = activity === `${androidDevice.package}/.module.account.UpdateAccountActivity`
        && active.length === 1 && Array.isArray(active[0].content)
        && active[0].content.some(node => node['resource-id'] === 'android:id/message' && node.text === '【图片选择器需要授予访问存储权限】');
      if (active.length !== 1 || !Array.isArray(active[0].content)
        || (!avatarAccessDialog && !active[0].content.some(node => node['resource-id']?.startsWith(`${androidDevice.package}:id/`)))) {
        throw new Error('没有取得专用小黑盒的活动窗口，本次未读取其他应用。');
      }
      const nodes = active[0].content.filter(node => !node.hidden && !node['off-screen'])
        .filter(node => !node['resource-id'] || node['resource-id'].startsWith(`${androidDevice.package}:id/`) || node['resource-id'].startsWith('android:id/'))
        .map(node => {
          const password = node.password === true || node.state?.includes('PASSWORD') || /password|pwd/i.test(node['resource-id'] || '')
            || (/login|register|password/i.test(activity) && node.class === 'android.widget.EditText');
          const readingBody = POST_PAGES.has(activity) && (node['resource-id'] === `${androidDevice.package}:id/tv_desc`
            || (!node['resource-id'] && node.class === 'android.widget.TextView'));
          const draftBody = activity === `${androidDevice.package}/.module.bbs.post_edit.PostTabActivity` && node['resource-id'] === `${androidDevice.package}:id/et_content`;
          const commentBody = POST_PAGES.has(activity) && ['tv_comment', 'tv_sub_comment_content', 'tv_editor_comment_reply_msg'].some(id => node['resource-id'] === `${androidDevice.package}:id/${id}`);
          const limit = readingBody ? 8000 : draftBody ? 1600 : commentBody ? 1200 : 200;
          return { id: node['resource-id'] || '', text: password ? '[密码字段已隐藏]' : redact(node.text, limit), truncated: String(node.text || '').length > limit,
            description: password ? '[密码字段已隐藏]' : redact(node['content-desc']), bounds: node.bounds || '', className: node.class || '',
            clickable: node.interactions?.includes('CLICKABLE') === true, focused: node.state?.includes('FOCUSED') === true,
            enabled: node.enabled !== false && !node.state?.includes('DISABLED') };
        }).filter(node => node.id || node.text || node.description || node.clickable || node.className === 'android.webkit.WebView').slice(0, 160);
      const current = await androidShell('dumpsys activity activities');
      const currentResumed = current.split(/\r?\n/).find(line => /^\s*(?:topResumedActivity|mResumedActivity|ResumedActivity)\s*[:=]/.test(line));
      if (!nodes.length || currentResumed?.match(/\bcom\.max\.xiaoheihe\/[a-zA-Z0-9._$]+/)?.[0] !== activity) {
        throw new Error('读取时小黑盒界面已变化，请重新读取。');
      }
      return { source: 'android_ui', package: androidDevice.package, activity, nodes };
    }
    const snapshot = `/data/local/tmp/memoria-heybox-${randomUUID()}.xml`;
    try {
      await androidShell(`uiautomator dump ${snapshot}`);
      const xml = await androidShell(`cat ${snapshot}`);
      if (!xml.trim().endsWith('</hierarchy>')) throw new Error('Android 界面快照不完整，本次未读取账号资料。');
      // Read the flattened UI nodes with decoded attribute entities; linkedom XML mode preserves &amp; and &lt;.
      const document = new DOMParser().parseFromString(xml, 'text/html');
      const nodes = Array.from(document.querySelectorAll('node')).filter(node => node.getAttribute('package') === androidDevice.package)
        .map(node => ({ id: node.getAttribute('resource-id') || '', text: node.getAttribute('password') === 'true' ? '[密码字段已隐藏]' : redact(node.getAttribute('text')),
          truncated: String(node.getAttribute('text') || '').length > 200,
          description: node.getAttribute('password') === 'true' ? '[密码字段已隐藏]' : redact(node.getAttribute('content-desc')),
            bounds: node.getAttribute('bounds') || '', className: node.getAttribute('class') || '',
            clickable: node.getAttribute('clickable') === 'true', focused: node.getAttribute('focused') === 'true',
            enabled: node.getAttribute('enabled') === 'true' }))
        .filter(node => node.id || node.text || node.description || node.clickable).slice(0, 160);
      if (!nodes.length) throw new Error('没有取得小黑盒的可核验界面，本次未读取账号资料。');
      return { source: 'android_ui', package: androidDevice.package, activity, nodes };
    } finally {
      await androidShell(`rm -f ${snapshot}`);
    }
  }
  async function tapHeyboxNode(view, id, options) {
    const matches = view.nodes.filter(node => node.id === id && node.clickable);
    if (matches.length !== 1) throw new Error('没有唯一可核验的小黑盒资料入口，本次未点击。');
    return tapHeyboxTarget(view, matches[0], options);
  }
  async function tapHeyboxLabel(view, text, resourceId = '', options) {
    const labels = view.nodes.filter(node => node.text === text && (!resourceId || node.id === resourceId));
    if (labels.length !== 1) throw new Error('没有唯一可核验的小黑盒菜单文字，本次未点击。');
    const bounds = value => value.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/)?.slice(1).map(Number);
    const label = bounds(labels[0].bounds);
    if (!label) throw new Error('小黑盒菜单文字的位置无法核验。');
    const candidates = view.nodes.filter(node => node.clickable && node.enabled).map(node => ({ node, box: bounds(node.bounds) }))
      .filter(({ box }) => box && box[0] <= label[0] && box[1] <= label[1] && box[2] >= label[2] && box[3] >= label[3])
      .map(item => ({ ...item, area: (item.box[2] - item.box[0]) * (item.box[3] - item.box[1]) })).sort((a, b) => a.area - b.area);
    if (!candidates.length || candidates[0].area === candidates[1]?.area) throw new Error('小黑盒菜单点击区域不唯一。');
    return tapHeyboxTarget(view, candidates[0].node, options);
  }
  async function tapHeyboxTarget(view, node, options) {
    const bounds = node.bounds.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/)?.slice(1).map(Number);
    if (!bounds || bounds[0] >= bounds[2] || bounds[1] >= bounds[3] || bounds.some(value => value > 8192)) {
      throw new Error('小黑盒资料入口的位置无法核验，本次未点击。');
    }
    const activities = await androidShell('dumpsys activity activities');
    const resumed = activities.split(/\r?\n/).find(line => /^\s*(?:topResumedActivity|mResumedActivity|ResumedActivity)\s*[:=]/.test(line));
    const currentActivity = resumed?.match(/\b[a-zA-Z][\w.]+\/[a-zA-Z0-9._$]+/)?.[0];
    if (currentActivity !== view.activity) throw new Error('小黑盒当前界面已变化，请重新读取。');
    await androidShell(`input tap ${Math.floor((bounds[0] + bounds[2]) / 2)} ${Math.floor((bounds[1] + bounds[3]) / 2)}`, options);
  }
  async function closeAvatarMenu(view) {
    if (view.activity === `${androidDevice.package}/.module.account.UpdateAccountActivity`
      && view.nodes.some(node => node.id === 'android:id/message' && node.text === '【图片选择器需要授予访问存储权限】')) {
      await tapHeyboxNode(view, 'android:id/button2');
      return readHeyboxView();
    }
    if (view.activity === `${androidDevice.package}/.module.account.UpdateAccountActivity`
      && ['更换头像', '更换头像框'].every(text => view.nodes.some(node => node.text === text))) {
      await tapHeyboxNode(view, `${androidDevice.package}:id/cv_cancel`);
      return readHeyboxView();
    }
    return view;
  }
  function profileResult(view) {
    const ids = view.nodes.filter(node => node.id === `${androidDevice.package}:id/tv_user_id` && /^\d{5,16}$/.test(node.text));
    if (view.activity !== `${androidDevice.package}/.MainActivity` || ids.length !== 1) throw new Error('没有读取到可核验的小黑盒账号 ID。');
    const accountId = ids[0].text;
    if (expectedAccountId && accountId !== expectedAccountId) throw new Error('当前小黑盒账号与本机绑定不一致，未执行后续操作。');
    return { ...view, accountId, accountVerified: Boolean(expectedAccountId) };
  }
  async function openHeyboxProfile() {
    let view = await closeAvatarMenu(await readHeyboxView());
    if (POST_PAGES.has(view.activity)) view = await closeEmptyCommentEditor(view);
    if (view.activity === `${androidDevice.package}/.MainActivity`
      && view.nodes.some(node => node.id === `${androidDevice.package}:id/tv_title` && node.text === '要继续编辑作品吗？')
      && view.nodes.some(node => node.id === `${androidDevice.package}:id/tv_negative_button` && node.text === '存草稿')) {
      await tapHeyboxNode(view, `${androidDevice.package}:id/tv_negative_button`);
      view = await readHeyboxView();
    }
    if (POST_PAGES.has(view.activity)) {
      await tapHeyboxNode(view, `${androidDevice.package}:id/iv_appbar_nav_button`);
      view = await readHeyboxView();
    }
    if (view.activity === `${androidDevice.package}/.module.bbs.post_edit.PostTabActivity`
      && view.nodes.some(node => node.id === `${androidDevice.package}:id/et_title` && ['', '填写标题'].includes(node.text))
      && view.nodes.some(node => node.id === `${androidDevice.package}:id/et_content` && ['', '添加正文'].includes(node.text))) {
      await tapHeyboxNode(view, `${androidDevice.package}:id/iv_appbar_nav_button`);
      view = await readHeyboxView();
    }
    if (view.nodes.some(node => node.id === `${androidDevice.package}:id/tv_user_id` && /^\d{5,16}$/.test(node.text))) return profileResult(view);
    for (let step = 0; step < 2 && [`${androidDevice.package}/.module.account.UpdateAccountActivity`, `${androidDevice.package}/.module.account.SettingActivity`].includes(view.activity); step++) {
      await tapHeyboxNode(view, `${androidDevice.package}:id/iv_appbar_nav_button`);
      view = await readHeyboxView();
    }
    for (let step = 0; step < 2 && view.activity === `${androidDevice.package}/.module.account.GameAccountActivityV2`; step++) {
      await androidShell('input keyevent 4');
      view = await readHeyboxView();
    }
    if (view.activity !== `${androidDevice.package}/.MainActivity`) throw new Error('请先在小黑盒打开“我”页面，再读取个人主页。');
    if (view.nodes.some(node => node.id === `${androidDevice.package}:id/tv_title` && node.text === '签到成功!')) {
      const titles = view.nodes.filter(node => node.id === `${androidDevice.package}:id/tv_title`);
      const confirms = view.nodes.filter(node => node.id === `${androidDevice.package}:id/tv_confirm`);
      const reward = id => view.nodes.filter(node => node.id === `${androidDevice.package}:id/${id}`);
      if (titles.length !== 1 || confirms.length !== 1 || confirms[0].text !== '确定' || !confirms[0].enabled
        || ['tv_hcoin', 'tv_exp'].some(id => reward(id).length !== 1 || !/^\+\d{1,6}$/.test(reward(id)[0].text))
        || reward('tv_streak').length !== 1 || !/^已签到 \d{1,6} 天$/.test(reward('tv_streak')[0].text)
        || view.nodes.some(node => node.className === 'android.widget.EditText')) throw new Error('签到提示无法唯一核对，本次未关闭。');
      await tapHeyboxNode(view, `${androidDevice.package}:id/tv_confirm`);
      view = await readHeyboxView();
    }
    if (view.nodes.some(node => node.id === `${androidDevice.package}:id/tv_title` && node.text === '绑定Steam领取5元优惠券')) {
      await tapHeyboxNode(view, `${androidDevice.package}:id/iv_close`);
      view = await readHeyboxView();
    }
    if (!view.nodes.some(node => node.id === `${androidDevice.package}:id/tv_me_home_fragment_username`)) {
      await tapHeyboxNode(view, `${androidDevice.package}:id/rb_5`);
      view = await readHeyboxView();
    }
    await tapHeyboxNode(view, `${androidDevice.package}:id/tv_me_home_fragment_username`);
    return profileResult(await readHeyboxView());
  }
  async function ownProfileHome() {
    if (!expectedAccountId) throw new Error('请先在本机配置中绑定小黑盒专用账号 ID。');
    const profile = await openHeyboxProfile();
    if (!profile.accountVerified) throw new Error('小黑盒专用账号尚未核对。');
    await androidShell('input keyevent 4');
    let view = await readHeyboxView();
    if (view.activity === `${androidDevice.package}/.MainActivity`
      && !view.nodes.some(node => node.id === `${androidDevice.package}:id/tv_me_home_fragment_username`)
      && view.nodes.some(node => node.id === `${androidDevice.package}:id/rb_5` && node.clickable)) {
      await tapHeyboxNode(view, `${androidDevice.package}:id/rb_5`);
      view = await readHeyboxView();
    }
    if (view.activity !== `${androidDevice.package}/.MainActivity`
      || !view.nodes.some(node => node.id === `${androidDevice.package}:id/tv_me_home_fragment_username`)) {
      throw new Error('未回到专用账号的“我”页面，本次未继续操作。');
    }
    return { ...view, accountId: profile.accountId, accountVerified: true };
  }
  async function openHeyboxComposer() {
    const home = await ownProfileHome();
    await tapHeyboxNode(home, `${androidDevice.package}:id/vg_mid_tab`);
    return { ...await readHeyboxView(), accountVerified: true,
      accountNickname: home.nodes.find(node => node.id === `${androidDevice.package}:id/tv_me_home_fragment_username`)?.text || '' };
  }
  async function openHeyboxTimeline() {
    const home = await ownProfileHome();
    await tapHeyboxLabel(home, '动态', `${androidDevice.package}:id/tv_desc`);
    return { ...await readHeyboxView(), accountVerified: true,
      accountNickname: home.nodes.find(node => node.id === `${androidDevice.package}:id/tv_me_home_fragment_username`)?.text || '' };
  }
  async function inspectHeyboxPost(input) {
    const post = validateHeyboxPost(input);
    let view = await openHeyboxTimeline();
    const nickname = view.accountNickname;
    for (let poll = 0; poll < 4; poll++) {
      const titles = view.nodes.filter(node => node.id === `${androidDevice.package}:id/tv_title` && node.text === post.title);
      if (titles.length === 1) {
        await tapHeyboxLabel(view, post.title, `${androidDevice.package}:id/tv_title`);
        for (let read = 0; read < 4; read++) {
          const result = verifyHeyboxPostView(await readHeyboxView(), post, nickname);
          if (result) return { confirmed: true, accountVerified: true, ...result };
          if (read < 3) await setTimeout(500);
        }
        break;
      }
      if (titles.length > 1) break;
      if (poll < 3) { await setTimeout(500); view = await readHeyboxView(); }
    }
    return { confirmed: false, message: '没有核对到唯一且正文匹配的本人帖子，本次没有发布或重试。' };
  }
  async function openHeyboxTopics() {
    const view = await openHeyboxComposer();
    if (view.activity !== `${androidDevice.package}/.module.bbs.post_edit.PostTabActivity`) throw new Error('尚未进入小黑盒发帖编辑器。');
    await tapHeyboxNode(view, `${androidDevice.package}:id/vg_add_topics_new`);
    return readHeyboxView();
  }
  async function searchHeyboxTopics(query) {
    if (typeof query !== 'string' || !query.trim() || query.length > 40 || /[\x00-\x1f\x7f]/.test(query)) throw new Error('分区搜索须为 1–40 字的文本。');
    let view = await readHeyboxView();
    const id = `${androidDevice.package}:id/et_search`;
    if (view.activity !== `${androidDevice.package}/.module.bbs.post_edit.PostTabActivity` || !view.nodes.some(node => node.id === id)) view = await openHeyboxTopics();
    await tapHeyboxNode(view, id);
    view = await readHeyboxView();
    if (view.activity !== `${androidDevice.package}/.module.bbs.post_edit.PostTabActivity`
      || !view.nodes.some(node => node.id === id && node.focused && node.className === 'android.widget.EditText')) throw new Error('分区搜索框未取得焦点。');
    await sdkCommand(serial => ['input', `--device=${serial}`, 'text', '--match=single', '--wait=3000', '--', query.trim(), `id=${id},class=android.widget.EditText,focused=true`]);
    return readHeyboxView();
  }
  async function selectHeyboxTopic(topic) {
    let view = await searchHeyboxTopics(topic);
    for (let attempt = 0; attempt < 4; attempt++) {
      if (view.nodes.filter(node => node.id === `${androidDevice.package}:id/tv_name` && node.text === topic).length === 1) {
        await tapHeyboxLabel(view, topic, `${androidDevice.package}:id/tv_name`);
        return readHeyboxView();
      }
      if (attempt < 3) { await setTimeout(500); view = await readHeyboxView(); }
    }
    throw new Error('没有找到完全匹配的分区，未选择近似名称。');
  }
  function postComposerView(view) {
    if (view.activity !== `${androidDevice.package}/.module.bbs.post_edit.PostTabActivity`
      || !['et_title', 'et_content'].every(id => view.nodes.filter(node => node.id === `${androidDevice.package}:id/${id}`
        && node.className === 'android.widget.EditText' && node.enabled).length === 1)) throw new Error('未取得完整的小黑盒标题和正文输入框。');
    return view;
  }
  async function closeHeyboxTopics(topic) {
    let view = await readHeyboxView();
    if (view.activity !== `${androidDevice.package}/.module.bbs.post_edit.PostTabActivity`) throw new Error('当前不是小黑盒分区选择页。');
    if (topic) {
      const box = value => value.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/)?.slice(1).map(Number);
      const from = view.nodes.find(node => node.id === `${androidDevice.package}:id/tv_title` && node.text === '已选');
      const to = view.nodes.find(node => node.id === `${androidDevice.package}:id/tv_title` && node.text === '分区');
      const selected = from && to ? view.nodes.filter(node => node.id === `${androidDevice.package}:id/tv_topic_name`
        && box(node.bounds)?.[1] >= box(from.bounds)?.[3] && box(node.bounds)?.[3] <= box(to.bounds)?.[1]) : [];
      if (selected.length !== 1 || selected[0].text !== topic) throw new Error('实际所选分区与配置不一致，未继续编辑。');
    }
    if (view.nodes.some(node => node.id === `${androidDevice.package}:id/et_search`)) {
      for (let key = 0; key < 2; key++) {
        await sdkCommand(serial => ['input', `--device=${serial}`, 'key', 'back']);
        for (let step = 0; step < 3; step++) {
          await setTimeout(300); view = await readHeyboxView();
          if (!view.nodes.some(node => node.id === `${androidDevice.package}:id/et_search`)) break;
        }
        if (!view.nodes.some(node => node.id === `${androidDevice.package}:id/et_search`)) break;
      }
    }
    return postComposerView(view);
  }
  const postField = (view, id) => view.nodes.find(node => node.id === `${androidDevice.package}:id/${id}`)?.text || '';
  const samePostText = (left, right) => left.replace(/\r\n/g, '\n').trim() === right.replace(/\r\n/g, '\n').trim();
  function postTopicMatches(view, topic) {
    return view.nodes.some(node => node.className === 'android.widget.TextView' && node.text === topic
      && /^com\.max\.xiaoheihe:id\/tv_(?:name|topic\w*|add_topics_new)$/.test(node.id));
  }
  function postFieldsMatch(view, post) {
    return samePostText(postField(view, 'et_title'), post.title) && samePostText(postField(view, 'et_content'), post.text)
      && postTopicMatches(view, post.topic);
  }
  async function writePostField(view, id, text) {
    id = `${androidDevice.package}:id/${id}`;
    await tapHeyboxNode(postComposerView(view), id);
    view = postComposerView(await readHeyboxView());
    if (!view.nodes.some(node => node.id === id && node.focused && node.enabled)) throw new Error('发帖输入框未取得焦点，未输入内容。');
    await sdkCommand(serial => ['input', `--device=${serial}`, 'text', '--match=single', '--wait=3000', '--', text,
      `id=${id},class=android.widget.EditText,focused=true`]);
    view = postComposerView(await readHeyboxView());
    if (!samePostText(view.nodes.find(node => node.id === id)?.text || '', text)) throw new Error('发帖文字回读不一致，未点击发布。');
    return view;
  }
  async function resumeOwnedPost(post) {
    const state = await check();
    if (!state.booted || state.heyboxRunning) throw new Error('分区选择未完成，原草稿已保留。');
    await request(control('app', 'launch', '-pkg', androidDevice.package), { json: false });
    let view;
    for (let attempt = 0; attempt < 4; attempt++) {
      try { view = await readHeyboxView(); break; }
      catch { if (attempt === 3) throw new Error('应用退出后尚未回到可核验的草稿恢复页。'); await setTimeout(500); }
    }
    const draft = postJournal.load().draft;
    if (!draft || draft.post.title !== post.title || draft.post.text !== post.text || draft.post.topic !== post.topic
      || view.activity !== `${androidDevice.package}/.MainActivity`
      || !view.nodes.some(node => node.id === `${androidDevice.package}:id/tv_title` && node.text === '要继续编辑作品吗？')
      || !view.nodes.some(node => node.id === `${androidDevice.package}:id/tv_content` && node.text === post.title)
      || !view.nodes.some(node => node.id === `${androidDevice.package}:id/tv_positive_button` && node.text === '去编辑')) throw new Error('恢复提示与项目草稿不符，未打开或丢弃其他草稿。');
    await tapHeyboxNode(view, `${androidDevice.package}:id/tv_positive_button`);
    return postComposerView(await readHeyboxView());
  }
  async function prepareHeyboxPost(input, { signal } = {}) {
    const post = validateHeyboxPost(input);
    if (!postJournal) throw new Error('请先绑定小黑盒专用账号。');
    signal?.throwIfAborted();
    const previous = postJournal.load();
    let view = await readHeyboxView();
    if (view.nodes.some(node => node.id === `${androidDevice.package}:id/et_search`)) view = await closeHeyboxTopics();
    if (view.activity === `${androidDevice.package}/.module.bbs.post_edit.PostTabActivity`) {
      const title = postField(view, 'et_title'), text = postField(view, 'et_content');
      const empty = ['', '填写标题'].includes(title) && ['', '添加正文'].includes(text);
      if (!empty) {
        const draft = previous.draft;
        if (!draft || !samePostText(title, draft.post.title) || !samePostText(text, draft.post.text)) throw new Error('已有其他草稿，未覆盖或丢弃。');
        // The complete owned text is retained in the journal and in the client's draft store.
        await reopenHeybox();
      }
    }
    signal?.throwIfAborted();
    view = postComposerView(await openHeyboxComposer());
    const nickname = view.accountNickname;
    const currentTitle = postField(view, 'et_title'), currentText = postField(view, 'et_content');
    if ((!['', '填写标题'].includes(currentTitle) || !['', '添加正文'].includes(currentText))
      && !(previous.draft && samePostText(currentTitle, previous.draft.post.title) && samePostText(currentText, previous.draft.post.text))) throw new Error('编辑器恢复了未识别的草稿，未覆盖内容。');
    postJournal.setDraft(post, nickname);
    view = await writePostField(view, 'et_title', post.title);
    signal?.throwIfAborted();
    view = await writePostField(view, 'et_content', post.text);
    signal?.throwIfAborted();
    if (!postTopicMatches(view, post.topic)) {
      await tapHeyboxNode(view, `${androidDevice.package}:id/vg_add_topics_new`);
      await selectHeyboxTopic(post.topic);
      signal?.throwIfAborted();
      try { view = await closeHeyboxTopics(post.topic); }
      catch { signal?.throwIfAborted(); view = await resumeOwnedPost(post); }
    }
    signal?.throwIfAborted();
    if (!postFieldsMatch(view, post)) throw new Error('标题、正文或分区与草稿不一致，未发布。');
    postJournal.setDraft(post, nickname, 'ready');
    return { prepared: true, accountVerified: true, post };
  }
  async function publishHeyboxPost(input, { signal, beforeSend, assertActive, ...policy } = {}) {
    if (beforeSend !== undefined && typeof beforeSend !== 'function' || assertActive !== undefined && typeof assertActive !== 'function') {
      throw new Error('小黑盒发布前检查参数无效。');
    }
    const post = validateHeyboxPost(input);
    if (!postJournal) throw new Error('请先绑定小黑盒专用账号。');
    const blocked = postJournal.guard(post, policy);
    if (blocked) return blocked;
    await prepareHeyboxPost(post, { signal });
    signal?.throwIfAborted();
    const view = postComposerView(await readHeyboxView());
    if (!postFieldsMatch(view, post)) throw new Error('发布前最终回读不一致，未点击发布。');
    const nickname = postJournal.load().draft.nickname;
    const attempt = postJournal.reserve(post, policy);
    if (attempt.ok === false) return attempt;
    let dispatched = false, textOnlyConfirmed = false, sendChecked = false;
    try {
      signal?.throwIfAborted();
      await tapHeyboxLabel({ ...view, nodes: view.nodes.filter(node => node.className !== 'android.widget.EditText') }, '发布', '', {
        signal, assertActive, onDispatch: () => { dispatched = true; },
        async beforeSend() {
          if (sendChecked) throw new Error('本次小黑盒发布不能重复提交。');
          sendChecked = true;
          assertActive?.();
          return beforeSend ? await beforeSend() : true;
        },
      });
      for (let poll = 0; poll < 6; poll++) {
        await setTimeout(700);
        const published = await readHeyboxView();
        if (!textOnlyConfirmed && published.activity === `${androidDevice.package}/.module.bbs.post_edit.PostTabActivity`
          && published.nodes.some(node => node.id === `${androidDevice.package}:id/tv_title` && node.text === '没有合适的图片？试试文字配图')
          && published.nodes.some(node => node.id === `${androidDevice.package}:id/tv_positive_button` && node.text === '前往配图')
          && published.nodes.some(node => node.id === `${androidDevice.package}:id/tv_negative_button` && node.text === '直接发布')) {
          textOnlyConfirmed = true;
          await tapHeyboxNode(published, `${androidDevice.package}:id/tv_negative_button`, { signal, assertActive });
          continue;
        }
        const result = verifyHeyboxPostView(published, post, nickname);
        if (result) {
          postJournal.finish(attempt.id, result.review ? 'review' : 'success');
          return { ok: true, confirmed: true, ...result, message: result.review ? '已提交帖子，等待平台审核。' : '已从专用账号的帖子页核对标题、作者和正文。' };
        }
      }
      throw new Error('没有取得可核验的发布后帖子页。');
    } catch {
      postJournal.finish(attempt.id, dispatched ? 'unknown' : 'rejected');
      return { ok: false, unknown: dispatched, message: dispatched ? '发布结果未确认，已保留记录，不自动重试。' : '发布已取消，本次没有点击发布。' };
    }
  }
  async function openHeyboxArticle(value, { signal } = {}) {
    signal?.throwIfAborted();
    let url;
    try { url = new URL(value); } catch { throw new Error('请输入有效的小黑盒公开帖子地址。'); }
    if (url.origin !== 'https://www.xiaoheihe.cn' || !/^\/app\/bbs\/link\/\d{1,20}$/.test(url.pathname)
      || url.username || url.password || url.search || url.hash) throw new Error('仅支持无查询参数的小黑盒公开帖子地址。');
    const home = await ownProfileHome();
    signal?.throwIfAborted();
    const linkId = url.pathname.split('/').at(-1);
    const shareUrl = `https://c.xiaoheihe.cn/v3/bbs/app/api/web/share?link_id=${linkId}`;
    const route = await androidShell(`cmd package resolve-activity --brief -a android.intent.action.VIEW -d ${shareUrl} -p ${androidDevice.package}`);
    if (!route.split(/\r?\n/).some(line => /^com\.max\.xiaoheihe\/[a-zA-Z0-9._$]+$/.test(line.trim()))) throw new Error('小黑盒客户端未提供此公开链接的打开入口。');
    signal?.throwIfAborted();
    const started = await androidShell(`am start -W -a android.intent.action.VIEW -d ${shareUrl} -p ${androidDevice.package}`);
    if (!/^Status: ok\s*$/m.test(started)) throw new Error('小黑盒客户端未确认打开帖子。');
    signal?.throwIfAborted();
    return { ...await readHeyboxView(), url: url.href, accountVerified: true,
      accountNickname: home.nodes.find(node => node.id === `${androidDevice.package}:id/tv_me_home_fragment_username`)?.text || '' };
  }
  async function closeEmptyCommentEditor(view) {
    const editors = view.nodes.filter(node => node.id === `${androidDevice.package}:id/et_editor`);
    if (!editors.length) return view;
    if (editors.length !== 1 || editors[0].truncated) throw new Error('评论输入框无法核对，未离开页面。');
    const value = editors[0].text.replace(/\u00a0/g, ' ');
    let empty = ['', '来说点什么吧!'].includes(value);
    if (!empty && value.startsWith('回复 ')) {
      const quotes = view.nodes.filter(node => node.id === `${androidDevice.package}:id/tv_editor_comment_reply_msg` && !node.truncated);
      const targets = parseHeyboxComments(view).filter(comment => value === `回复 ${comment.author}` && quotes.length === 1 && quotes[0].text === comment.text);
      empty = targets.length === 1;
    }
    if (!empty) throw new Error('评论编辑器中有未发送文字，已保留草稿，请先处理后再继续。');
    if (view.nodes.some(node => node.id === `${androidDevice.package}:id/v_mask` && node.clickable)) {
      await tapHeyboxNode(view, `${androidDevice.package}:id/v_mask`);
      view = await readHeyboxView();
      if (view.nodes.some(node => node.id === `${androidDevice.package}:id/v_mask`)) throw new Error('评论编辑器尚未关闭，未离开页面。');
    }
    return view;
  }
  async function openHeyboxComments(url, options = {}) {
    if (![adb, androidCli].every(existsSync)) throw new Error('读取或发送评论需要 Google Android CLI 和 SDK Platform Tools，以核对完整评论与回复对象。');
    const page = await readHeyboxArticle(url, options);
    options.signal?.throwIfAborted();
    const view = await readHeyboxView();
    if (!POST_PAGES.has(view.activity)) throw new Error('帖子界面已变化，未进入评论。');
    await tapHeyboxLabel(view, '评论', `${androidDevice.package}:id/tv_tab_title`);
    return { ...await readHeyboxView(), url: page.url, title: page.title, accountVerified: true, accountNickname: page.accountNickname };
  }
  async function readHeyboxComments(url, options = {}) {
    const view = await openHeyboxComments(url, options);
    return { url: view.url, title: view.title, readAt: new Date().toISOString(), truncated: true,
      comments: parseHeyboxComments(view).map(({ bounds, ...comment }) => comment) };
  }
  async function openHeyboxCommentReply(url, { expectedTitle, commentKey, signal } = {}) {
    if (typeof commentKey !== 'string' || !/^[a-f0-9]{64}$/.test(commentKey)) throw new Error('请提供已读取评论的标识。');
    const view = await openHeyboxComments(url, { expectedTitle, signal });
    const target = parseHeyboxComments(view).find(comment => comment.key === commentKey);
    if (!target) throw new Error('目标评论已变化或不在可核对范围内，未打开回复。');
    signal?.throwIfAborted();
    const node = view.nodes.find(node => node.id === `${androidDevice.package}:id/tv_comment` && node.bounds === target.bounds);
    await tapHeyboxTarget(view, node);
    return { ...await readHeyboxView(), url, title: view.title, target: { key: target.key, author: target.author, text: target.text } };
  }
  function commentEditorMatches(view, comment, { filled = false } = {}) {
    if (!POST_PAGES.has(view.activity)) return false;
    const fields = id => view.nodes.filter(node => node.id === `${androidDevice.package}:id/${id}`);
    const editor = fields('et_editor'), quote = fields('tv_editor_comment_reply_msg'), send = fields('tv_send');
    if (editor.length !== 1 || editor[0].truncated || send.length !== 1 || send[0].text !== '发送' || !send[0].enabled) return false;
    if (filled ? editor[0].text !== comment.text : !['', comment.replyTo ? `回复 ${comment.replyTo.author}` : '来说点什么吧!'].includes(editor[0].text.replace(/\u00a0/g, ' '))) return false;
    return comment.replyTo ? quote.length === 1 && !quote[0].truncated && quote[0].text === comment.replyTo.text
      && parseHeyboxComments(view).filter(item => item.key === comment.replyTo.key).length === 1 : quote.length === 0;
  }
  async function prepareHeyboxComment(input, { signal } = {}) {
    const comment = validateHeyboxComment(input);
    if (!postJournal) throw new Error('请先绑定小黑盒专用账号。');
    let view = await openHeyboxComments(comment.url, { expectedTitle: comment.title, signal });
    const nickname = view.accountNickname;
    if (typeof nickname !== 'string' || !nickname.trim()) throw new Error('没有核对到专用账号昵称。');
    if (verifyHeyboxComment(view, comment, nickname)) throw new Error('当前列表已有相同的本人表达，未重复发送。');
    const targets = parseHeyboxComments(view);
    if (comment.replyTo) {
      const target = targets.find(item => item.key === comment.replyTo.key && item.author === comment.replyTo.author && item.text === comment.replyTo.text);
      if (!target) throw new Error('目标评论已变化或位置不明确，未发送回复。');
      await tapHeyboxTarget(view, view.nodes.find(node => node.id === `${androidDevice.package}:id/tv_comment` && node.bounds === target.bounds));
    } else await tapHeyboxNode(view, `${androidDevice.package}:id/et_editor`);
    view = await readHeyboxView();
    if (!commentEditorMatches(view, comment)) throw new Error('评论输入框或回复对象不一致，未输入文字。');
    signal?.throwIfAborted();
    postJournal.setCommentDraft(comment, nickname);
    await tapHeyboxNode(view, `${androidDevice.package}:id/et_editor`);
    view = await readHeyboxView();
    if (!view.nodes.some(node => node.id === `${androidDevice.package}:id/et_editor` && node.focused)) throw new Error('评论输入框未取得焦点。');
    await sdkCommand(serial => ['input', `--device=${serial}`, 'text', '--match=single', '--wait=3000', '--', comment.text,
      `id=${androidDevice.package}:id/et_editor,class=android.widget.EditText,focused=true`]);
    view = await readHeyboxView();
    if (!commentEditorMatches(view, comment, { filled: true })) throw new Error('评论全文或回复对象回读不一致，未发送。');
    signal?.throwIfAborted();
    postJournal.setCommentDraft(comment, nickname, 'ready');
    return { prepared: true, accountVerified: true };
  }
  async function publishHeyboxComment(input, { signal, ...policy } = {}) {
    const comment = validateHeyboxComment(input);
    if (!postJournal) throw new Error('请先绑定小黑盒专用账号。');
    const blocked = postJournal.guardComment(comment, policy); if (blocked) return blocked;
    await prepareHeyboxComment(comment, { signal });
    signal?.throwIfAborted();
    const view = await readHeyboxView();
    if (!commentEditorMatches(view, comment, { filled: true })) throw new Error('发送前评论回读不一致，未点击发送。');
    const nickname = postJournal.load().commentDraft.nickname;
    const attempt = postJournal.reserveComment(comment, policy); if (attempt.ok === false) return attempt;
    let dispatched = false;
    try {
      signal?.throwIfAborted();
      dispatched = true;
      await tapHeyboxNode(view, `${androidDevice.package}:id/tv_send`);
      for (let poll = 0; poll < 5; poll++) {
        await setTimeout(600);
        const result = await readHeyboxView();
        if (result.nodes.some(node => node.id === `${androidDevice.package}:id/v_mask`)) continue;
        if (verifyHeyboxComment(result, comment, nickname)) {
          postJournal.finish(attempt.id, 'success');
          return { ok: true, confirmed: true, confirmation: comment.replyTo ? 'reply_view' : 'comment_view' };
        }
      }
      throw new Error('未回读到对应目标下的本人文字。');
    } catch {
      postJournal.finish(attempt.id, dispatched ? 'unknown' : 'rejected');
      return { ok: false, unknown: dispatched, message: dispatched ? '评论结果未确认，已计次并保留记录，不自动重发。' : '未发送评论。' };
    }
  }
  async function discardHeyboxCommentDraft(input) {
    const comment = validateHeyboxComment(input), draft = postJournal?.load().commentDraft;
    if (!draft || JSON.stringify(draft.comment) !== JSON.stringify(comment)) throw new Error('没有相符的本项目评论草稿。');
    const state = postJournal.load();
    if (state.attempts.some(item => item.hash === draft.hash && item.outcome !== 'rejected')) throw new Error('这份评论已有发送尝试，先保留原始记录。');
    let view = await readHeyboxView();
    if (!commentEditorMatches(view, comment, { filled: true })) throw new Error('当前编辑器不是原来的评论草稿，未清除。');
    await tapHeyboxNode(view, `${androidDevice.package}:id/et_editor`);
    await sdkCommand(serial => ['input', `--device=${serial}`, 'text', '--match=single', '--wait=3000', '--', '',
      `id=${androidDevice.package}:id/et_editor,class=android.widget.EditText,focused=true`]);
    view = await readHeyboxView();
    if (!commentEditorMatches(view, comment)) throw new Error('评论草稿尚未核对清空。');
    await closeEmptyCommentEditor(view);
    postJournal.clearCommentDraft(comment);
    return { cleared: true, submitted: false };
  }
  async function readHeyboxArticle(url, { expectedTitle, signal } = {}) {
    if (typeof expectedTitle !== 'string' || !expectedTitle.trim() || expectedTitle.length > 500) throw new Error('客户端阅读需要公开列表中的帖子标题来核对来源。');
    let view = await openHeyboxArticle(url, { signal });
    const accountNickname = view.accountNickname;
    const expected = expectedTitle.replace(/\s+/g, ' ').trim();
    for (let attempt = 0; attempt < 4; attempt++) {
      signal?.throwIfAborted();
      if (!POST_PAGES.has(view.activity)) throw new Error('客户端尚未进入支持的公开帖子页，未记为已读。');
      const article = view.activity.endsWith('.WebNewsPostPageActivityV2');
      const titles = view.nodes.filter(node => (article ? !node.id && node.className === 'android.widget.TextView' : node.id === `${androidDevice.package}:id/tv_title`)
        && node.text.replace(/\s+/g, ' ').trim() === expected);
      let body = '';
      if (article && titles.length === 1) {
        const box = value => value.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/)?.slice(1).map(Number);
        const frames = [...new Set(view.nodes.filter(node => node.className === 'android.webkit.WebView').map(node => node.bounds))].map(box).filter(Boolean);
        const heading = box(titles[0].bounds);
        if (frames.length === 1 && heading) {
          const frame = frames[0];
          body = view.nodes.filter(node => !node.id && node.className === 'android.widget.TextView'
            && node.text.trim() && node.text !== expected && node.text !== '包含AI辅助创作')
            .filter(node => { const area = box(node.bounds); return area && area[1] >= heading[3] && area[0] >= frame[0] && area[2] <= frame[2]
              && area[1] >= frame[1] && area[3] <= frame[3] && area[2] - area[0] >= (frame[2] - frame[0]) * 0.75; })
            .map(node => node.text.trim()).join('\n\n').slice(0, 8000);
        }
      } else if (!article) {
        const bodies = view.nodes.filter(node => node.id === `${androidDevice.package}:id/tv_desc` && node.className === 'android.widget.TextView');
        if (bodies.length === 1) body = bodies[0].text.trim();
      }
      if (titles.length === 1 && body.length >= 40) {
        const text = `【客户端可访问的正文文字摘录；未读取图片、视频或未显示的内容】\n${body}`;
        return { url: view.url || url, title: expected, text, excerpt: text.slice(0, 300), truncated: true,
          readAt: new Date().toISOString(), source: 'android_ui', accountNickname };
      }
      if (attempt < 3) { await setTimeout(500); view = await readHeyboxView(); }
    }
    throw new Error('客户端帖子标题未匹配公开来源，或可访问文字不足；未记为已读。');
  }
  async function profileSettings() {
    if (!expectedAccountId) throw new Error('请先在本机配置中绑定小黑盒专用账号 ID。');
    let view = await closeAvatarMenu(await readHeyboxView());
    if (view.activity === `${androidDevice.package}/.module.account.UpdateAccountActivity`) {
      await tapHeyboxNode(view, `${androidDevice.package}:id/iv_appbar_nav_button`);
      view = await readHeyboxView();
    }
    if (view.activity !== `${androidDevice.package}/.module.account.SettingActivity`) {
      const home = await ownProfileHome();
      await tapHeyboxNode(home, `${androidDevice.package}:id/iv_home_search`);
      view = await readHeyboxView();
    }
    if (view.activity !== `${androidDevice.package}/.module.account.SettingActivity`
      || !view.nodes.some(node => node.text === '设置')
      || !view.nodes.some(node => node.id === `${androidDevice.package}:id/tv_id` && node.text === `ID:${expectedAccountId}`)) {
      throw new Error('小黑盒设置页或账号 ID 与预期不符，本次未继续操作。');
    }
    return view;
  }
  function profileEditorView(view) {
    if (view.activity !== `${androidDevice.package}/.module.account.UpdateAccountActivity`
      || !view.nodes.some(node => node.text === '个人信息')
      || !['et_nick', 'et_signature'].every(id => view.nodes.filter(node => node.id === `${androidDevice.package}:id/${id}`
        && node.className === 'android.widget.EditText' && node.enabled).length === 1)) {
      throw new Error('小黑盒资料编辑界面与预期不符，本次未继续操作。');
    }
    return view;
  }
  async function profileEditor() {
    const settings = await profileSettings();
    await tapHeyboxNode(settings, `${androidDevice.package}:id/vg_user_info`);
    return profileEditorView(await readHeyboxView());
  }
  async function replaceProfileText(view, id, text) {
    await tapHeyboxNode(profileEditorView(view), id);
    view = profileEditorView(await readHeyboxView());
    if (!view.nodes.some(node => node.id === id && node.focused && node.enabled)) throw new Error('资料输入框未取得焦点，本次未输入。');
    await sdkCommand(serial => ['input', `--device=${serial}`, 'text', '--match=single', '--wait=3000', '--', text,
      `id=${id},class=android.widget.EditText,focused=true`]);
    view = profileEditorView(await readHeyboxView());
    if (view.nodes.find(node => node.id === id)?.text !== text) throw new Error('资料文字回读不一致，本次未点击保存。');
    return view;
  }
  async function updateHeyboxProfile(input) {
    const fields = { nickname: 'et_nick', signature: 'et_signature' };
    if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length
      || Object.keys(input).some(key => !Object.hasOwn(fields, key))) throw new Error('资料修改仅接受 nickname 和 signature。');
    const changes = Object.entries(input).map(([key, value]) => {
      if (typeof value !== 'string' || !value.trim() || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)
        || Array.from(value).length > (key === 'nickname' ? 20 : 80)) throw new Error('昵称或签名的格式、长度无效。');
      return { key, id: `${androidDevice.package}:id/${fields[key]}`, text: value };
    });
    let view = await profileEditor();
    if (changes.every(change => view.nodes.find(node => node.id === change.id)?.text === change.text)) {
      return { updated: false, verified: true, message: '小黑盒资料已是目标内容。' };
    }
    for (const change of changes) {
      if (view.nodes.find(node => node.id === change.id)?.text !== change.text) view = await replaceProfileText(view, change.id, change.text);
    }
    if (changes.some(change => view.nodes.find(node => node.id === change.id)?.text !== change.text)) throw new Error('待保存资料与目标不一致，本次未保存。');
    const save = view.nodes.filter(node => node.id === `${androidDevice.package}:id/tv_appbar_action` && node.text === '保存' && node.enabled);
    if (save.length !== 1) throw new Error('未找到可核验的资料保存按钮。');
    await tapHeyboxNode(view, save[0].id);
    await waitForProfileSave('资料');
    view = await refreshHeybox();
    const homeFields = { nickname: 'tv_me_home_fragment_username', signature: 'tv_signature' };
    if (changes.some(change => view.nodes.find(node => node.id === `${androidDevice.package}:id/${homeFields[change.key]}`)?.text !== change.text)) {
      throw new Error('刷新后的个人主页资料与目标不一致，未标记为修改成功。');
    }
    return { updated: true, verified: true, fields: changes.map(change => change.key), message: '小黑盒资料已保存，并刷新应用从个人主页核验。' };
  }
  async function waitForProfileSave(label) {
    const deadline = Date.now() + 45000;
    for (let attempt = 0; attempt < 6 && Date.now() < deadline; attempt++) {
      let view;
      try { view = await readHeyboxView(); }
      catch (error) {
        if (!/活动窗口|读取时小黑盒界面已变化|Google Android CLI 操作未确认成功/.test(error.message)) throw error;
      }
      if (view?.activity === `${androidDevice.package}/.module.account.SettingActivity`) return profileSettings();
      if (view && view.activity !== `${androidDevice.package}/.module.account.UpdateAccountActivity`) break;
      if (attempt < 5) await setTimeout(1000);
    }
    throw new Error(`${label}保存结果尚未确认；请检查应用提示，不自动重复提交。`);
  }
  async function refreshHeybox() {
    await ownProfileHome();
    return reopenHeybox();
  }
  async function reopenHeybox() {
    await androidShell(`am force-stop ${androidDevice.package}`);
    await request(control('app', 'launch', '-pkg', androidDevice.package), { json: false });
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const view = await readHeyboxView();
        if (view.activity === `${androidDevice.package}/.MainActivity`) return ownProfileHome();
      } catch (error) {
        if (!/活动窗口|当前未读取其他应用|读取时小黑盒界面已变化|Google Android CLI 操作未确认成功/.test(error.message)) throw error;
      }
      await setTimeout(1500);
    }
    throw new Error('小黑盒重新打开后尚未回到主页，请检查登录和启动界面。');
  }
  async function sdkDevice() {
    if (![adb, androidCli].every(existsSync)) throw new Error('请先配置 Google Android CLI 和 SDK Platform Tools。');
    const device = await ownDevice();
    if (!device.is_android_started || device.adb_host_ip !== '127.0.0.1' || !Number.isInteger(device.adb_port)
      || device.adb_port < 1024 || device.adb_port > 65535) throw new Error('没有取得专用设备的有效本机 Android 连接。');
    const serial = `127.0.0.1:${device.adb_port}`;
    if (sdkConnection && sdkConnection.serial !== serial) throw new Error('专用 Android 连接已变化，本次未执行操作。');
    const env = { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, ANDROID_USER_HOME: join(root, 'user'),
      ANDROID_ADB_SERVER_PORT: '5039', ANDROID_ADB_SERVER_ADDRESS: '127.0.0.1', ADB_SERVER_SOCKET: 'tcp:127.0.0.1:5039', ADB_MDNS_AUTO_CONNECT: '0',
      JAVA_TOOL_OPTIONS: '-Dfile.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8 -Dsun.stderr.encoding=UTF-8' };
    const prefix = ['-H', '127.0.0.1', '-P', '5039'];
    if (!sdkConnection) {
      const serverEnv = { ...env };
      delete serverEnv.ANDROID_ADB_SERVER_PORT;
      delete serverEnv.ANDROID_ADB_SERVER_ADDRESS;
      delete serverEnv.ADB_SERVER_SOCKET;
      const server = await run(adb, ['-L', 'tcp:localhost:5039', '--one-device', serial, 'start-server'], { env: serverEnv });
      if (!server.ok) throw new Error('专用 Android 调试服务未启动，请检查 5039 端口。');
      const connected = await run(adb, [...prefix, 'connect', serial], { env });
      if (!connected.ok) throw new Error('专用 Android 连接未确认在线。');
      sdkConnection = { serial };
    }
    const state = await run(adb, [...prefix, '-s', serial, 'get-state'], { env });
    if (!state?.ok || state.stdout.trim() !== 'device') throw new Error('专用 Android 连接未确认在线。');
    const current = await ownDevice();
    if (!current.is_android_started || current.adb_host_ip !== '127.0.0.1' || current.adb_port !== device.adb_port) throw new Error('专用 Android 连接已变化，本次未执行操作。');
    return { serial, env, prefix };
  }
  async function sdkCommand(buildArgs) {
    const { serial, env } = await sdkDevice();
    const result = await run(androidCli, [`--sdk=${sdk}`, ...buildArgs(serial)], { env, timeout: 60000 });
    if (!result.ok) throw new Error('Google Android CLI 操作未确认成功，请检查专用设备。');
    return result;
  }
  function avatarFile(path) {
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || /^\\\\/.test(path) || !/\.png$/i.test(path)
      || !existsSync(path) || !statSync(path).isFile() || statSync(path).size > 8 * 1024 * 1024) throw new Error('头像须为本机 8 MiB 以内的 PNG 文件。');
    const image = readFileSync(path);
    if (!image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('头像未通过 PNG 格式核验。');
    const sha256 = createHash('sha256').update(image).digest('hex');
    const target = `/sdcard/Pictures/MemoriaAvatar-${sha256.slice(0, 12)}/avatar.png`;
    return { target, sha256, album: `MemoriaAvatar-${sha256.slice(0, 12)}` };
  }
  function avatarGuard(sha256) {
    if (!existsSync(avatarStatePath)) return null;
    let state;
    try {
      if (statSync(avatarStatePath).size > 8192) throw new Error();
      state = JSON.parse(readFileSync(avatarStatePath, 'utf8'));
      if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error();
      if (typeof state.accountId !== 'string' || !/^\d{5,16}$/.test(state.accountId)
        || typeof state.index !== 'string' || !/^(0|[1-9]\d{0,3})$/.test(state.index)
        || !Number.isSafeInteger(state.createdTimestamp) || state.createdTimestamp <= 0) throw new Error();
      if (state.accountId !== expectedAccountId || state.createdTimestamp !== createdTimestamp || state.index !== index) return null;
      if (!/^[a-f0-9]{64}$/.test(state.sha256) || !['pending', 'success', 'unknown'].includes(state.outcome)
        || typeof state.attemptedAt !== 'string' || !Number.isFinite(Date.parse(state.attemptedAt))) throw new Error();
    } catch { throw new Error('头像冷却记录无法核验，本次未提交，请先检查本机记录。'); }
    if (state.outcome === 'success' && state.sha256 === sha256) return { skipped: 'unchanged', message: '同一头像已有成功记录，本次未重复提交。' };
    const next = Date.parse(state.attemptedAt) + 7 * 86400000;
    return Date.now() < next ? { skipped: 'cooldown', nextAllowedAt: new Date(next).toISOString(), message: '头像修改处于 7 天冷却期，本次未提交。' } : null;
  }
  function saveAvatarState(state) {
    mkdirSync(dirname(avatarStatePath), { recursive: true, mode: 0o700 });
    const temporary = `${avatarStatePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ ...state, index, accountId: expectedAccountId, createdTimestamp }), { mode: 0o600 });
      renameSync(temporary, avatarStatePath);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  async function stageAvatar(path) {
    const { target, sha256, album } = avatarFile(path);
    const { serial, env, prefix } = await sdkDevice();
    const call = async args => {
      const result = await run(adb, [...prefix, '-s', serial, ...args], { env, timeout: 30000 });
      if (!result.ok) throw new Error('头像传入专用安卓设备时未确认成功。');
      return result.stdout;
    };
    await call(['push', path, target]);
    const digest = await call(['shell', 'toybox', 'sha256sum', target]);
    if (!digest.startsWith(`${sha256} `)) throw new Error('设备中的头像文件与本机素材不一致。');
    await call(['shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', `file://${target}`]);
    return { target, sha256, album };
  }
  async function avatarPicker(editor) {
    editor = editor ? profileEditorView(editor) : await profileEditor();
    await tapHeyboxNode(editor, `${androidDevice.package}:id/rl_set_icon`);
    const menu = await readHeyboxView();
    if (!menu.nodes.some(node => node.text === '更换头像框')) throw new Error('未找到可核验的头像更换菜单。');
    await tapHeyboxLabel(menu, '更换头像');
    try { return await readHeyboxView(); }
    catch (error) {
      if (!/请先在 MuMu 专用设备中打开小黑盒|活动窗口/.test(error.message)) throw error;
      return readAvatarAccessView();
    }
  }
  async function readAvatarAccessView() {
    const activities = await androidShell('dumpsys activity activities');
    const resumed = activities.split(/\r?\n/).find(line => /^\s*(?:topResumedActivity|mResumedActivity|ResumedActivity)\s*[:=]/.test(line));
    const activity = resumed?.match(/\b[a-zA-Z][\w.]+\/[a-zA-Z0-9._$]+/)?.[0];
    const allowed = [`${androidDevice.package}/.module.account.UpdateAccountActivity`,
      'com.android.permissioncontroller/com.android.permissioncontroller.permission.ui.GrantPermissionsActivity',
      'com.android.permissioncontroller/.permission.ui.GrantPermissionsActivity',
      'com.android.providers.media.module/.photopicker.PhotoPickerActivity',
      'com.android.providers.media.module/com.android.providers.media.photopicker.PhotoPickerUserSelectActivity',
      'com.android.providers.media.module/com.android.providers.media.photopicker.PhotoPickerActivity'];
    if (!allowed.includes(activity)) throw new Error('当前不是已知的头像图片权限或选择页面，本次未继续操作。');
    const result = await sdkCommand(serial => ['layout', `--device=${serial}`, '--flat', '--full']);
    let windows;
    try { windows = JSON.parse(result.stdout); } catch { throw new Error('头像权限页面无法解析。'); }
    const active = Array.isArray(windows) ? windows.filter(window => window.type === 'APPLICATION' && window.active && window.focused) : [];
    const prefixes = ['com.android.permissioncontroller:id/', 'com.android.providers.media.module:id/'];
    if (active.length !== 1 || !Array.isArray(active[0].content) || !active[0].content.some(node => prefixes.some(prefix => node['resource-id']?.startsWith(prefix)))) {
      throw new Error('没有取得 Android 选定照片权限页面，本次未授权全部存储。');
    }
    const nodes = active[0].content.filter(node => !node.hidden && !node['off-screen'])
      .filter(node => !node['resource-id'] || node['resource-id'].startsWith('android:id/') || prefixes.some(prefix => node['resource-id'].startsWith(prefix)))
      .map(node => ({ id: node['resource-id'] || '', text: String(node.text || '').slice(0, 200), description: String(node['content-desc'] || '').slice(0, 200),
        bounds: node.bounds || '', className: node.class || '', clickable: node.interactions?.includes('CLICKABLE') === true,
        focused: node.state?.includes('FOCUSED') === true, enabled: node.enabled !== false && !node.state?.includes('DISABLED') }));
    return { source: 'android_avatar_access', activity, nodes };
  }
  async function requestSelectedAvatarAccess(view) {
    view ??= await avatarPicker();
    const permissions = await androidShell(`dumpsys package ${androidDevice.package}`);
    if (!/android\.permission\.READ_MEDIA_VISUAL_USER_SELECTED/.test(permissions)) throw new Error('应用未声明仅选定照片权限，本次未申请全部存储权限。');
    if (!view.nodes.some(node => node.id === 'android:id/message' && node.text === '【图片选择器需要授予访问存储权限】')
      || !view.nodes.some(node => node.id === 'android:id/button1' && node.text === '确认')) throw new Error('当前没有已核验的头像图片权限说明。');
    // This opens Android's permission choice. It does not press any permission-grant button.
    await tapHeyboxNode(view, 'android:id/button1');
    return readAvatarAccessView();
  }
  async function beginLimitedAvatarSelection() {
    const view = await readAvatarAccessView();
    if (!view.nodes.some(node => node.id === 'com.android.permissioncontroller:id/permission_message' && avatarPermissionMessages.includes(node.text))
      || !view.nodes.some(node => node.id === 'com.android.permissioncontroller:id/permission_allow_selected_button' && node.text === '允许有限访问')) {
      throw new Error('当前没有专用小黑盒的有限图片访问选项，本次未授权。');
    }
    await tapHeyboxNode(view, 'com.android.permissioncontroller:id/permission_allow_selected_button');
    return readAvatarAccessView();
  }
  async function verifySoleAvatarFile(path) {
    const avatar = avatarFile(path);
    const { serial, env, prefix } = await sdkDevice();
    const content = projection => run(adb, [...prefix, '-s', serial, 'shell', 'content', 'query', '--uri', 'content://media/external/images/media', '--projection', projection], { env, timeout: 30000 });
    // MuMu's Java content utility can exit 139 after emitting its result. Accept only matching, complete single-row reads.
    const complete = result => result.ok ? !result.stderr.trim()
      : result.exitCode === 139 && (!result.stderr.trim() || /^Segmentation fault\s*$/.test(result.stderr));
    const row = await content('_id:_display_name:relative_path');
    const match = row.stdout.trim().match(/^Row: 0 _id=(\d+), _display_name=avatar\.png, relative_path=(Pictures\/MemoriaAvatar-[a-f0-9]{12}\/)$/);
    if (!complete(row) || !match || match[2] !== `Pictures/${avatar.album}/`) throw new Error('唯一图片不是已核验的专用头像。');
    const ids = await content('_id');
    if (!complete(ids) || ids.stdout.trim() !== `Row: 0 _id=${match[1]}`) throw new Error('两次媒体索引核验不一致，本次未选择图片。');
    const digest = await run(adb, [...prefix, '-s', serial, 'shell', 'toybox', 'sha256sum', avatar.target], { env });
    if (!digest.ok || !digest.stdout.startsWith(`${avatar.sha256} `)) throw new Error('选择前的设备头像文件哈希不符。');
    return avatar;
  }
  async function selectOnlyAvatarPhoto(path) {
    let view = await readAvatarAccessView();
    if (!view.nodes.some(node => node.id === 'com.android.providers.media.module:id/privacy_text' && node.text === '选择允许此应用访问的照片和视频')) {
      throw new Error('当前不是 Android 有限图片访问选择器。');
    }
    if (view.nodes.some(node => node.text === '无相册')) {
      await tapHeyboxLabel(view, '照片');
      view = await readAvatarAccessView();
    }
    await verifySoleAvatarFile(path);
    const photos = view.nodes.filter(node => node.clickable && node.enabled && node.className === 'android.widget.FrameLayout' && /^拍摄于 .+的照片$/.test(node.description));
    if (photos.length !== 1) throw new Error('系统选择器没有唯一可核验的头像图片。');
    if (view.nodes.some(node => node.id === 'com.android.providers.media.module:id/button_add' && node.text === '允许 (1)')) return view;
    await tapHeyboxTarget(view, photos[0]);
    return readAvatarAccessView();
  }
  async function finishLimitedAvatarAccess(path) {
    await verifySoleAvatarFile(path);
    const view = await readAvatarAccessView();
    if (!view.nodes.some(node => node.id === 'com.android.providers.media.module:id/privacy_text' && node.text === '选择允许此应用访问的照片和视频')
      || !view.nodes.some(node => node.id === 'com.android.providers.media.module:id/button_add' && node.text === '允许 (1)')) {
      throw new Error('未核验到仅允许一张头像照片的确认按钮，本次未授权。');
    }
    await tapHeyboxNode(view, 'com.android.providers.media.module:id/button_add');
    const permissions = await androidShell(`dumpsys package ${androidDevice.package}`);
    if (!limitedAvatarPermissions(permissions)) throw new Error('图片访问范围与有限授权目标不一致，请检查系统权限。');
    return readHeyboxView();
  }
  function limitedAvatarPermissions(permissions) {
    // Android's selected-photo compatibility mode reports temporary grants marked REVOKED_COMPAT and ONE_TIME.
    // https://developer.android.com/about/versions/14/changes/partial-photo-video-access
    return /android\.permission\.READ_MEDIA_VISUAL_USER_SELECTED: granted=true/.test(permissions)
      && ['IMAGES', 'VIDEO'].every(type => {
        const rows = permissions.split(/\r?\n/).filter(line => line.includes(`android.permission.READ_MEDIA_${type}: granted=`));
        return rows.length === 1 && (/granted=false/.test(rows[0])
          || (/granted=true/.test(rows[0]) && rows[0].includes('REVOKED_COMPAT') && rows[0].includes('ONE_TIME')));
      });
  }
  async function selectHeyboxAvatar(path) {
    await verifySoleAvatarFile(path);
    if (!limitedAvatarPermissions(await androidShell(`dumpsys package ${androidDevice.package}`))) throw new Error('当前不是已核验的有限图片访问权限。');
    const view = await readHeyboxView();
    if (view.activity !== `${androidDevice.package}/com.max.mediaselector.lib.basic.PictureSelectorSupporterActivity`
      || !view.nodes.some(node => node.id === `${androidDevice.package}:id/ps_tv_title` && node.text === '相机胶卷')
      || view.nodes.filter(node => node.id === `${androidDevice.package}:id/btnCheck`).length !== 1) {
      throw new Error('小黑盒图片选择器没有唯一的已核验头像。');
    }
    if (view.nodes.some(node => node.id === `${androidDevice.package}:id/tvCheck` && node.text === '1')
      && view.nodes.some(node => node.id === `${androidDevice.package}:id/ps_tv_preview` && node.text === '已选1/1')) return view;
    await tapHeyboxNode(view, `${androidDevice.package}:id/btnCheck`);
    return readHeyboxView();
  }
  async function openAvatarCrop(path) {
    await verifySoleAvatarFile(path);
    const view = await readHeyboxView();
    if (view.activity !== `${androidDevice.package}/com.max.mediaselector.lib.basic.PictureSelectorSupporterActivity`
      || !view.nodes.some(node => node.id === `${androidDevice.package}:id/tvCheck` && node.text === '1')
      || !view.nodes.some(node => node.id === `${androidDevice.package}:id/ps_tv_preview` && node.text === '已选1/1')
      || !view.nodes.some(node => node.id === `${androidDevice.package}:id/ps_tv_complete` && node.text === '下一步')) {
      throw new Error('没有核验到唯一已选头像，本次未继续提交。');
    }
    await tapHeyboxNode(view, `${androidDevice.package}:id/ps_complete_select`);
    return readHeyboxView();
  }
  async function completeAvatarCrop(path) {
    await verifySoleAvatarFile(path);
    const view = await readHeyboxView();
    if (!expectedAccountId || view.activity !== `${androidDevice.package}/com.starlightc.ucropplus.ui.UCropPlusActivity`
      || !view.nodes.some(node => node.id === `${androidDevice.package}:id/tv_crop_title` && node.text === '剪裁')
      || !view.nodes.some(node => node.id === `${androidDevice.package}:id/tv_crop_ratio` && node.text === '头像')) {
      throw new Error('当前不是已核验的头像裁剪页。');
    }
    await tapHeyboxNode(view, `${androidDevice.package}:id/iv_check`);
    return readHeyboxView();
  }
  async function finishAvatarEditor(path) {
    await verifySoleAvatarFile(path);
    const view = await readHeyboxView();
    if (view.activity !== `${androidDevice.package}/com.starlightc.ucropplus.ui.UCropPlusActivity`
      || !view.nodes.some(node => node.text === '1/1')
      || !view.nodes.some(node => node.id === `${androidDevice.package}:id/btn_next` && node.text === '下一步')) {
      throw new Error('当前不是唯一头像的最终图片编辑页。');
    }
    await tapHeyboxNode(view, `${androidDevice.package}:id/btn_next`);
    return readHeyboxView();
  }
  async function submitHeyboxAvatar({ path, profile } = {}) {
    const avatar = await verifySoleAvatarFile(path);
    const guarded = avatarGuard(avatar.sha256);
    if (guarded) return { submitted: false, accountVerified: true, ...guarded };
    const view = profileEditorView(await readHeyboxView());
    if (!profile || typeof profile.nickname !== 'string' || typeof profile.signature !== 'string'
      || view.nodes.find(node => node.id === `${androidDevice.package}:id/et_nick`)?.text !== profile.nickname
      || view.nodes.find(node => node.id === `${androidDevice.package}:id/et_signature`)?.text !== profile.signature) {
      throw new Error('头像保存前昵称或签名与原资料不一致，本次未提交。');
    }
    if (!view.nodes.some(node => node.id === `${androidDevice.package}:id/tv_appbar_action` && node.text === '保存' && node.enabled)) throw new Error('没有取得头像资料保存按钮。');
    const state = { sha256: avatar.sha256, attemptedAt: new Date().toISOString(), outcome: 'pending' };
    saveAvatarState(state);
    try {
      await tapHeyboxNode(view, `${androidDevice.package}:id/tv_appbar_action`);
      await waitForProfileSave('头像');
      const home = await refreshHeybox();
      saveAvatarState({ ...state, outcome: 'success', confirmation: 'app_receipt' });
      return { submitted: true, accountVerified: home.accountVerified, sha256: avatar.sha256,
        message: '已提交头像资料并刷新个人主页；头像最终显示及审核结果以平台为准。' };
    } catch (error) {
      saveAvatarState({ ...state, outcome: 'unknown' });
      throw error;
    }
  }
  async function resetAvatarSetup() {
    for (let attempt = 0; attempt < 4; attempt++) {
      let view;
      try { view = await readHeyboxView(); }
      catch (error) {
        if (!/请先在 MuMu 专用设备中打开小黑盒|活动窗口/.test(error.message)) throw error;
        view = await readAvatarAccessView();
      }
      if (view.source === 'android_avatar_access') {
        if (view.nodes.some(node => node.id === 'com.android.permissioncontroller:id/permission_message' && avatarPermissionMessages.includes(node.text))) {
          const cancel = view.nodes.filter(node => (node.id === 'com.android.permissioncontroller:id/permission_dont_allow_more_selected_button' && node.text === '不选择其他数据')
            || (node.id === 'com.android.permissioncontroller:id/permission_deny_button' && node.text === '不允许'));
          if (cancel.length !== 1) throw new Error('没有可核验的图片权限取消按钮。');
          await tapHeyboxNode(view, cancel[0].id);
        } else if (view.nodes.some(node => node.id === 'com.android.providers.media.module:id/privacy_text' && node.text === '选择允许此应用访问的照片和视频')) {
          const cancel = view.nodes.filter(node => node.description === '取消' && node.clickable && node.className === 'android.widget.ImageButton');
          if (cancel.length !== 1) throw new Error('没有可核验的图片选择取消按钮。');
          await tapHeyboxTarget(view, cancel[0]);
        } else throw new Error('当前图片权限页面不符合预期，本次未继续操作。');
      } else if (view.activity === `${androidDevice.package}/com.max.mediaselector.lib.basic.PictureSelectorSupporterActivity`) {
        await tapHeyboxNode(view, `${androidDevice.package}:id/ps_iv_left_back`);
      } else return;
    }
    throw new Error('尚未退出上次图片选择，请先回到小黑盒“我”页面。');
  }
  async function updateHeyboxAvatar(path) {
    const avatar = avatarFile(path);
    await resetAvatarSetup();
    await ownProfileHome();
    const guarded = avatarGuard(avatar.sha256);
    if (guarded) return { submitted: false, accountVerified: true, ...guarded };
    const editor = await profileEditor();
    const profile = { nickname: editor.nodes.find(node => node.id === `${androidDevice.package}:id/et_nick`).text,
      signature: editor.nodes.find(node => node.id === `${androidDevice.package}:id/et_signature`).text };
    await stageAvatar(path);
    let view = await avatarPicker(editor);
    if (view.nodes.some(node => node.id === 'android:id/message' && node.text === '【图片选择器需要授予访问存储权限】')) view = await requestSelectedAvatarAccess(view);
    if (view.source === 'android_avatar_access') {
      if (view.nodes.some(node => node.id === 'com.android.permissioncontroller:id/permission_allow_selected_button')) await beginLimitedAvatarSelection();
      await selectOnlyAvatarPhoto(path);
      await finishLimitedAvatarAccess(path);
    }
    await selectHeyboxAvatar(path);
    await openAvatarCrop(path);
    await completeAvatarCrop(path);
    await finishAvatarEditor(path);
    return submitHeyboxAvatar({ path, profile });
  }
  return {
    check,
    inspectHeybox: () => exclusive(readHeyboxView),
    openHeyboxProfile: () => exclusive(openHeyboxProfile),
    openHeyboxHome: () => exclusive(ownProfileHome),
    openHeyboxComposer: () => exclusive(openHeyboxComposer),
    openHeyboxTimeline: () => exclusive(openHeyboxTimeline),
    inspectHeyboxPost: post => exclusive(() => inspectHeyboxPost(post)),
    openHeyboxTopics: () => exclusive(openHeyboxTopics),
    searchHeyboxTopics: query => exclusive(() => searchHeyboxTopics(query)),
    selectHeyboxTopic: topic => exclusive(() => selectHeyboxTopic(topic)),
    closeHeyboxTopics: topic => exclusive(() => closeHeyboxTopics(topic)),
    prepareHeyboxPost: (post, options) => exclusive(() => prepareHeyboxPost(post, options)),
    publishHeyboxPost: (post, options) => exclusive(() => publishHeyboxPost(post, options)),
    openHeyboxArticle: url => exclusive(() => openHeyboxArticle(url)),
    readHeyboxArticle: (url, options) => exclusive(() => readHeyboxArticle(url, options)),
    openHeyboxComments: (url, options) => exclusive(() => openHeyboxComments(url, options)),
    readHeyboxComments: (url, options) => exclusive(() => readHeyboxComments(url, options)),
    openHeyboxCommentReply: (url, options) => exclusive(() => openHeyboxCommentReply(url, options)),
    prepareHeyboxComment: (comment, options) => exclusive(() => prepareHeyboxComment(comment, options)),
    publishHeyboxComment: (comment, options) => exclusive(() => publishHeyboxComment(comment, options)),
    discardHeyboxCommentDraft: comment => exclusive(() => discardHeyboxCommentDraft(comment)),
    openHeyboxSettings: () => exclusive(profileSettings),
    openHeyboxEditor: () => exclusive(profileEditor),
    updateHeyboxProfile: input => exclusive(() => updateHeyboxProfile(input)),
    updateHeyboxAvatar: path => exclusive(() => updateHeyboxAvatar(path)),
    inspectAvatarAccess: () => exclusive(readAvatarAccessView),
    refreshHeybox: () => exclusive(async () => ({ accountVerified: (await refreshHeybox()).accountVerified,
      refreshed: true, message: '已重新打开专用小黑盒应用并核对账号，登录数据保留。' })),
    captureHeybox: () => exclusive(async () => {
      const view = await readHeyboxView();
      if (/login|register|password/i.test(view.activity) || view.nodes.some(node => node.text === '[密码字段已隐藏]')) {
        throw new Error('登录或密码界面不生成项目截图。');
      }
      const path = join(root, 'logs', `heybox-${randomUUID()}.png`);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      try {
        await sdkCommand(serial => ['screen', 'capture', `--device=${serial}`, `--output=${path}`]);
        const current = await readHeyboxView();
        if (current.activity !== view.activity) throw new Error('截图时小黑盒界面已变化，本次截图未保留。');
        if (!existsSync(path) || statSync(path).size > 8 * 1024 * 1024
          || !readFileSync(path).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
          throw new Error('项目截图未通过 PNG 格式与大小核验。');
        }
        return { path, message: '已保存专用小黑盒界面的本机截图。' };
      } catch (error) {
        if (existsSync(path)) unlinkSync(path);
        throw error;
      }
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
