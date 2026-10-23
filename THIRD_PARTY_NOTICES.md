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

The optional autonomous-reading browser is downloaded separately by Playwright. Chromium and its bundled components retain their own licenses and notices; the browser binaries are not included in this source repository. See [Playwright's license](https://github.com/microsoft/playwright/blob/v1.64.1/LICENSE) and [Chromium's license](https://chromium.googlesource.com/chromium/src/+/main/LICENSE).
