# Third-party notices

## Optional local video sampling

The video preparation command downloads a fixed LGPL build of FFmpeg and ffprobe from [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds). Archive and extracted-file checksums, version checks, codec checks and license/source information are retained with the separately installed tools. These executables, archives and media files are not distributed with this repository. See [FFmpeg's licensing information](https://ffmpeg.org/legal.html); the project license does not replace those obligations. Downloaded videos, audio, subtitles and model-generated observations are not covered by the FFmpeg or DSH code licenses.

## Optional local speech input

The local speech adapter runs the external `@deepseek-ai/dsh-experimental-speech-to-text-sensevoice` worker, pinned to `0.2.1-rc.2` (MIT), with `sherpa-onnx-node` `1.13.8` (Apache-2.0). These runtime packages are installed separately and are not copied into this repository. See the [official DSH provider](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/experimental/speech-to-text-sensevoice) and [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx).

SenseVoiceSmall recognition weights are subject to the [FunASR Model License 1.1](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE); the [official model card](https://huggingface.co/FunAudioLLM/SenseVoiceSmall) links that agreement. Silero VAD is [MIT licensed](https://github.com/snakers4/silero-vad/blob/master/LICENSE). Pinned ONNX files and tokens are downloaded separately from the [sherpa conversion repository](https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17) and the VAD repository; weights, caches and audio are not distributed with this source. The model licenses must not be confused with this project's Apache-2.0 license or the DSH code license.

Memoria (栖忆) is licensed under Apache-2.0. Copyright 2026 Memoria contributors.

Direct dependencies:

| Package | Pinned version | License | Source |
| --- | --- | --- | --- |
| @mozilla/readability | 0.6.0 | Apache-2.0 | https://github.com/mozilla/readability |
| linkedom | 0.18.12 | ISC | https://github.com/WebReflection/linkedom |
| playwright | 1.64.1 | Apache-2.0 | https://github.com/microsoft/playwright |

The installed dependency tree and exact resolved versions are recorded in `package-lock.json`. Each dependency retains its own copyright and license in `node_modules`; redistribution must retain applicable notices.

The optional Feishu transport loads the separately installed [`dsh-im`](https://github.com/xmanrui/dsh-im) 5.4.0 (MIT, commit `e5b4f2bcbf781a59e54f9844d3dcb26648e0b103`) through the official DSH 0.2.1-rc.2 runtime. Its optional dependency lock is in `deploy/feishu-host`; third-party package source and binaries are not bundled in this repository. The original package and every transitive dependency retain their own notices and licenses. The account setup command also calls the original, hash-verified Feishu application verifier.

Optional expression search calls the hash-verified, separately installed `memes.js` search module from [`dsh-meme`](https://github.com/yyh-001/dsh-meme) 0.1.60 (MIT; npm gitHead `82abf5bb08a5e0e355f6fbe5e3a76a9165fbf326`). Its original package and license stay in the independent DSH host. Memoria supplies only the current chat's permitted metadata and uses its own image storage and sending path; third-party image packs are not redistributed here.

Optional Bilibili comment replies call the original MCP client and Python server from [`dsh-bili-subagent`](https://github.com/Yuuyuko-uu/dsh-bili-subagent) 0.7.7 (MIT, commit `bbe41848137cdfa334bf04ebe7d5d29830390923`). The separate installer verifies the upstream archive and both entry files; it does not load the full plugin bundle or its autonomous scheduler. The Python runtime separately installs [`bilibili-api-python`](https://github.com/Nemo2011/bilibili-api) 17.4.2 (GPL-3.0-or-later), [`mcp`](https://github.com/modelcontextprotocol/python-sdk) 1.26.0 (MIT), and [`httpx`](https://github.com/encode/httpx) 0.28.1 (BSD-3-Clause), with their dependencies. These packages, sources and binaries are not bundled in this repository. They retain their respective licenses and notices in the independent runtime; deployment requirements are in `deploy/bili-social/requirements.txt`.

Optional companionship rhythm uses the separately installed, hash-verified original kernel from [`dsh-mate-companion`](https://github.com/m-rui001/dsh-mate-companion) 1.5.4 (MIT, commit `a6d715c1bfa6dcd81eb0dadcb3964e0d459c1c5a`). The fixed upstream archive, source and license remain in an independent runtime directory outside `node_modules`; pins are recorded in `deploy/mate/pins.json`. Memoria does not load the bundle's persona, text-memory storage, model judge or autonomous timer. Its own scheduler, canonical memories, identity and budgets remain authoritative. Upstream source and binaries are not bundled in this repository.

QQ reply pauses reuse the unmodified, browser-safe `src/channels/shared/send-delay.mjs` from [`dsh-im-humanize`](https://github.com/john-walks-slow/dsh-im-humanize/tree/e9126d6bd3338de15d85f92de94ea28b565d2288) 4.38.0-humanize.1, commit `e9126d6bd3338de15d85f92de94ea28b565d2288`. The vendored copy is `src/vendor/dsh-im-humanize/send-delay.mjs` (SHA-256 `882d0d36db26cedbfc7867059819d977406e58ce3ce445d44c0bc34a473e273d`), with the original MIT license and copyright notice in the same directory. Memoria calls only its segment-delay calculation and cancellable sleep; the fork's message bridge, tools, persona and memory are not loaded.

The optional autonomous-reading browser is downloaded separately by Playwright. Chromium and its bundled components retain their own licenses and notices; the browser binaries are not included in this source repository. See [Playwright's license](https://github.com/microsoft/playwright/blob/v1.64.1/LICENSE) and [Chromium's license](https://chromium.googlesource.com/chromium/src/+/main/LICENSE).
