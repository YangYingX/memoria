# QQ 本地语音输入

栖忆可将一条 QQ 语音在本机转成文字，再用原有模型、人格和记忆回复。支持私聊，以及白名单群中直接 @ 或经核对引用机器人的消息；普通群语音不会自动识别。默认关闭。

## 准备

需要 Windows x64 或 Linux glibc x64、Node.js 22.16 以上和已安装的固定版 DSH 专用宿主。先按[部署说明](deployment.md#dsh-只读插件接入)安装 Node.js 24 与插件包；不必开启完整 DSH 运行层，语音只复用其官方 SenseVoice worker。需要 NapCat 提供 `get_record` 的 WAV Base64 扩展；仅返回本地文件路径的 OneBot 实现不能用于此功能。

在项目目录执行：

```bash
npm run speech:prepare
```

Windows PowerShell 可使用 `npm.cmd run speech:prepare`。独立数据目录使用相同的 `PERSONA_DATA_DIR`，或执行：

```bash
node scripts/prepare-speech.js --data-dir /absolute/path/to/data
```

准备程序读取该目录已有的 `dsh-runtime.json`，下载固定修订的 INT8 模型、词表和 VAD，共 241,357,257 字节，逐个核对长度与 SHA-256。可显式增加 `--origin https://hf-mirror.com` 选择另一固定来源。正常接收语音不会触发下载；再次准备会复用完整资源，不清空原有禁用状态。

准备后在“人格与设置 → QQ 接入”开启“识别 QQ 语音并回复文字”。资源准备不会自行打开 QQ 语音开关。后台显示准备状态；识别模型按需加载，空闲一分钟后释放内存。CPU 使用两个推理线程；可按约 1 GiB 内存预留估算，实际占用随系统和录音而变。

## 使用与范围

- 每条最多一段语音、最长 60 秒，可以附少量文字。图片、视频或书籍请另发。
- 识别在本机完成，不需要新的模型 API 密钥；随后生成回复仍占原 QQ 聊天次数和模型额度。语音转写不另算一次模型请求。
- 转写可能有误。文字带语音来源标记，保存在原私聊或原群的对话档案，可在离开近期上下文后检索。她可以自然聊天、翻查有权读取的旧记忆；设置更改、身份绑定、约定、记忆管理和发起新阅读请用纯文字说明。
- 栖忆不保存原录音，也不会读取协议端返回的本地音频路径；NapCat 自己的转码缓存由协议端管理。以后只能回查当时转写，不能重新听录音。
- 该功能不分析语调、声纹、音乐或视频画面，也不生成语音回复。没有识别清楚时会说明；失败、重复消息和结果未确认均不自动重试。

## 本机运行配置

准备程序在数据目录生成 `speech-runtime.json`，其中只有 `enabled`、`nodePath`、`hostDirectory`、`modelDirectory`、`vadModelPath` 五个字段。路径指向当前系统的 Node.js 24、专用宿主及已校验的模型资源。将 `enabled` 改为 `false` 可停止新的本地识别，资源保留；QQ 总开关和语音开关继续生效。

模型保存在数据目录的 `speech-models/sensevoice-int8/`，不随 GitHub 源码或结构化加密备份导出。迁移到另一台 Windows 或 Linux 机器后，重新准备资源并填写该机器路径；人格、对话与转写文字仍沿用栖忆的备份。

复用代码与权重的许可不同：DSH 组件为 MIT，sherpa-onnx 为 Apache-2.0；SenseVoiceSmall 权重使用 [FunASR Model License 1.1](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE)，Silero VAD 为 MIT。模型单独下载，不随项目重新分发。详情见[第三方说明](../THIRD_PARTY_NOTICES.md)。
