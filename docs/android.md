# 小黑盒专用安卓设备

Windows 上可使用项目命令管理专用 MuMu 设备、打开小黑盒、核对账号 ID，以及设置昵称、签名和初始头像。这些命令通过 MuMu 官方管理工具和 Android 接口执行，可由本机脚本独立调用。当前入口尚未接入聊天工具、定时发帖或评论。

MuMu 是可选的 Windows 设备环境；Memoria 主服务仍可部署在 Windows、Linux。本页的 MuMu 命令已在 MuMu 6.8.7、Android 15、小黑盒 1.3.398 上实机核验，不代表 MuMu 可以在 Linux 上运行。

## 首次配置

1. 从 [MuMu 官网](https://mumu.163.com/) 安装模拟器，接受其许可，建立一个只供 Memoria 使用的设备。
2. 在该设备安装官方小黑盒应用，并完成首次登录、验证码等步骤。登录由小黑盒应用处理，项目不读取密码或导出登录凭据。
3. 找到安装目录中的 `nx_main/MuMuManager.exe`。以下 PowerShell 示例假定它安装在 D 盘：

```powershell
& 'D:\Program Files\Netease\MuMu\nx_main\MuMuManager.exe' info -v all
& 'D:\Program Files\Netease\MuMu\nx_main\MuMuManager.exe' info -v 2
```

将 `2` 换成专用设备编号。记录该设备返回的 `index`、`created_timestamp`、`name` 和 `android_version`。

在项目的私有数据目录创建 `android-runtime.json`。将下面示例的路径、编号、创建时间和名称换成实际值；`androidVersion` 使用 `12` 或 `15`，例如设备返回 `15.0` 时填写 `15`。

```json
{
  "provider": "mumu",
  "root": "D:\\memoria-runtime\\android",
  "manager": "D:\\Program Files\\Netease\\MuMu\\nx_main\\MuMuManager.exe",
  "index": "2",
  "createdTimestamp": 1700000000000000,
  "deviceName": "MemoriaHeybox",
  "androidVersion": "15"
}
```

`root` 是本机安卓资源目录。默认数据目录是项目的 `data`；设置 `PERSONA_DATA_DIR` 时，应将配置文件放入该目录。该配置属于本机私有数据，不应上传 GitHub。设备编号、创建时间、名称或 Android 版本不匹配时，项目会停止操作，不会自动选择其他设备。

## 运行命令

在项目目录执行：

```powershell
node scripts/android.js check
```

关闭专用安卓设备后，可应用轻量配置：

```powershell
node scripts/android.js configure
```

这会将该设备设为 2 核、2 GiB 内存、720 × 1280 分辨率，并回读核验。启动前还会检查可用内存；设备已运行时不会重复启动。

```powershell
node scripts/android.js setup
node scripts/android.js check
node scripts/android.js profile
```

`setup` 等待 Android 启动，再请求打开小黑盒。新部署请先按上面的步骤安装官方应用；自动安装仅使用资源目录中已有来源、包名和 SHA256 核验记录的 APK，缺少核验记录时会停止。

`profile` 从小黑盒主界面的“我”入口读取账号卡片，返回 `accountId`。首次读取的 `accountVerified` 为 `false`；确认这是机器人的专用账号后，将返回的 ID 作为字符串填入配置的 `expectedAccountId`。再次执行时，只有 ID 相符才返回 `accountVerified: true`。它核对的是当前操作账号，不会授予创建人权限。界面或账号不符合预期时会停止。

## 设置账号资料

资料修改需要额外安装 [Google Android CLI](https://developer.android.com/tools/agents/android-cli) 和 SDK Platform Tools。将 SDK 放在 `<root>/sdk`，确认 `<root>/sdk/platform-tools/adb.exe` 可用。在本机配置中将 `androidCli` 填为官方 `android-cli.exe` 或 `android.exe` 的绝对路径；未填写时默认使用 `<root>/user/bin/android-cli.exe`。项目使用独立的本机 ADB 5039 端口，首次使用可能需要安装 CLI 的界面交互组件。

在已绑定专用账号的配置中增加以下字段；示例 ID 必须换成你实际核对过的 ID，头像路径换成你自己的 PNG：

```json
{
  "expectedAccountId": "12345678",
  "androidCli": "D:\\memoria-runtime\\android\\user\\bin\\android-cli.exe",
  "profile": {
    "nickname": "你的机器人昵称",
    "signature": "慢慢收集值得记住的日常。"
  },
  "avatar": "D:\\memoria-assets\\avatar.png"
}
```

将这些字段合并到原有配置中，保留 `provider`、设备绑定等字段。以上内容属于本机私有配置。

```powershell
node scripts/android.js profile-apply
node scripts/android.js avatar-apply
```

`profile-apply` 只修改 `profile` 中指定的昵称或签名；昵称最多 20 个字符、签名最多 80 个字符，平台还可能要求昵称唯一或进行审核。输入后先回读文字，保存后重新打开应用，从个人主页核对。内容已相同时不重复保存。

`avatar-apply` 用于专用设备的初始头像设置，接受 8 MiB 以内的本机 PNG。它核对文件哈希，只通过 Android 的有限图片访问选择该头像，并使用应用默认的头像裁剪。当前要求设备媒体库中只有这张待选图片；存在其他图片、权限选项或页面不符合预期时停止，需要在专用模拟器中人工核对。不要用存有个人照片的日常设备代替专用设备。

头像流程保存前核对昵称和签名没有变化，保存后刷新应用并核对账号。返回 `submitted: true` 表示已提交资料，头像实际显示与审核结果仍以平台为准。命令失败或结果未确认时，先检查应用当前页面，避免循环重试。

项目按绑定账号和设备在 `<root>/user/heybox-avatar-state.json` 保存本机记录：同一头像已有成功记录时返回 `skipped: unchanged`；其他头像在最近提交后 7 天内返回 `skipped: cooldown`。未确认的提交也计入冷却，防止重复请求。平台可能另有限制，以应用提示为准。同图去重依据本机记录，不能检测在其他客户端手动更换的头像。请逐条运行安卓命令，避免同时操作同一模拟器。

其他命令：

```powershell
node scripts/android.js start
node scripts/android.js open
node scripts/android.js inspect
node scripts/android.js home
node scripts/android.js refresh
node scripts/android.js capture
node scripts/android.js stop
```

`inspect` 返回当前小黑盒界面的结构化信息，隐藏密码字段和手机号，并删除临时界面快照。`home` 返回已核对专用账号的“我”页面；`refresh` 重新打开应用并核对账号，保留登录数据。`capture` 只在小黑盒非登录界面生成本机 PNG，保存在 `<root>/logs`，查看后可自行删除。`stop` 区分已请求关闭与实际关闭状态。界面结构变化、登录失效或出现其他应用时，应先核对实际页面，再重试相应命令。

MuMu、系统镜像和小黑盒应用需要单独安装，本仓库不分发这些软件。MuMu 命令说明见 [官方开发者文档](https://mumu.163.com/help/20240726/35047_1170006.html)。
