# Third-party notices

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

The optional autonomous-reading browser is downloaded separately by Playwright. Chromium and its bundled components retain their own licenses and notices; the browser binaries are not included in this source repository. See [Playwright's license](https://github.com/microsoft/playwright/blob/v1.64.1/LICENSE) and [Chromium's license](https://chromium.googlesource.com/chromium/src/+/main/LICENSE).
