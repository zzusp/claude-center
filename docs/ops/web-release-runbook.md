# Web 端 CI 发版 Runbook

> 给「打 `cc-vX.Y.Z` tag → console + relay 自动部署到生产服务器」这条路径写的运维手册：
> 触发命令、CI 内部流程、关键设计为什么这样写、踩坑史与排错、回滚流程。
>
> 配套：[`docs/spec/deployment-pipeline.md`](../spec/deployment-pipeline.md)（综合方案 spec）、
> [`docs/ops/worker-release-runbook.md`](worker-release-runbook.md)（桌面端兄弟文档）。

## 一句话

```powershell
# 1) 改 CHANGELOG-console.md 加 [X.Y.Z] 节、commit + push main
# 2) 推 tag 触发 CI
node scripts/deploy-web-trigger.mjs X.Y.Z
# 3) 跟踪
gh run watch  # 或 https://github.com/zzusp/claude-center/actions
```

CI 跑完后：

- console + relay 在 `http://115.159.161.47:3000` / `:8787` 跑新版本
- Release：`https://github.com/zzusp/claude-center/releases/tag/cc-vX.Y.Z`
- console 顶栏左侧 brand 区下方显示 `v{X.Y.Z}`

## 1. 触发命令的内部行为

`scripts/deploy-web-trigger.mjs X.Y.Z` 干这些事，按序：

1. 自检（任一不通即拒、不动 tag）：
   - 工作树 clean（`git status --porcelain` 空）
   - 在 main 分支
   - `CHANGELOG-console.md` 有 `## [X.Y.Z]` 非空节
   - 本地与远程都不存在 `cc-vX.Y.Z` tag
2. `git tag -a cc-vX.Y.Z -m "Release cc-vX.Y.Z"`
3. `git push origin cc-vX.Y.Z`

参数 `--check` 只跑自检不打 tag；`--dry-run` 自检 + 打印 git 命令不真推。

## 2. CI workflow 总览

文件：`.github/workflows/deploy-web.yml`。

```
push tag cc-v[0-9]+.[0-9]+.[0-9]+
  └─ trigger deploy-web workflow (concurrency: deploy-web，单跑)
      │
      ├─ build (ubuntu-latest, ~2min)        ← 早 fail 护栏
      │   ├─ checkout
      │   ├─ Setup Node 22
      │   ├─ Parse tag → APP_VERSION (outputs.app_version)
      │   ├─ npm ci --ignore-scripts
      │   ├─ npm run typecheck
      │   ├─ npm run build (五包全编)
      │   ├─ Extract release notes → artifacts/notes.md
      │   └─ Upload notes artifact (供 release job 用)
      │
      ├─ deploy (ubuntu-latest, ~5min, environment: DEPLOY)
      │   ├─ Checkout @ tag                  ← runner 上再 checkout 一份做 bundle 源
      │   ├─ Setup SSH (webfactory/ssh-agent + secrets.DEPLOY_SSH_KEY)
      │   ├─ Trust host (写 secrets.DEPLOY_KNOWN_HOSTS 到 ~/.ssh/known_hosts)
      │   ├─ Pack release bundle (tar czf /tmp/cc-deploy-X.Y.Z.tar.gz，排除 node_modules/.git/.next/.env)
      │   ├─ Upload bundle + deploy script (scp 两个文件到服务器 /tmp/)
      │   ├─ Run deploy-on-server.sh (ssh sudo bash /tmp/deploy-on-server.sh X.Y.Z /tmp/cc-deploy-X.Y.Z.tar.gz)
      │   │     ├─ tar xzf → 临时区
      │   │     ├─ rsync -a --delete --exclude='.env' <stage>/ /opt/claude-center/
      │   │     ├─ export APP_VERSION=X.Y.Z
      │   │     ├─ docker compose build console relay
      │   │     ├─ docker compose up -d console relay
      │   │     ├─ 等 console 就绪（最多 60s，curl /api/dashboard 看 401/200）
      │   │     └─ docker image prune -f
      │   └─ External health check (从 runner 走公网 curl http://${DEPLOY_HOST}:3000/api/dashboard，5 次重试)
      │
      └─ release (ubuntu-latest, 9s)
          ├─ checkout
          ├─ Download release notes
          └─ gh release create cc-vX.Y.Z --notes-file artifacts/notes.md
```

任一前置 job fail 后置就 skip。`concurrency: deploy-web` 保证两个 tag 不会并发部署互踩。

## 3. 关键设计点（为什么这样写）

### 3.1 服务器不做 `git fetch`，CI runner scp tarball

**根因**：国内服务器对 `github.com:443` 普遍不通（实测 135s 超时）；`codeload.github.com` 也曾返回 404（GitHub 对源 IP 限制），不可靠。

**做法**：

- CI runner 在境外，能直连 `github.com` ✓
- runner 上 `actions/checkout @ tag` 拿到全套代码
- `tar czf` 打包（排除 `.git` / `node_modules` / `.next` / `dist` / `.env`）
- `scp` 到服务器 `/tmp/cc-deploy-X.Y.Z.tar.gz`
- 同时把 `scripts/deploy-on-server.sh` 也 scp 到 `/tmp/`（**避免「先 rsync 才能拿到新版脚本」的鸡生蛋**）
- `ssh` 跑 `sudo bash /tmp/deploy-on-server.sh X.Y.Z /tmp/cc-deploy-X.Y.Z.tar.gz`

服务器侧 `/opt/claude-center` 不是 git 目录，纯 rsync 覆盖式部署。

### 3.2 Bootstrap 首次也走 SFTP（不走 git clone）

首次准备服务器同样不能 `git clone`：

```powershell
# 本地（能上 GitHub）
tar czf /tmp/cc-bootstrap.tar.gz `
  --exclude=node_modules --exclude=.next --exclude=dist --exclude=.git `
  --exclude=apps/worker/release --exclude=.env -C D:\project\claude-center .
scp /tmp/cc-bootstrap.tar.gz ubuntu@<host>:/tmp/

# 服务器（sudo -i 后）
sudo BUNDLE=/tmp/cc-bootstrap.tar.gz bash /tmp/server-bootstrap.sh   # 解出来再跑
vim /opt/claude-center/.env                                           # 填 DATABASE_URL
```

详见 `scripts/server-bootstrap.sh`。bootstrap 完成后**永远不再需要**——CI tag 触发的部署是自动覆盖式 rsync。

### 3.3 Next.js standalone + monorepo

`apps/console/next.config.mjs`：

```js
output: "standalone",
outputFileTracingRoot: path.join(__dirname, "../.."),
```

- `output: "standalone"` 让 Next 把运行时必需的 node_modules 拷到 `.next/standalone/`，runtime 镜像只装 `node` 不装 npm deps，体积从 ~1.2 GB → ~250 MB
- `outputFileTracingRoot` 指向 monorepo 根，否则 trace 算法看不到 npm workspaces hoist 上去的依赖（漏拷 `@claude-center/db` 与 `pg`）

### 3.4 console Dockerfile 手动补 workspace 包 + 重建 symlink

```dockerfile
COPY --from=build /app/packages/db/dist                   ./packages/db/dist
COPY --from=build /app/packages/db/package.json           ./packages/db/package.json
COPY --from=build /app/packages/relay-client/dist         ./packages/relay-client/dist
COPY --from=build /app/packages/relay-client/package.json ./packages/relay-client/package.json
RUN mkdir -p node_modules/@claude-center && \
    ln -s ../../packages/db           node_modules/@claude-center/db && \
    ln -s ../../packages/relay-client node_modules/@claude-center/relay-client && \
    chown -R app:app node_modules/@claude-center packages
```

**为什么**：`instrumentation-node.ts` 里：

```ts
const { getPool, ... } = await import(/* webpackIgnore: true */ "@claude-center/db");
```

`webpackIgnore: true` 告诉 webpack「不要解析这个 dynamic import」（避免编译期把 `pg` 的 `node:fs` 拖进 edge runtime 编译），运行时由 Node 自己解析。

但 Next 的 standalone trace 算法**也看不到**这条 dynamic import（同一个原因，webpack 没解析），所以不会把 `@claude-center/db` 拷进 standalone。容器一启动报：

```
Error: An error occurred while loading instrumentation hook:
  Cannot find package '@claude-center/db' imported from .../instrumentation.js
```

修法只能 Dockerfile 手动补：

1. COPY `packages/db/dist + package.json`、`packages/relay-client/dist + package.json` 进 runtime 镜像
2. `ln -s` 重建 `node_modules/@claude-center/{db,relay-client}` symlink，让 Node 的 module resolution 找得到

`pg` 因为是被 `@claude-center/db` import 的、且 `outputFileTracingRoot` 设了 monorepo 根，trace 会把它带进 standalone/node_modules/pg，**不用**手动 COPY。

### 3.5 console 版本号注入 (`NEXT_PUBLIC_APP_VERSION`)

Dockerfile build 阶段：

```dockerfile
ARG APP_VERSION=dev
ENV NEXT_PUBLIC_APP_VERSION=$APP_VERSION
```

`docker-compose.yml`：

```yaml
build:
  args:
    APP_VERSION: ${APP_VERSION:-dev}
```

`deploy-on-server.sh`：

```bash
export APP_VERSION   # 从 ssh env 传入
docker compose build console relay
```

CI 链：`cc-v0.2.0` tag → workflow 解析得到 `0.2.0` → ssh env `APP_VERSION=0.2.0` → compose build args → Dockerfile ENV → Next build 把它编进客户端 chunk → `apps/console/app/ui/shell.tsx` 读 `process.env.NEXT_PUBLIC_APP_VERSION` 显示在顶栏 brand 区下方。

`NEXT_PUBLIC_` 前缀是 Next.js 约定：客户端可访问的 env 必须以这个开头。

### 3.6 instrumentation.ts edge runtime DCE

`apps/console/instrumentation.ts`：

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node");
    await registerNode();
  }
}
```

`apps/console/instrumentation-node.ts` 里才用 `pg`、`@claude-center/db`、`node:fs` 等。

为什么这么写：Next 把 `instrumentation.ts` 为 **nodejs + edge 两个 runtime** 分别编译。如果在 instrumentation.ts 顶层 import `pg`，edge 编译会因 `node:` scheme 模块炸 → 整站 500。

正向 `if (NEXT_RUNTIME === "nodejs")` 包住动态 import 是 Next 官方写法：Turbopack/webpack 据此把 nodejs-only 模块从 edge 编译图 DCE 掉。**关键**是正向条件——反向 `if (NEXT_RUNTIME === "edge") return;` 等死代码消除算法不识别。

改 instrumentation 后必须 `npm run verify:console` 看到 `scheduler.ok=true` 才算验证过——光看 `build` 绿是假信号。

### 3.7 host.docker.internal 走宿主机 PostgreSQL

`docker-compose.yml`：

```yaml
console:
  extra_hosts:
    - "host.docker.internal:host-gateway"
```

服务器 `/opt/claude-center/.env`：

```
DATABASE_URL=postgresql://...@host.docker.internal:55432/claude_center
```

为什么：服务器宿主机自建 PostgreSQL 监听 `:55432`。容器内访问宿主机有两种方式：

- 公网 IP（`115.159.161.47:55432`）：走 docker0 → eth0 → 出公网再回，绕一圈
- `host.docker.internal:host-gateway`：docker 提供的特殊 DNS 名，解析到宿主机网关 IP，**走宿主机环回口**，更快也避免 pg 必须监听公网

无论 pg 监听 `127.0.0.1:55432` 还是 `0.0.0.0:55432`，host-gateway 方案都通。

### 3.8 Docker registry mirror

`/etc/docker/daemon.json`（手动配在服务器上、不进 git）：

```json
{
  "registry-mirrors": [
    "https://mirror.ccs.tencentyun.com",
    "https://docker.m.daocloud.io",
    "https://docker.1panel.live"
  ]
}
```

为什么：国内服务器拉 `node:22-alpine` 从 Docker Hub 直连 `registry-1.docker.io` timeout。配 mirror（腾讯云 / daocloud / 1panel 任一通即可）让 `docker pull` 走镜像。

不进 git 因为 mirror 可能换、跟宿主机网络环境强相关；服务器 bootstrap runbook 里会写这步。

### 3.9 健康检查走 `/api/dashboard`

```bash
curl -s -o /dev/null -m 3 -w '%{http_code}' http://127.0.0.1:3000/api/dashboard
```

`200` 或 `401` 都算 OK（401 = 未登录 = 服务在线但拒绝匿名访问，这是正常态）。`500` / 超时 / 拒连 fail。

**不能**用 `/api/auth/me`（项目里不存在这个路由，404）。

容器 `HEALTHCHECK` 也走同样路径，但 `wget`（alpine busybox 版）对 4xx 返回非零 exit code → docker 标 `unhealthy`。**业务实际可用**（外部 curl 也是 401 17ms）。不阻塞部署。下次发版会改成 `nc -z 127.0.0.1 3000` 纯端口可达性测试。

### 3.10 GitHub Environment 名字 = `DEPLOY`

workflow 写 `environment: DEPLOY`（大小写敏感，与仓库 Settings → Environments 配置的名字必须严格匹配）。secrets 也配在 `DEPLOY` environment 下（不是 repo-level）。

为什么 environment 而不是 repo secret：environment 加了一层保护，可以加 required reviewer / deployment branch policy / wait timer 等。当前都是 default 没加额外门，但保留了升级空间。

## 4. 踩坑史（cc-v0.2.0 调试 5 次 CI 才全绿）

| # | 失败点 | 根因 | 修法 |
|---|---|---|---|
| 1 | build job `npm ci` | `electron-builder` devDep 加了没本地 `npm install` 同步 lock | `npm install` + push main |
| 2 | deploy job `Setup SSH` | workflow 写 `environment: production` 但 secrets 配在 `DEPLOY` | 改 workflow → `environment: DEPLOY` |
| 3 | docker build `COPY public` | `apps/console/public/` 在仓库不存在（Next 项目无静态资产） | Dockerfile 删掉那行 COPY |
| 4 | container 启动 `Cannot find @claude-center/db` | standalone trace 看不到 `webpackIgnore` 动态 import → 漏拷 workspace 包 | 见 §3.4，Dockerfile 补 COPY + 重建 symlink |
| 5 | 健康检查 HTTP 404 | `/api/auth/me` 路由不存在（项目只有 login/logout） | 改 `/api/dashboard` |

每个坑都对应一个 commit 在 main 历史里能查到。

## 5. 排错手册

### 5.1 build job 红

| 步骤红 | 排查 |
|---|---|
| `Parse tag → APP_VERSION` | tag 不符合 `cc-v[0-9]+.[0-9]+.[0-9]+` 格式 |
| `Install deps` (`npm ci`) | `package-lock.json` 没跟 `package.json` 同步——本地跑 `npm install` 后 commit lock |
| `Typecheck` | 本地 `npm run typecheck` 复现修 |
| `Build (smoke)` | 本地 `npm run build` 复现；常见 next build 编译 instrumentation 报 edge runtime `node:` 错误（见 §3.6） |
| `Extract release notes` | CHANGELOG-console.md 没 `## [X.Y.Z]` 节或节空 |

### 5.2 deploy job 红

| 步骤红 | 排查 |
|---|---|
| `Setup SSH` `private-key argument is empty` | secrets.DEPLOY_SSH_KEY 没配，或 environment 名不对（§3.10） |
| `Trust host` | secrets.DEPLOY_KNOWN_HOSTS 没配。本地 `ssh-keyscan -p 22 <host>` 输出粘进 secret |
| `Upload bundle` scp 失败 | host/port/user secret 错、或服务器 sshd 拒；用 secret 的值在本地手工 ssh 复现 |
| `Run deploy-on-server.sh` 卡在 `git fetch` | 还在跑旧版脚本——确认 workflow 用的是 `/tmp/deploy-on-server.sh` 而不是 `/opt/claude-center/scripts/...` |
| `Run deploy-on-server.sh` docker build 失败 | 上 ssh 跑 `cd /opt/claude-center && docker compose build console relay` 复现，看具体哪个 COPY 步骤错；常见 `public not found`（§3.4 类）、registry mirror 不通（§3.8） |
| `Run deploy-on-server.sh` `console 未就绪 HTTP 4xx 5xx` | docker compose logs --tail 80 console 看应用日志；常见 `@claude-center/db not found`（§3.4 漏 COPY）、`DATABASE_URL` env 没拿到（容器内 `env \| grep DATABASE`） |
| `External health check` | 5 次重试都拒：从 CI runner 走公网到 `${DEPLOY_HOST}:3000` 阻塞——防火墙 / 端口映射 / docker port binding 检查 |

### 5.3 release job 红

```
contents: write permission required
```

→ workflow `permissions: contents: write` 已配；如果改了 workflow 不小心删了，加回来。

```
no such tag
```

→ tag push 还没到 GitHub，重试（通常 1-2 秒延迟）。

## 6. 回滚

**不自动化**（避免幻觉回滚到坏版本）。手工流程：

```bash
ssh ubuntu@115.159.161.47
sudo -i
cd /opt/claude-center
docker tag claude-center-console:0.2.0 claude-center-console:rollback-snapshot   # 先备份当前
git ls-remote --tags origin 'cc-v*' | sort                                       # 看可回滚版本（本地无 .git，从远程列）
# 选 OLD = 之前 OK 的版本
# 重新触发该版本部署：从本地推一个 force tag → 不可行（tag 已存在）
# 实际操作：本地 git checkout cc-v<OLD>，scp bundle 上服务器，本地 ssh 手工跑 deploy-on-server.sh
```

更稳的方式：保留本地 git 仓库，回滚时本地 checkout 旧 tag → 本地 `tar czf` 上传 → ssh 跑 `sudo bash /tmp/deploy-on-server.sh <OLD> /tmp/cc-deploy-<OLD>.tar.gz`。

> 想自动化回滚：可以加 `scripts/rollback-web.mjs` 接受 `<OLD_VERSION>`，自动 checkout tag + scp + ssh。后续视使用频率决定要不要做。

## 7. 本地复现 CI（不推 tag）

调试 console Dockerfile / compose 时本地跑（需要本机有 docker）：

```powershell
# 1) 本地 build smoke
$env:NEXT_PUBLIC_APP_VERSION='0.2.0-test'
npm run typecheck
npm run build
npm run verify:console   # 401→200，scheduler.ok=true 才算 OK

# 2) 本地 docker compose build
$env:APP_VERSION='0.2.0-test'
docker compose config --quiet   # 语法 / env 校验
docker compose build console relay
docker compose up -d console relay
docker compose logs --tail=80 console
docker compose ps   # 看 health
```

> 本地不能完全复现服务器环境（postgres 监听、防火墙、mirror）——但能 catch 80% 的 Dockerfile / compose 配置 bug，避免 CI 来回打 tag 调试。

## 8. 升级路径（待办）

| 项 | 改动点 |
|---|---|
| HTTPS（caddy / nginx 反代 + Let's Encrypt） | docker-compose 加 caddy 服务、`CADDY_DOMAIN` env、80/443 端口映射 |
| 镜像 registry（GHCR） | 解决服务器每次部署占 CPU build。workflow 改用 `docker buildx + push ghcr.io/...`，deploy 改用 `docker pull + up` |
| 自动回滚 | `scripts/rollback-web.mjs`；可结合 GitHub Actions manual trigger |
| staging 环境 | 加 `cc-staging-v*` tag 路径、独立 environment `STAGING`、独立服务器 host secret |
| HEALTHCHECK 改 `nc -z` | alpine busybox `wget` 对 4xx 报非零导致 `unhealthy`。改 `nc -z 127.0.0.1 3000` 纯端口可达性 |
| 蓝绿 / 滚动部署 | 当前 `docker compose up -d` 是停旧起新（约 5-10s 不可用）；要零停机要起 2 实例 + nginx 切换 |
| 镜像瘦身 | runtime 镜像 ~250 MB，可继续压（multi-arch / distroless） |

## 9. 相关文件

| 路径 | 用途 |
|---|---|
| `.github/workflows/deploy-web.yml` | CI workflow |
| `apps/console/Dockerfile` | console 多阶段构建（Next standalone） |
| `apps/relay/Dockerfile` | relay 服务镜像 |
| `docker-compose.yml` | 部署组合 |
| `apps/console/next.config.mjs` (`output: standalone`) | standalone build 配置 |
| `apps/console/instrumentation.ts` / `instrumentation-node.ts` | 后台调度器（edge DCE 写法） |
| `apps/console/app/ui/shell.tsx` (`brand-version`) | 顶栏版本号显示 |
| `scripts/deploy-on-server.sh` | 服务器侧执行的部署脚本（runner scp 上来） |
| `scripts/server-bootstrap.sh` | 服务器首次准备（解 bundle + 写 .env 模板） |
| `scripts/deploy-web-trigger.mjs` | 本地推 tag 自检 |
| `scripts/extract-changelog.mjs` | CI 与本地共用：抽 release notes |
| `CHANGELOG-console.md` | 发版硬约束 |
| `docs/ops/.env` | 服务器 SSH + DATABASE_URL + GitHub Secrets 备忘（**gitignore，不进 git**） |
