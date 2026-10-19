# Windows 与 Linux 部署

Memoria 使用 Node.js 22.16 或更新版本、npm 和 Node 内置 SQLite。Linux 启停脚本需要 Bash 4.4+ 和已挂载的 `/proc`，不依赖 Docker。请安装对应系统与 CPU 架构的 Node.js，再执行 `node --version` 确认版本；不要把 Windows 的 Node 或 `node_modules` 目录复制到 Linux。

小黑盒自主浏览另需 Playwright 的 Chromium headless shell。浏览器系统要求比纯聊天更严格，建议选择官方支持的 Windows 11 / Windows Server 2019 或更新版本，以及 Debian 12/13、Ubuntu 22.04/24.04/26.04；Linux 使用 x86-64 或 arm64。具体支持范围以 [Playwright 系统要求](https://playwright.dev/docs/intro#system-requirements)为准。

程序只监听 `127.0.0.1:3210`。本地管理后台需先设置管理员密码，模型 API、QQ 登录和云盘授权分别配置。部署程序不会自动登录这些外部账号。

后台用于配置与管理；完成 QQ 绑定后，创建人可通过私聊进行日常对话、发 TXT 收书和查询阅读进度。无需每次打开后台。

## 代码包与数据

将 `src/`、`public/`、`scripts/`、`deploy/`、`docs/`、`package.json`、`package-lock.json`、Windows 的 `*.cmd`、许可文件和文档作为程序包。包中不包含 `data/`、`backups/`、`node_modules/`、`.env`、日志、数据库、`.pab` 备份或真实账号凭据。在目标机器的项目目录执行：

```bash
npm ci --ignore-scripts --no-fund --no-audit
npm run check
```

程序数据默认位于项目的 `data/`。Linux 脚本支持 `PERSONA_DATA_DIR` 指定独立数据目录；启动与停止时必须使用同一目录。`PERSONA_BACKUP_DIR` 指定自动备份目录。systemd 模板把两者分别设置为 `/var/lib/persona-agent` 和 `/var/lib/persona-agent-backups`，避免程序安装目录需要写权限。自动备份目录必须独立于数据目录，不能设成数据目录本身或其子目录。

## 自主浏览器安装

只有小黑盒自主浏览需要浏览器二进制。QQ 聊天、识图、表情与普通 HTML 阅读可以先行使用；识图还取决于模型是否支持视觉输入。

Windows 在已安装依赖的项目目录执行：

```powershell
npm.cmd run browser:install
```

Linux 桌面或普通用户部署，可一次安装浏览器和系统依赖：

```bash
npx playwright install --with-deps chromium --only-shell
```

这条命令可能为系统软件包申请管理员权限；日常运行浏览器须使用普通用户，并保持 Chromium 沙箱开启。不要用 `--no-sandbox` 或关闭 `chromiumSandbox` 处理启动错误。systemd 专用用户的安装方式见下节。[Playwright 浏览器安装说明](https://playwright.dev/docs/browsers#install-system-dependencies)、[无界面浏览器安装选项](https://playwright.dev/docs/browsers#chromium-headless-shell)。

浏览器默认保存在当前用户的 Playwright 缓存中。自定义缓存时，安装和启动必须使用同一个 `PLAYWRIGHT_BROWSERS_PATH`，且运行用户能读取、执行其中的文件。例如 Linux：

```bash
export PLAYWRIGHT_BROWSERS_PATH="$HOME/.cache/memoria-browsers"
npm run browser:install
bash scripts/start.sh
```

Windows 可在同一 PowerShell 窗口设置 `$env:PLAYWRIGHT_BROWSERS_PATH`，再安装并执行 `.\start.cmd`；若改用双击启动，请把相同地址设置为 Windows 用户环境变量。程序不会替你更改系统环境变量。[Playwright 缓存说明](https://playwright.dev/docs/browsers#managing-browser-binaries)。

升级 Playwright 依赖后，按同样的缓存路径重新运行浏览器安装命令。若出现“浏览器无法启动”，先确认运行用户、缓存路径与 Linux 系统依赖；沙箱报错还需检查宿主机、容器或 AppArmor 对非特权用户命名空间的限制。使用普通用户和有效沙箱运行，不通过关闭沙箱继续访问网页。[Playwright 浏览不可信网站的运行建议](https://playwright.dev/docs/docker#crawling-and-scraping)。

## Windows 安装与运行

选择自己有读写权限的安装目录。安装依赖后双击 `start.cmd` 后台启动，`stop.cmd` 停止。访问 `http://127.0.0.1:3210`，使用 `data\setup-key.txt` 中的初始化码设置管理员密码。日志位于 `data\server.log` 与 `data\server.err.log`。

## Linux 安装与运行

将程序放在自己有写权限的目录，例如 `~/persona-agent`，安装依赖后运行：

```bash
bash scripts/start.sh
bash scripts/stop.sh
```

以上两条命令分别用于启动和停止，按需要单独执行。请使用 `bash` 调用。

运行日志保存在数据目录的 `server.log` 和 `server.err.log`。

使用独立数据目录时：

```bash
PERSONA_DATA_DIR="$HOME/.local/share/persona-agent" bash scripts/start.sh
PERSONA_DATA_DIR="$HOME/.local/share/persona-agent" bash scripts/stop.sh
```

初始化码位于所选数据目录的 `setup-key.txt`。日志可用 `tail -n 100 data/server.err.log` 查看。若提示 `.start.lock` 已存在，先确认没有另一个启动脚本运行，再用 `rmdir` 删除提示中的空锁目录；不要删除数据目录。无法确认 PID 文件指向谁时，先检查进程，不要直接杀进程。

## Linux systemd 长期运行

以下以 Debian/Ubuntu 为例，程序目录 `/opt/persona-agent`，专用运行用户 `persona-agent`。先把不含私密数据的代码包解压或复制到该目录，确认当前 Node 版本和安装路径：

```bash
command -v node
node --version
```

模板默认使用 `/usr/bin/node`。若实际路径不同，修改 `deploy/persona-agent.service` 中的 `ExecStart`，并同步替换下方命令中的 Node 路径。Node 必须是服务用户可访问的系统安装，不能指向个人家目录中的 nvm 路径，因为模板启用了 `ProtectHome=yes`。同样不要把程序或浏览器缓存安装在个人家目录后直接使用此模板。

新机器没有 `persona-agent` 用户时创建一次，然后在项目目录安装依赖并安装服务：

```bash
sudo useradd --system --user-group --home-dir /var/lib/persona-agent --no-create-home --shell /usr/sbin/nologin persona-agent
cd /opt/persona-agent
sudo npm ci --ignore-scripts --no-fund --no-audit
sudo chown -R root:root /opt/persona-agent
sudo chmod -R a+rX /opt/persona-agent
sudo /usr/bin/node node_modules/playwright/cli.js install-deps chromium
sudo install -d -m 0700 -o persona-agent -g persona-agent /var/cache/persona-agent-browsers
sudo -u persona-agent env PLAYWRIGHT_BROWSERS_PATH=/var/cache/persona-agent-browsers /usr/bin/node node_modules/playwright/cli.js install chromium --only-shell
sudo install -m 0644 deploy/persona-agent.service /etc/systemd/system/persona-agent.service
sudo systemd-analyze verify /etc/systemd/system/persona-agent.service
sudo systemctl daemon-reload
sudo systemctl enable --now persona-agent
sudo systemctl status persona-agent --no-pager
```

只对这个新部署、仅包含程序代码的 `/opt/persona-agent` 目录执行上述权限命令。已有数据应迁移到 `/var/lib/persona-agent`，不要将私密数据设置为所有用户可读。服务的 `StateDirectory` 会创建归 `persona-agent` 所有、权限均为 `0700` 的数据目录和独立备份目录；`CacheDirectory` 管理独立浏览器缓存。`ProtectSystem=strict` 使程序目录只读，数据、备份、浏览器缓存和隔离的临时目录保持可写。备份恢复密码与服务机凭据仍应由创建人保管。

模板设置 `PLAYWRIGHT_BROWSERS_PATH=/var/cache/persona-agent-browsers`，并保留 `NoNewPrivileges=yes`；没有禁止 Chromium 所需的用户命名空间。宿主系统仍须允许普通用户创建浏览器沙箱。可以先在项目目录用实际服务用户检查无界面浏览器启动：

```bash
sudo -u persona-agent env PLAYWRIGHT_BROWSERS_PATH=/var/cache/persona-agent-browsers /usr/bin/node --input-type=module -e "import { chromium } from 'playwright'; const browser = await chromium.launch({ headless: true, chromiumSandbox: true }); await browser.close();"
```

这只检查浏览器能否启动。服务启动后，再在后台手动发起一次小黑盒活动，核对实际结果；站点登录或验证码限制仍可能使访问失败。

查看初始化码与日志、停止和重启服务：

```bash
sudo cat /var/lib/persona-agent/setup-key.txt
sudo journalctl -u persona-agent -n 100 --no-pager
sudo systemctl stop persona-agent
sudo systemctl restart persona-agent
```

服务由 systemd 管理时使用 `systemctl`，不要再运行 `start.sh` 或 `dev.sh` 启动第二份进程。systemd 模板等待停止最多 20 秒，且关闭自动 `SIGKILL`；停止失败时先检查日志和进程再处理。升级前先导出加密备份，停止服务，更新程序文件并重新执行 `npm ci --ignore-scripts`；若 Playwright 版本变化，也以服务用户更新同一缓存内的浏览器，最后重启。

## 远程服务器访问

在自己的电脑终端建立 SSH 隧道，将以下示例中的登录名和服务器地址替换为实际值：

```bash
ssh -N -L 3210:127.0.0.1:3210 your-user@your-server
```

保持终端开启，浏览器访问 `http://127.0.0.1:3210`。服务会核验 HTTP Host，因此本地隧道端口也须使用 `3210`。如果本机已有 Memoria，占用同一端口，先停止本机实例。无需公开 `3210` 端口或修改服务监听地址。QQ 协议端推荐部署在同一机器，通过回环地址连接；Windows NapCat 不能直接通过自身的 `127.0.0.1` 连接另一台 Linux 服务器。

## 跨平台迁移

从旧实例后台导出 `.pab` 加密备份，在目标系统安装相同或兼容版本，初始化新管理员后预览并恢复。备份内容是加密的结构化 JSON，由目标系统重建 SQLite 数据，适合 Windows 与 Linux 之间迁移。恢复后需重新填写模型与平台凭据、核验账号绑定并开启外部接入；不要在程序运行中只复制单个 `.sqlite` 文件，以免遗漏 WAL 中的数据。

创建人上传的表情、QQ 收藏的表情图片、各自可用范围和删除记录随加密备份迁移；这些个人图片不进入公开源码。内置表情随程序源码分发。浏览器二进制不在备份中，须在目标系统另行安装；不要把 Windows 的浏览器缓存复制给 Linux 使用。

书籍正文、阅读位置和已保存的笔记也随加密备份迁移。目标系统恢复后，先核对书房和账号绑定，再按需重新开启自主读书、自主浏览、自主表达与自动备份。

## 读书与自主表达配置

书房支持 UTF-8 TXT（单个不超过 1 MiB，较大书籍分章导入）和单个 HTTPS 网页正文。创建人可在绑定 QQ 的私聊中发送 TXT，或明确提供本条消息中的网址让她收录；也可在后台上传或导入。QQ TXT 自动收书和后台导入本身不调用模型，通过聊天导入网址会使用正常的模型工具调用与回复额度。收录不会将整本正文写入聊天记录。群聊不可访问创建人的私人书房。

启用自主读书后，默认每天最多 2 次、每次约 3000 字符，在 `Asia/Shanghai` 时区的 09:00–23:00 随机安排，可在后台调整。每次笔记输出最多 700 tokens，与聊天共用模型额度。服务停止时不会阅读；在线导入只收录当前页，不追抓整站或其他章节。创建人日常可通过聊天查书架、阅读位置、笔记，或指定一本书读一小段。聊天阅读同样要求启用自主读书，并与定时阅读共用每日读书额度。

自主表达与阅读分别设置。当前可用动作是 QQ 空间动态、签名和头像，需要协议端提供相应能力；可分别开关并调整次数、时段和间隔。模型也可以选择暂时不表达。目前没有其他社交平台的发布适配。绘图 API 只保留配置入口，尚不调用；保留密钥为空不影响现有聊天、阅读和内置表情。

参考：[Node.js 下载](https://nodejs.org/en/download)、[systemd 执行环境与 StateDirectory](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)。
