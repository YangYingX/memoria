# Windows 与 Linux 部署

Memoria 使用 Node.js 22.16 或更新版本、npm 和 Node 内置 SQLite。Linux 启停脚本需要 Bash 4.4+ 和已挂载的 `/proc`，不依赖 Docker。请安装对应系统与 CPU 架构的 Node.js，再执行 `node --version` 确认版本；不要把 Windows 的 Node 或 `node_modules` 目录复制到 Linux。

程序只监听 `127.0.0.1:3210`。本地管理后台需先设置管理员密码，模型 API、QQ 登录和云盘授权分别配置。部署程序不会自动登录这些外部账号。

## 代码包与数据

将 `src/`、`public/`、`scripts/`、`deploy/`、`docs/`、`package.json`、`package-lock.json`、Windows 的 `*.cmd`、许可文件和文档作为程序包。包中不包含 `data/`、`backups/`、`node_modules/`、`.env`、日志、数据库、`.pab` 备份或真实账号凭据。在目标机器的项目目录执行：

```bash
npm ci --ignore-scripts --no-fund --no-audit
npm run check
```

程序数据默认位于项目的 `data/`。Linux 脚本支持 `PERSONA_DATA_DIR` 指定独立数据目录；启动与停止时必须使用同一目录。`PERSONA_BACKUP_DIR` 指定自动备份目录。systemd 模板把两者分别设置为 `/var/lib/persona-agent` 和 `/var/lib/persona-agent-backups`，避免程序安装目录需要写权限。自动备份目录必须独立于数据目录，不能设成数据目录本身或其子目录。

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

模板默认使用 `/usr/bin/node`。若实际路径不同，修改 `deploy/persona-agent.service` 中的 `ExecStart`。Node 必须是服务用户可访问的系统安装，不能指向个人家目录中的 nvm 路径，因为模板启用了 `ProtectHome=yes`。同样不要把程序安装在个人家目录后直接使用此模板。

新机器没有 `persona-agent` 用户时创建一次，然后在项目目录安装依赖并安装服务：

```bash
sudo useradd --system --user-group --home-dir /var/lib/persona-agent --no-create-home --shell /usr/sbin/nologin persona-agent
cd /opt/persona-agent
sudo npm ci --ignore-scripts --no-fund --no-audit
sudo chown -R root:root /opt/persona-agent
sudo chmod -R a+rX /opt/persona-agent
sudo install -m 0644 deploy/persona-agent.service /etc/systemd/system/persona-agent.service
sudo systemd-analyze verify /etc/systemd/system/persona-agent.service
sudo systemctl daemon-reload
sudo systemctl enable --now persona-agent
sudo systemctl status persona-agent --no-pager
```

只对这个新部署、仅包含程序代码的 `/opt/persona-agent` 目录执行上述权限命令。已有数据应迁移到 `/var/lib/persona-agent`，不要将私密数据设置为所有用户可读。服务的 `StateDirectory` 会创建归 `persona-agent` 所有、权限均为 `0700` 的数据目录和独立备份目录；`ProtectSystem=strict` 使程序目录只读，`ReadWritePaths` 仅允许写入 `/var/lib/persona-agent` 与 `/var/lib/persona-agent-backups`。备份恢复密码与服务机凭据仍应由创建人保管。

查看初始化码与日志、停止和重启服务：

```bash
sudo cat /var/lib/persona-agent/setup-key.txt
sudo journalctl -u persona-agent -n 100 --no-pager
sudo systemctl stop persona-agent
sudo systemctl restart persona-agent
```

服务由 systemd 管理时使用 `systemctl`，不要再运行 `start.sh` 或 `dev.sh` 启动第二份进程。systemd 模板等待停止最多 20 秒，且关闭自动 `SIGKILL`；停止失败时先检查日志和进程再处理。升级前先导出加密备份，停止服务，更新程序文件并重新执行 `npm ci`，最后重启。

## 远程服务器访问

在自己的电脑终端建立 SSH 隧道，将以下示例中的登录名和服务器地址替换为实际值：

```bash
ssh -N -L 3210:127.0.0.1:3210 your-user@your-server
```

保持终端开启，浏览器访问 `http://127.0.0.1:3210`。服务会核验 HTTP Host，因此本地隧道端口也须使用 `3210`。如果本机已有 Memoria，占用同一端口，先停止本机实例。无需公开 `3210` 端口或修改服务监听地址。QQ 协议端推荐部署在同一机器，通过回环地址连接；Windows NapCat 不能直接通过自身的 `127.0.0.1` 连接另一台 Linux 服务器。

## 跨平台迁移

从旧实例后台导出 `.pab` 加密备份，在目标系统安装相同或兼容版本，初始化新管理员后预览并恢复。备份内容是加密的结构化 JSON，由目标系统重建 SQLite 数据，适合 Windows 与 Linux 之间迁移。恢复后需重新填写模型与平台凭据、核验账号绑定并开启外部接入；不要在程序运行中只复制单个 `.sqlite` 文件，以免遗漏 WAL 中的数据。

参考：[Node.js 下载](https://nodejs.org/en/download)、[systemd 执行环境与 StateDirectory](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)。
