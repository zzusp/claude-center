# Worker CI 发版 Runbook

> 给「打 `worker-vX.Y.Z` tag → 拿到 GitHub Release Assets」这条路径写的运维手册：
> 触发命令、CI 内部流程、关键设计为什么这样写、踩坑史与排错。
>
> 配套：[`docs/spec/deployment-pipeline.md`](../spec/deployment-pipeline.md)（综合方案 spec）、
> [`docs/manual/worker-install-guide.md`](../manual/worker-install-guide.md)（最终用户手册）。

## 一句话

```powershell
# 1) 改 CHANGELOG-worker.md 加 [X.Y.Z] 节、commit + push main
# 2) 推 tag 触发 CI
node scripts/release-worker-trigger.mjs X.Y.Z
# 3) 跟踪
gh run watch  # 或 https://github.com/zzusp/claude-center/actions
```

CI 跑完后产物在 `https://github.com/zzusp/claude-center/releases/tag/worker-vX.Y.Z`。

## 1. 触发命令的内部行为

`scripts/release-worker-trigger.mjs X.Y.Z` 干这些事，按序：

1. 自检（任一不通即拒、不动 tag）：
   - 工作树 clean（`git status --porcelain` 空）
   - 在 main 分支
   - `CHANGELOG-worker.md` 有 `## [X.Y.Z]` 非空节
   - 本地与远程都不存在 `worker-vX.Y.Z` tag
2. `git tag -a worker-vX.Y.Z -m "Release worker-vX.Y.Z"`
3. `git push origin worker-vX.Y.Z`

参数 `--check` 只跑自检不打 tag；`--dry-run` 自检 + 打印将执行的 git 命令不真推。

## 2. CI workflow 总览

文件：`.github/workflows/release-worker.yml`。

```
push tag worker-v[0-9]+.[0-9]+.[0-9]+
  └─ trigger release-worker workflow
      │
      ├─ precheck (ubuntu-latest, 10s)
      │   ├─ checkout
      │   ├─ Parse tag → WORKER_VERSION (outputs.worker_version)
      │   ├─ Verify CHANGELOG-worker.md has [X.Y.Z] section
      │   ├─ Extract release notes → artifacts/notes.md
      │   └─ Upload notes artifact (供 release job 用)
      │
      ├─ build (matrix: [windows-latest, macos-latest])  ← 真打包
      │   ├─ checkout
      │   ├─ Setup Node 22
      │   ├─ Install deps (npm ci 整仓装 workspace 依赖)
      │   ├─ Build workspace deps + worker dist
      │   │     (tsc 编译 packages/db, packages/relay-client, apps/worker 的 dist)
      │   ├─ Build isolated node_modules in apps/worker  ← 关键步骤，详见 §3
      │   ├─ Patch worker version (把 tag 版本写进 apps/worker/package.json)
      │   ├─ Dist precheck (零副作用配置自检)
      │   ├─ electron-builder (dist:win / dist:mac)
      │   ├─ List artifacts (debug 列产物)
      │   └─ Upload artifacts (dist-win / dist-mac)
      │
      └─ release (ubuntu-latest, 15s)
          ├─ checkout
          ├─ Download artifacts (dist-win + dist-mac + release-notes)
          ├─ Flatten artifacts → release/
          └─ gh release create worker-vX.Y.Z --notes-file release/notes.md  *.exe *.dmg
```

windows + macos 两个 job 并行；任一失败整个 release 就 skip（matrix `fail-fast: false` 让另一边跑完留日志，但 release 仍 skip）。

## 3. 关键设计点（为什么这样写）

### 3.1 步骤顺序：先 npm ci，再 patch version

```yaml
- Install deps:        npm ci
- Build workspace deps + worker dist
- Build isolated node_modules in apps/worker
- Patch worker version    ← 一定在 npm ci 之后
```

`npm ci` 严格比对 `package-lock.json` 与所有 workspace package.json 的 `version` 字段。
如果先 patch version 再 npm ci，lock 里 `apps/worker@0.1.0` 与 package.json 里 `0.2.0` 不一致，直接拒掉。

electron-builder 是 build 阶段才读 version，与依赖解析无关——所以 patch 放到 `npm ci` 之后没副作用。

### 3.2 Isolated node_modules in apps/worker（核心 workaround）

```bash
cd apps/worker
cp package.json package.json.bak
# 把 @claude-center/* 改成 file: 协议
node -e "
  const fs = require('fs');
  const j = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
  j.dependencies['@claude-center/db'] = 'file:../../packages/db';
  j.dependencies['@claude-center/relay-client'] = 'file:../../packages/relay-client';
  fs.writeFileSync('package.json', JSON.stringify(j, null, 2) + '\n');
"
rm -rf node_modules
npm install --prefer-offline --no-audit --no-fund --no-package-lock --no-workspaces --install-links=true
mv package.json.bak package.json
```

为什么必须这步？electron-builder **严格拒绝**引用 `apps/worker/` 之外的文件，报错：

```
⨯ packages/db/dist/client.js must be under apps/worker/
```

但 npm workspaces 把所有依赖 hoist 到根 `node_modules`：

- `@claude-center/db` 在 `apps/worker/node_modules/@claude-center/db` 是 symlink → `packages/db`（在 worker 外）
- `pg`（packages/db 的依赖）直接装到根 `node_modules/pg`（在 worker 外）
- `electron` 同理在根 `node_modules/electron`

四个关键 flag 解释：

| Flag | 作用 |
|---|---|
| `--no-workspaces` | 让 npm 不当 workspace 处理这次 install（不再 hoist 出 worker 目录） |
| `--install-links=true` | 强制 `file:` 协议 deep copy 而非 symlink（npm 8+ 默认 symlink，会触发原错） |
| `--no-package-lock` | 不动 root lock，避免 lock 被这次临时 install 污染 |
| `--prefer-offline / --no-audit / --no-fund` | 用 cache + 跳过非必要网络，省时间 |

`file:../../packages/db` + `--install-links` 让 npm 把 packages/db **完整复制**到 `apps/worker/node_modules/@claude-center/db`，连带它的 transitive deps（pg 等）也装在 apps/worker/node_modules 下。

跑完后还原 package.json（`mv package.json.bak package.json`），不让临时 file: 协议改动进入 electron-builder 读到的版本。

### 3.3 dmg.title 不含空格 + writeUpdateInfo: false

```json
"dmg": {
  "title": "ClaudeCenter-Worker",
  "writeUpdateInfo": false
}
```

两条都是规避 macOS-latest runner 的实际 bug：

- `dmg.title` 默认是 `${productName} ${version}`，含空格 + 版本号点（如 `ClaudeCenter Worker 0.2.0`）会让 `hdiutil detach` 反复失败（Exit code 1 / 16）。改成单词 `ClaudeCenter-Worker`，hdiutil 解析挂载点无歧义。
- `writeUpdateInfo: false` 不生成 `latest-mac.yml`。本项目未用 electron auto-updater，这文件没用；不生成可省 workflow artifact_pattern 不写它（写了又找不到会 `if-no-files-found: error`）。

### 3.4 Windows nsis target

`apps/worker/package.json` 的 `build.win.target`：

```json
[
  { "target": "nsis", "arch": ["x64"] },
  { "target": "portable", "arch": ["x64"] }
]
```

> ⚠️ **已知现象**：worker-v0.2.0 release assets 里只产出了 nsis（`*.exe`），portable 那个似乎没出。`artifact_pattern: 'apps/worker/release/*.exe'` 范围足以包含两个，但 electron-builder 实际生成情况要确认。下一次发版前在本机本地跑 `npm -w @claude-center/worker run dist:win` 看 `release/` 里到底有哪几个 exe。

### 3.5 macOS arch matrix

```json
{ "target": "dmg", "arch": ["x64", "arm64"] }
```

一次 build 出两个 dmg：

- `ClaudeCenter-Worker-X.Y.Z-mac-x64.dmg`（Intel）
- `ClaudeCenter-Worker-X.Y.Z-mac-arm64.dmg`（Apple Silicon）

不打 universal binary（体积翻倍），让用户按 `uname -m` 自选。

### 3.6 不做代码签名

```json
"mac": {
  "identity": null,
  "hardenedRuntime": false,
  "gatekeeperAssess": false
}
```

未签名 → 不进 notarize。用户首次启动会被 SmartScreen / Gatekeeper 拦，需手动绕（见 `docs/manual/worker-install-guide.md` §4）。

升级路径：拿到证书后加：

```yaml
env:
  CSC_LINK: ${{ secrets.WORKER_CSC_LINK }}            # macOS .p12 base64
  CSC_KEY_PASSWORD: ${{ secrets.WORKER_CSC_PASSWORD }}
  APPLE_ID: ${{ secrets.APPLE_ID }}
  APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
  APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
  # Windows
  CSC_LINK_WIN: ${{ secrets.WORKER_CSC_LINK_WIN }}
```

去掉 `identity: null` / `hardenedRuntime: false` / `gatekeeperAssess: false` 三行让 electron-builder 自动签名 + notarize。

## 4. 踩坑史（worker-v0.2.0 调试 5 次 CI 才全绿）

| # | 失败点 | 根因 | 修法 |
|---|---|---|---|
| 1 | `npm ci` 拒 | lock 严格比对 workspace package.json `version`，先 patch 再 npm ci 不匹配 | 把 `npm ci` 挪到 `Patch worker version` 之前 |
| 2 | `Cannot compute electron version from installed node modules` | electron 被 hoist 到根 node_modules，apps/worker 下没有 | 第一版用 `cd apps/worker && npm install electron --no-save` 单独装；后改用 isolated install 顺带带上 |
| 3 | `must be under apps/worker/` | workspace symlink 跟到 packages/db / 根 pg 等 worker 外文件 | 改 `@claude-center/*` 为 `file:` 协议 + `npm install --no-workspaces` |
| 4 | `pg/package.json` 不存在 | npm 默认 `file:` 协议建 symlink 而非 deep copy | 加 `--install-links=true` |
| 5 | macOS `hdiutil detach` 反复 Exit code 1 | `dmg.title` 含空格 + 版本号点；`latest-mac.yml` 没生成但 workflow 要 | dmg.title 改 `ClaudeCenter-Worker`、`writeUpdateInfo: false`、artifact_pattern 删 `latest-mac.yml` |

每个坑都对应一个 commit 在 main 历史里能查到。

## 5. 排错手册

### 5.1 precheck job 红

| 信号 | 排查 |
|---|---|
| `tag $ref 不符合 cc-vX.Y.Z 格式` | 推 tag 时写错了，正则要求 `worker-v[0-9]+.[0-9]+.[0-9]+` |
| `extract-changelog ... 未找到 [X.Y.Z] 节` | 没写 CHANGELOG。本地跑 `node scripts/extract-changelog.mjs CHANGELOG-worker.md X.Y.Z --check` 复现 |
| 抽取的 release notes 为空 | `[X.Y.Z]` 节下面只有空行 / 只有占位符 |

### 5.2 build matrix job 红

按步骤排查：

| 步骤红 | 排查方向 |
|---|---|
| Install deps | `package-lock.json` 没跟 `package.json` 同步——本地跑 `npm install` 后 commit lock |
| Build workspace deps + worker dist | tsc 报错——本地 `npm run typecheck` 复现 |
| Build isolated node_modules in apps/worker | 看 isolated install 输出末尾的 `ls`：`@claude-center/` 是否含 db + relay-client；`pg/package.json` 是否存在；`electron/package.json` 是否存在。缺哪个对应 §3.2 的 flag |
| Dist precheck | `apps/worker/scripts/dist-check.mjs` 报字段缺失——补齐 package.json `build` 字段 |
| electron-builder | 看 `⨯` 行：`must be under apps/worker/` → isolated install 出问题；`hdiutil detach` → §3.3；`Cannot compute electron version` → isolated install 没装 electron |
| List artifacts | release/ 为空，电子构建静默挂——往上滚日志看 electron-builder warn |
| Upload artifact | `if-no-files-found: error` 提示文件不在路径——确认 artifact_pattern 与实际产物名一致 |

### 5.3 release job 红

```
contents: write permission required
```

→ workflow `permissions:` 块缺 `contents: write`（当前 release job 已有）。

```
no such tag
```

→ 在 `gh release create` 之前 `git push origin <tag>` 还没传过来——重试。

## 6. 本地复现 CI 跑（不推 tag）

调试 electron-builder 配置时本地跑：

```powershell
# 编译 + 自检
npm -w @claude-center/db run build
npm -w @claude-center/relay-client run build
npm -w @claude-center/worker run build
npm -w @claude-center/worker run dist:check

# 本地打 win（macOS dmg 不能跨平台打）
npm -w @claude-center/worker run dist:win
ls apps/worker/release/
```

> 本地 npm workspaces hoist 不会触发 CI 的 isolated install 流程，所以本地 dist 不能完全代表 CI 行为；但能验证 electron-builder 配置字段对不对。

## 7. 升级路径（待办）

| 项 | 改动点 |
|---|---|
| Linux 包（.AppImage / .deb） | matrix 加 `ubuntu-latest` + `dist:linux` script + `apps/worker/package.json` 加 `build.linux.target` |
| macOS 代码签名 + notarize | 见 §3.6 |
| Windows 代码签名 | EV / OV 证书 + `CSC_LINK_WIN` secret |
| auto-updater | dmg.writeUpdateInfo 改回 true、配置 `publish` 指向 GitHub Releases、worker 集成 `electron-updater` |
| nsis portable 实际产物 | 见 §3.4 已知现象，下次发版前确认 |
| ARM Windows / Linux | electron 31+ 支持，按需加 matrix arch |

## 8. 相关文件

| 路径 | 用途 |
|---|---|
| `.github/workflows/release-worker.yml` | CI workflow |
| `apps/worker/package.json` (`build` 字段) | electron-builder 配置 |
| `apps/worker/scripts/dist-check.mjs` | 配置自检（CI 跑前一道护栏） |
| `scripts/release-worker-trigger.mjs` | 本地推 tag 自检 |
| `scripts/extract-changelog.mjs` | CI 与本地共用：抽 release notes |
| `CHANGELOG-worker.md` | 发版硬约束 |
