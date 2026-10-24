# 飞书文本接入（实验功能）

栖忆可通过原版 `dsh-im 5.4.0` 接收飞书或 Lark 的文本私聊，以及获准群内 @ 机器人的消息，并回复原消息位置。人格、身份、聊天记录和记忆由栖忆管理。当前不接入附件、图片、语音、群历史补抓或主动群发。已完成本地模拟平台联调；部署后仍需用自己的应用验证真实连接与消息权限。

此功能默认关闭。启用后会增加一个独立的常驻 Node.js 进程。主服务支持 Node.js 22.16 或更新版本；飞书连接宿主需要 Node.js 24。两者均须由服务用户访问，Linux systemd 部署时不要放在被 `ProtectHome` 屏蔽的个人家目录。

## 1. 安装独立连接环境

在新的专用目录安装，勿使用已有 DSH 个人资料目录。仓库的 `deploy/feishu-host` 提供固定依赖清单和锁文件，不影响主项目依赖。先在使用 Node.js 24 的终端确认 `node --version`，再安装。

Windows PowerShell，在栖忆项目目录执行：

```powershell
$feishuHostDir = 'D:\MemoriaRuntime\feishu-host'
New-Item -ItemType Directory -Force -Path $feishuHostDir | Out-Null
Copy-Item -LiteralPath .\deploy\feishu-host\package.json -Destination $feishuHostDir
Copy-Item -LiteralPath .\deploy\feishu-host\package-lock.json -Destination $feishuHostDir
curl.exe --fail --location 'https://codeload.github.com/xmanrui/dsh-im/tar.gz/e5b4f2bcbf781a59e54f9844d3dcb26648e0b103' --output "$feishuHostDir\dsh-im-5.4.0-e5b4f2bc.tgz"
if ((Get-FileHash -LiteralPath "$feishuHostDir\dsh-im-5.4.0-e5b4f2bc.tgz" -Algorithm SHA256).Hash -ne 'B95E28347870B1047E84C6EA5B559C953332D0091CC8DD034B0415EEF3CE4058') { throw '下载文件校验失败，请停止安装。' }
Push-Location $feishuHostDir
npm.cmd ci --ignore-scripts --no-fund --no-audit
Pop-Location
```

Linux，在栖忆项目目录执行，路径按自己的部署修改：

```bash
feishu_host_dir=/opt/memoria-feishu-host
mkdir -p "$feishu_host_dir"
cp deploy/feishu-host/package.json deploy/feishu-host/package-lock.json "$feishu_host_dir/"
curl --fail --location 'https://codeload.github.com/xmanrui/dsh-im/tar.gz/e5b4f2bcbf781a59e54f9844d3dcb26648e0b103' --output "$feishu_host_dir/dsh-im-5.4.0-e5b4f2bc.tgz"
printf '%s  %s\n' 'b95e28347870b1047e84c6ea5b559c953332d0091cc8dd034b0415eef3ce4058' "$feishu_host_dir/dsh-im-5.4.0-e5b4f2bc.tgz" | sha256sum --check -
cd "$feishu_host_dir"
npm ci --ignore-scripts --no-fund --no-audit
```

校验或安装失败时停止后续操作。连接器会再次检查固定插件版本及入口文件；不要自行覆盖包内代码或升级其中的 DSH。

## 2. 核对应用身份

按 [dsh-im 的飞书说明](https://github.com/xmanrui/dsh-im) 准备机器人应用、消息权限与长连接事件订阅。应用凭据用于栖忆自己的机器人，不能认定谁是创建人。

在本机数据目录创建 `feishu-credentials.json`，只填写以下三项。`domain` 选 `feishu` 或 `lark`。不要把密钥发到聊天或提交到 GitHub；Linux 以服务运行用户创建文件并设置权限 `0600`。

```json
{
  "appId": "cli_example",
  "appSecret": "在本机填写真实应用密钥",
  "domain": "feishu"
}
```

回到栖忆项目目录执行预检，示例为 Windows；Linux 使用对应绝对路径：

```powershell
node scripts/feishu-setup.js --host-directory D:\MemoriaRuntime\feishu-host --credential-path D:\Memoria\data\feishu-credentials.json --bot-id memoria-feishu
```

预检只核对应用身份，不调用模型或发送聊天消息。成功后会把平台返回的 `botOpenId` 写回凭据文件，并输出 `botId`、`expectedFingerprint`、机器人名称和平台的原始启用状态。把前两项填入后台；不要自行填写未经核对的机器人 Open ID。凭据在预检期间被修改时，预检不会覆盖它。

## 3. 配置并连接

在栖忆数据目录创建 `feishu-runtime.json`。以下均为部署机器的绝对路径；`nodePath` 指向 Node.js 24，`profileDirectory` 必须是新的空目录或此功能之前创建的专用目录，且位于连接环境和凭据文件之外。

```json
{
  "nodePath": "D:/Node24/node.exe",
  "hostDirectory": "D:/MemoriaRuntime/feishu-host",
  "profileDirectory": "D:/MemoriaRuntime/feishu-profile",
  "credentialPath": "D:/Memoria/data/feishu-credentials.json"
}
```

Linux systemd 示例可使用 `/opt/node24/bin/node`、`/opt/memoria-feishu-host`、`/var/lib/persona-agent/feishu-profile` 和 `/var/lib/persona-agent/feishu-credentials.json`。专用资料目录需要服务用户可写；安装目录只需可读。平台密钥和专用资料目录不进入记忆备份。

在“人格与设置 → 飞书文本聊天”填写预检结果及白名单，保存开启。私聊白名单填写用户的 Open ID，群白名单填写 Chat ID；显示昵称不能作为白名单标识。群内普通成员 @ 机器人即可参与。只有创建人通过私聊身份验证后，才可使用创建人的私人书架；即使创建人在群里发言，也只使用当前群的记忆。

首次连接失败时，核对应用发布状态、权限、网络和本机文件，再点击“重新连接”。账号指纹不一致时会停止连接，不会自动接受新账号。修改账号或取消接入会终止尚未发送的工作；已经发起的发送可能无法撤回。

## 4. 绑定创建人并验证聊天

连接就绪后，在后台生成创建人绑定命令。用你自己的飞书账号与机器人私聊发送，十分钟内有效且只能使用一次；不需要先加入普通私聊白名单。群内发送或仅自称创建人不会绑定。

绑定命令不触发模型回复。发送后，到“身份与备份”刷新账号列表确认，再私聊发送一句话；随后在白名单测试群内 @ 机器人，确认双方消息和记忆范围正确。绑定与机器人应用凭据分别管理。

## 主动私聊与约定跟进

先完成创建人绑定，再在飞书私聊中发送一条新消息，建立可核对的原会话来源。开启“主动私聊”后，可以在这段私聊延续近况，也可明确说“明晚20:00问问我考试情况”等跟进约定。原渠道、账号或连接不再有效时保持安静，不改发 QQ；不在群内主动群发。

日常也可以在创建人私聊里说“先别主动找我”“可以主动找我聊天了”或“主动聊天每天最多2次”，调整与 QQ 共用的主动陪伴偏好。仅调整本条明确给出的字段，不清空已用额度、已有约定或未回应记录；暂停需明确恢复，调整频率不会自行开启。限时暂停、未来自动开启或含糊的“多一点、少一点”会先澄清。飞书应用与账号接入仍须在本机后台配置。

主动聊天与 QQ 共用主动私聊的时段、冷却、每日发送次数和判断次数，并占飞书智能对话额度及全局模型额度，不占公开表达的 80 次额度。普通回复仍回复原消息；主动消息使用原版宿主独立的受检发送能力，只把核对过的发送回执记作成功，结果未知不重发。此流程已做本地模拟平台验证，真实应用的消息权限仍需部署者验证。

升级前没有来源标识的旧聊天不会被猜作 QQ 或飞书。备份保留对话中的来源资料，但不携带飞书本机收件执行记录；在新实例恢复后，请重新配置、验证账号，并在新的飞书私聊中重新明确约定。旧的飞书约定保留为暂停状态，不把它迁到其他渠道。

## 额度、重启与备份

飞书智能对话默认每天最多尝试 200 次，可在后台设为 0–1000，按 UTC 日期计数，独立于 QQ 额度。入站聊天和主动拟聊共用此额度，生成前预留一次，失败或主动选择安静也不退回；所有实际模型请求继续共用后台设置的每日模型总额度（默认 3000 次）。聊天与自主公开发布分别计数。

消息接收记录、处理状态和已用聊天额度保留在本机。重复投递不会再次处理；重启后，尚未开始处理的消息可重新核对当前权限后继续，已经开始处理但中断的消息不会自动重新生成，发送结果未知时不会重发。高流量下旧消息的回复位置可能过期，届时安全停止本次回复。

普通回复取得有效的平台发送回执后，才将助手正文保存为已完成聊天。发送失败或结果未知时，仍保留用户输入和处理记录，不把待发送草稿当作双方已经说过的话。平台已确认发送但本机归档失败时，不重新生成或重发；回执也不表示对方已经阅读。身份、来源或资料在途中失效时，不把旧结果补入新会话。

人格和已保存的对话、记忆随现有加密备份保存；平台凭据、收件执行记录和本机计数不随记忆备份迁移。原实例恢复旧备份不会清空这些执行记录或已用额度，恢复会关闭飞书并清除账号绑定。新机器须重新配置并核验身份，不能从旧备份推断之后实际发生的发送。
