# infra/ — 部署与运维脚手架

该目录保存当前部署拓扑和运维脚本，是本地 Docker、GHCR 和单 VPS 的操作基线。

## VPS 镜像定期维护

`image-retention.py` 默认只预览，`--apply` 才删除。仅处理本项目 GHCR Web/AI engine 仓库的 commit SHA 标签；保留每个仓库最新两个不同镜像版本、14 天内镜像、所有容器（含停止容器及后代镜像）的引用。自定义构建、别名、无标签镜像、容器、卷、数据库和备份均不处理；每轮最多检查 20 个旧标签。每次操作重新核对镜像 ID 和引用，使用 `docker image rm --no-prune`，无 force 或全局 prune。通过文件锁防重入，Docker 查询失败即中止，审计结果原子更新为 `latest.json`。

2026-10-21 经用户确认，已在 VPS deploy 用户启用每周实际清理 cron：UTC 周日 20:15（北京时间周一 04:15）。脚本 `/opt/deep_research/infra/image-retention.py`；报告 `/opt/deep_research/maintenance/image-retention/latest.json`，调度日志同目录 `latest.log`。当前带 `--apply`，已按用户确认开启实际删除；首次运行无候选、未删除对象。后续修改必须保留相同保护策略。修改前的 crontab 留在该目录，更新时只替换带 `deep-research-image-retention-apply` 标记的本项目任务，保留其他任务。

Zread 卷不属于镜像保留机制：普通阅读默认 browser 模式，但 AI engine 及独立 repair 仍挂载 `deep-research_zread-work`，repair 使用 `/data/zread/governance` 保存恢复状态。整卷不能按缓存删除；仓库 checkout 和 `.zread` 草稿需另外核验、列清单并确认后清理。

## 部署基线

- `docker-compose.yml`：PostgreSQL、Web、AI engine、内网 AnythingLLM 与 nginx；另提供可选的 `browser-review` Chromium profile。
- `docker-compose.registry.yml`：默认生产覆盖文件，使用 GHCR 中按 commit SHA 固定的 Web / AI engine 镜像，不在 VPS 上重新构建。
- `docker-compose.registry-render-review.yml`：可选浏览器审核覆盖文件，仅在需要真实页面审核时启用。
- `nginx.conf`：Web/AI 反代、5 MB 上传、300 秒 AI 超时、JSON access log、健康路径 `/healthz`（liveness）、`/readyz`（DB-aware readiness）和 `/ai-healthz`。
- `pg-backup.sh`：`pg_dump` + 保留最新 7 个备份文件（不是按天数清理）。POSIX sh（postgres:16-alpine 无 bash），已只读挂载到 postgres 容器 `/usr/local/bin/pg-backup.sh`；失败时删除半成品文件并返回非 0。**仓库内没有自动调度**，需运维自行配置（见下文「备份与恢复契约」的 cron 示例）。
- `pg-restore.sh`：恢复脚本；恢复会覆盖目标库，默认交互确认，非交互需 `--yes`；目标是生产默认库 `deep_research` 时还需 `--confirm-db deep_research`（交互则手动键入库名）；`--dry-run` 只校验不连库；恢复后做行数校验。
- `import-tmp-cleanup.sh`：24h 导入临时清理，默认 dry-run，加 `--apply` 才真删。需要 `bash`、`psql` 和 `DATABASE_URL`；无法取得受保护文件列表时直接中止（不再以空列表继续）。web 镜像（node:alpine）自带既无 bash 也无 psql，因此应在带 psql 的宿主机上并能访问 import-tmp 卷的位置运行。
- `web.Dockerfile`：Next.js 多阶段构建（deps → build → runner），生产使用 standalone
  server + 隔离的 Prisma/tsx 运行时依赖，内置 HEALTHCHECK。
- `ai-engine.Dockerfile`：Python 3.11 + uv 多阶段构建，内置 HEALTHCHECK。
- `render-review.Dockerfile`：Node 20 + Playwright Chromium sidecar，内置 HEALTHCHECK；不属于默认生产部署。
- Web BFF 已实现 `/api/healthz` liveness 端点（`apps/web/src/app/api/healthz/route.ts`）。
  - 它**只是 liveness**，不查数据库。`scripts/docker-entrypoint-web.sh` 在 `prisma migrate deploy` 失败时现在会 `exit 1`（容器不再带着旧 schema 启动），所以迁移失败表现为容器退出 → 发布后 `/healthz` 检查失败 → deploy.yml 回滚。
  - `/api/readyz`（nginx 暴露为 `/readyz`）执行 `SELECT 1`（2 秒超时），失败返回 503；deploy.yml 发布后同时检查 `/healthz` 与 `/readyz`。容器 HEALTHCHECK 仍用 liveness。未做 `_prisma_migrations` 最新迁移校验（follow-up）。
- Schema 漂移：CI（`web-e2e` job）在 `prisma migrate deploy` 之后运行 `scripts/check-schema-drift.sh`，对比 `schema.prisma` 与迁移后的数据库；仅允许两处已登记的无害差异（`topics.synthesisVersion` 的 client 端默认值，以及 `summaries_distilledProfile_distilledTotal_idx` 的 partial 谓词）。
- AI engine `/healthz` 在适配器不可用或内部服务令牌未配置时返回 503，部署和容器健康检查因此不会将降级状态当作健康；旧 `/health` 保持 200 并在响应中报告状态。

本地默认运行方式是原生 PostgreSQL + `pnpm dev:web` / `pnpm dev:ai`；Docker Compose 是独立的部署/恢复演练拓扑，不是本地默认依赖。
macOS launchd 常驻、彻底停止和恢复命令见 [`docs/TECHNICAL_OVERVIEW.md`](../docs/TECHNICAL_OVERVIEW.md#6-本地服务生命周期)。

## Web 镜像体积

Web 生产镜像不再复制整个 pnpm hoisted workspace。Next.js 构建开启
`output: 'standalone'` 后，runner 只带 tracing 得出的服务端依赖、静态资源和
启动期需要的 Prisma/tsx 依赖；迁移、默认管理员和默认雷达源 bootstrap 的行为保持不变。
这同时减少首次发布需要传输的字节数和 VPS 上的镜像占用。构建验证时应比较：

```bash
docker image inspect deep-research-web --format '{{.Size}}'
docker history --no-trunc deep-research-web
```

standalone 镜像仍要求构建阶段使用完整依赖；优化目标是 runner 镜像，不是牺牲构建
缓存或本地开发依赖。根目录 `.dockerignore` 还会排除本地历史 `.next-*` 构建目录，
避免把工作区残留发送给远程 Docker builder。

复用依赖时同时保留应用局部的 `apps/web/node_modules`：注入的设计系统和 workspace 链接可能位于这里，绑定整个应用目录会遮住它们。编译前在实际构建容器中校验共享包、设计系统和 MUI Next adapter 的模块解析；最终只传输 standalone、静态资源和启动依赖。

## 源码快照部署与回滚

正常发布遵循 [`CONTRIBUTING.md`](../CONTRIBUTING.md)：任务分支推送 GitHub，经 PR、CI 和合并授权进入 `main`，由 Actions 构建不可变 SHA 镜像并通过上述 registry 流程部署。工作区源码快照只作为用户明确授权的例外，不作为常规发布路径。

例外发布尚未合并的工作区时，使用独立发布目录保存排除密钥、依赖和本地证据的源码归档、逐文件 SHA-256 清单、构建日志和镜像 ID；明确记录基线提交与工作区差异，不能把源码快照称为已合并提交。依赖未变化的服务可复用相同依赖层，但运行代码必须来自同一核验快照。发布后必须通过 PR 将例外改动回收至 `main`，避免生产代码长期领先 GitHub。

替换服务前保存旧容器的镜像引用、实际环境配置和数据库备份；配置快照仅在 VPS 私密目录保存。先验证候选镜像，切换后检查 liveness、DB readiness、AI 健康和公开 AI 内部接口的 404 隔离，再检查真实页面。启用独立雷达修复 worker 时，同步核对其镜像。失败时按每个服务保存的镜像引用回滚，不能只依赖 `.deployed-image-tag`：该文件仅表示 registry 发布成功的提交，不一定代表后续快照发布。完整成功后另存包含全部服务镜像和源码指纹的发布凭证。

快照发布成功后，将 `.env` 的 `WEB_IMAGE` / `AI_ENGINE_IMAGE` 选择器同步为已验证镜像，保留其他配置与凭据，使后续普通 Compose 操作继续使用当前版本。修改前保留私密配置副本；这不改变应用实际环境变量。

构建前检查磁盘余量和峰值：依赖层提交会产生临时写入，峰值可能明显超过最终镜像增量；以 `df` 的实际余量为准，镜像大小和共享层不能直接相加。不以自动 prune 腾空间。旧镜像、备份、构建目录和验收资料保留到发布报告完成并获得清理确认；优先按清单移除没有容器引用的旧 registry 镜像，保留运行版本与回滚版本，不把 Zread 恢复资料当作普通缓存。构建、后端部署与 Chrome Web Store 审核是独立状态，后端更新不表示扩展已经通过商店审核。

## AI engine 镜像体积

AI engine 镜像偏大的原因有两层：

1. 研究引擎和雷达正文处理确实需要较重的 Python 依赖，包括 `gpt-researcher` 的 `unstructured` 链路、`PyMuPDF` 和 `litellm`。其中 Python 3.11 下的 `unstructured` 会带入 `spacy`、`numba` 和 `llvmlite`，不能只按包名删除，否则会破坏真实研究或 arXiv PDF enrichment。未被本项目实际导入的直接 `faiss-cpu` 和 `arxiv-mcp-server` 依赖已移除，保留 gpt-researcher 自身的依赖闭包。
2. 旧 Dockerfile 在 runtime 中复制 `.venv` 后再执行递归 `chown -R`，会把整份依赖树重新写入一个镜像 layer。VPS 上的 `2.21GB` 镜像 history 已观察到该重复层约 `1.04GB`。

当前 `ai-engine.Dockerfile` 已用 `COPY --chown` 在复制时设置属主，只复制运行时需要的 `ai_engine`、`configs` 和 `scripts`；根 `.dockerignore` 也排除了测试、报告和本地缓存。`ai_engine.adapters` 对 gpt-researcher 使用真正的懒加载，纯雷达工具和测试不会在导入阶段提前加载整套研究依赖。这样先消除 Docker layer 重复，再评估是否把深度研究依赖拆成独立 worker 镜像，避免为了体积牺牲现有功能。

生产 registry 覆盖还把连接池和后台并发调到资源受限 VPS 的保守档：DB pool `1/4`、source `2`、candidate `1`、LLM `3`、scoring `2`、enrichment `1`，并将 Node heap 上限设为 `256 MiB`。这会牺牲部分雷达批处理吞吐，但能把并发峰值限制在可控范围；本地开发 Compose 仍使用原来的高吞吐默认值。

## 文件

| 文件 | 用途 | 状态 |
|---|---|---|
| `docker-compose.yml` | 核心五服务 + 可选浏览器 profile | 本地构建 / 运行时基线；AnythingLLM 宿主端口只绑定 loopback |
| `docker-compose.registry.yml` | Web / AI engine GHCR 镜像覆盖 | 默认生产部署使用 |
| `docker-compose.registry-render-review.yml` | 可选 render-review GHCR 覆盖 | 需要真实浏览器审核时使用 |
| `docker-compose.certbot.yml` | ACME webroot / Certbot 兼容覆盖 | 首次签证与续期使用 |
| `certbot.Dockerfile` | Certbot + 阿里云 DNS 插件镜像 | DNS-01 自动续期使用 |
| `nginx.conf` | 反代、限制和访问日志 | 配置就绪 |
| `certbot-renew.sh` | ACME 证书续期并 reload nginx | 配合 cron 或 systemd timer |
| `web.Dockerfile` | Web 镜像 | 已在 VPS 真实构建、启动和健康检查 |
| `ai-engine.Dockerfile` | AI engine 镜像 | 已在 VPS 真实构建、启动和健康检查 |
| `render-review.Dockerfile` | Node/Chromium 页面审核 sidecar | 可选 profile，按需构建和启用 |
| `pg-backup.sh` | `pg_dump` 备份 | 脚本就绪 |
| `pg-restore.sh` | `psql` 恢复 + 行数校验 | 脚本就绪 |
| `import-tmp-cleanup.sh` | 24h 临时文件清理 | 脚本就绪 |

## Registry 部署

CI 和 Deploy 的执行机固定为 `ubuntu-24.04`，不跟随 `ubuntu-latest` 的跨版本迁移。pnpm/uv、缓存/证据上传、Docker 构建/登录/元数据、SSH agent 的 Action 使用 Node 24 运行时的官方发布；pnpm 包管理器仍为 10.0.0，uv 保留原有 latest、无缓存安装行为。升级执行机或 Action 时，通过维护 PR 重跑五项 CI 及 `CI gate`，不以压制弃用警告代替兼容性验证。

Playwright 浏览器缓存只保存浏览器二进制，不包含 apt 系统库和中文字体。每个浏览器 job 都运行独立的系统依赖安装器，使用下面描述的 apt 归档缓存，让新 runner 的依赖与冷缓存安装一致。

纯文档改动（每个路径都是 `docs/**` 或 `*.md`）不重建镜像、不重启生产。CI 与 Deploy 共用 `scripts/ci-changed-paths.sh` 判定：CI 跳过类型检查、单测和全部 E2E 套件，Deploy 跳过镜像构建、Reader Beta 发布和 VPS 部署；判定失败时按可发布处理。打进 Reader Beta 包的 Markdown（`apps/extension/{PRIVACY,BETA_INSTALL,COMPATIBILITY,BETA_CHECKLIST}.md`）属于产物，改动它们仍走完整发布流程。

CI 与发布脚手架的改动（`.github/workflows/**`、`.github/actions/**`、`scripts/ci-*`、`scripts/tests/ci-*`、`scripts/install-playwright-deps.sh`、`scripts/playwright-deps-packages.mjs`、`scripts/tests/playwright-deps-packages.test.mjs`）同样不重建镜像、不重启生产：它们必须跑完整 CI 验证，但没有任何镜像或扩展包发生变化。`scripts/ci-changed-paths.sh --scope <base> <head>` 输出 `documentation`、`ci-only` 或 `deployable` 三个档位，Deploy 按此决定是否发布。镜像实际 COPY 的文件（例如 `scripts/docker-entrypoint-web.sh`、`infra/*.Dockerfile`）属于 `deployable`。

Playwright 浏览器系统依赖（Chromium 运行库与中日韩字体，约 26 MB）由 `scripts/install-playwright-deps.sh` 安装。包清单从当前安装的 Playwright 依赖表读取，不会随版本漂移；`.deb` 文件缓存在 `/var/cache/apt/playwright`，由 CI 的 `actions/cache` 持久化。这是为了避开 Ubuntu 镜像源的限流：2026-10-23 有一次 CI 的 `apt-get install` 被限流到 35.5 kB/s，单步耗时 11m12s，直接把 `web (Playwright E2E)` 撞到超时。命中缓存时该步骤不再访问网络。相关测试：`node --test scripts/tests/playwright-deps-packages.test.mjs`。

`.github/workflows/deploy.yml` 在 `CI` 成功后执行以下步骤：

1. 下载成功 main CI 的 `ci-change-plan` 并校验目标 SHA 与事件来源；直接使用该计划决定是否发布。手动发布要求同 SHA 的完整成功校验，纯文档跳过不满足要求；必要时先从 CI 的 `workflow_dispatch` 重跑。计划和 Reader 产物保留 14 天。
2. 使用 matrix 并行构建、推送 `web` 和 `ai-engine` 两个默认生产镜像。`render-review` 不进入默认 workflow，需要浏览器审核时再显式构建并推送。
3. 镜像使用 `<commit-sha>` 标签，同时更新 `latest`。Reader 发布与镜像构建并行，直接复用成功 CI 校验过的 `reader-beta` ZIP，不再次安装依赖或构建。版本门禁比较完整 ZIP 文件树，覆盖共享设计系统及实际依赖输出，忽略 ZIP 时间戳/压缩差异；同版本内容不一致则失败，已存在的资产不会覆盖。
4. 镜像和 Reader 产物全部就绪后进入串行生产 job。先检查已部署 SHA 的祖先关系，跳过晚完成的旧版本；通过专用 SSH key 把 `infra/deploy-files.txt` 中的文件上传至 `.releases/<sha>/` 暂存目录，保留线上配置。
5. `infra/deploy-release.sh` 保存运行配置及私密环境快照，再应用候选文件、更新 Reader 元数据、备份数据库、拉取固定 SHA 镜像并启动；Web entrypoint 负责 `prisma migrate deploy` 和幂等 bootstrap。失败时恢复原 Compose/nginx/运维文件、六项发布环境值以及发布前实际运行的镜像对；其他环境配置保持原值。仅在没有现有容器时才回退使用上一 registry SHA。
6. 检查 `/healthz`、`/readyz`、`/ai-healthz` 和公开内部接口的 404 隔离；显式启用的独立 repair worker 也完成更新后，才持久化 `WEB_IMAGE` / `AI_ENGINE_IMAGE` 和成功 marker。回滚后再次检查健康。运行配置快照、数据库 dump、拉取日志均保留，清理由明确的维护操作处理。

发布脚本会并行拉取两个核心服务镜像，再统一启动 Compose；单个镜像仍保留
15 分钟超时和 3 次重试，失败时沿用原有回滚流程。这样发布耗时主要取决于最慢的
一个镜像，而不是两个镜像的下载时间之和。所有发布 SSH/SCP 连接启用保活和连接
超时，避免慢速拉取期间被中间网络设备断开。

镜像回滚不等于数据库回滚。迁移必须保持向前兼容；需要恢复 schema 时，先使用已有 PostgreSQL 备份/恢复流程。

推荐把 `production` 作为 GitHub Environment，并配置以下 Secrets：

| Secret / Variable | 用途 |
|---|---|
| `VPS_HOST` | 当前生产 VPS 地址 `159.223.50.187`，或你的部署主机地址 |
| `VPS_USER` | 专用非 root 部署用户 |
| `VPS_SSH_KEY` | 该用户对应的私钥 |
| `VPS_KNOWN_HOSTS` | `ssh-keyscan` 得到的固定主机指纹 |
| `GHCR_USERNAME` | 仅当 GHCR 镜像为私有时需要 |
| `GHCR_READ_TOKEN` | 仅当 GHCR 镜像为私有时需要，至少 `read:packages` |
| `VPS_DEPLOY_PATH`（Variable） | 默认为 `/opt/deep_research` |

GHCR 镜像可以保持私有。私有镜像只需要在首次部署时提供一个只读拉取凭据；应用 `.env`、数据库和 AI 凭据不进入 GitHub 或镜像。若将包设为公开，可不配置 `GHCR_USERNAME` / `GHCR_READ_TOKEN`。

本地验证 registry Compose 合并结果：

```bash
WEB_IMAGE=ghcr.io/csbpku/deep-research/web:local \
AI_ENGINE_IMAGE=ghcr.io/csbpku/deep-research/ai-engine:local \
docker compose \
  --env-file .env \
  -f infra/docker-compose.yml \
  -f infra/docker-compose.registry.yml \
  config --quiet

# Optional browser audit:
# render-review sidecar 需要共享 token（默认复用 INTERNAL_SERVICE_TOKEN，也可单独设 RENDER_REVIEW_TOKEN；
# 缺失时 sidecar 拒绝启动），并只接受 RENDER_REVIEW_ALLOWED_BASE_URLS（默认 http://web:3000）中的 baseUrl。
COMPOSE_PROFILES=browser-review \
RENDER_REVIEW_IMAGE=ghcr.io/csbpku/deep-research/render-review:local \
docker compose \
  --env-file .env \
  -f infra/docker-compose.yml \
  -f infra/docker-compose.registry.yml \
  -f infra/docker-compose.registry-render-review.yml \
  config --quiet
```

## Week 8 验收门

- Dockerfiles 入库且镜像可构建（本地 / VPS 真实 `docker compose build` 已验收）。
- `docker compose config` 校验通过。
- 默认健康检查：postgres / web / ai-engine 都过；浏览器审核 profile 启用时再检查 render-review。
- PostgreSQL 备份、保留和空环境恢复演练通过。
- 导入临时文件 24 小时清理可验证，备份不包含原始导入文件。
- nginx 反代把 `/healthz` 转发到 web `/api/healthz`，把 `/ai-healthz` 转发到 ai-engine `/healthz`。

首次接入环境时，必须配置 GitHub Environment secrets 并完成 Actions 实跑，之后才能标记为 CI / live verified；日常发布遵循受保护 main 的 PR/CI 流程。

## 备份与恢复契约

- **RPO**：目标 24 小时——前提是运维已自行配置每日调度（仓库**不**自带调度；未配置则没有自动备份）。保留最新 7 份。
- **RTO**：2 小时（恢复时间受网络 + 数据库大小影响；Week 8 演练验证）。
- 备份写入 `./backups/deep_research-YYYYMMDD-HHMMSS.sql.gz`；不上传异地。
- 手动备份（在仓库根目录；脚本已挂载进 postgres 容器，以 root 运行以便写入宿主机挂载的 `./backups`，产物为 root 所有、权限 0600）：
  ```bash
  docker compose --env-file .env -f infra/docker-compose.yml \
    exec -T -u root postgres /usr/local/bin/pg-backup.sh /backups
  ```
  首次启用该挂载需要重建 postgres 容器：`docker compose --env-file .env -f infra/docker-compose.yml up -d postgres`。
- 定时备份示例（**运维动作**，仓库不会自动安装；以 deploy 用户 crontab 为例）：
  ```cron
  0 0,12 * * * cd /opt/deep-research && docker compose --env-file .env -f infra/docker-compose.yml exec -T -u root postgres /usr/local/bin/pg-backup.sh /backups >> infra/logs/pg-backup.log 2>&1
  ```
- 发布前快照：`.github/workflows/deploy.yml` 在启动新版本（web 入口会执行 Prisma migrate）之前，若 postgres 容器在运行，会写入 `infra/backups/pre-deploy-<sha>-<时间>.sql.gz`；dump 失败会中止发布并回滚发布配置。工作流不删除旧备份，保留与清理由明确的维护任务处理。
- 恢复演练脚本：`infra/pg-restore.sh <file> <target_db> --yes`（恢复到生产默认库 `deep_research` 还需 `--confirm-db deep_research`；先用 `--dry-run` 自检）；恢复后自动校验核心表行数。

完成真实构建与恢复演练前，不把以上项目标为已部署或 live verified。

### TLS 选择

Compose 默认挂载 `nginx.conf`，适合本地 HTTP-only 联调。生产域名
`techradar.top` 使用 `nginx-tls.conf`；它把 80 重定向到 443、保留 ACME
HTTP-01 challenge，并添加 HSTS。registry 发布覆盖会保留这个选择，不会再用
HTTP 配置覆盖生产 nginx。

首次签发证书时，先让 DNS 的 A 记录指向 VPS，并确保防火墙放行 TCP 80/443：

```bash
cd /opt/deep-research
mkdir -p infra/certs infra/certbot/www

# 先用 HTTP-only nginx 提供 ACME challenge
sed -i.bak 's/^NGINX_CONFIG=.*/NGINX_CONFIG=nginx.conf/' .env
docker compose --env-file .env -f infra/docker-compose.yml up -d nginx

docker compose --env-file .env -f infra/docker-compose.yml --profile certbot \
  run --rm certbot certonly \
  --webroot -w /var/www/certbot \
  -d techradar.top \
  --email you@example.com \
  --agree-tos --no-eff-email

# 切换到 TLS；NEXTAUTH_URL 必须与公开地址一致
sed -i.bak 's/^NGINX_CONFIG=.*/NGINX_CONFIG=nginx-tls.conf/' .env
sed -i.bak 's|^NEXTAUTH_URL=.*|NEXTAUTH_URL=https://techradar.top|' .env
docker compose --env-file .env -f infra/docker-compose.yml up -d --force-recreate nginx
```

Certbot 证书会保存在 `infra/certs/live/techradar.top/`，不会进入 Git。续期可由
宿主机 cron 或 systemd timer 每天执行 `infra/certbot-renew.sh`；脚本只有在
Certbot 成功后才 reload nginx。证书、域名和防火墙配置仍需在 VPS 上真实完成，
并验证 HTTP 301、HTTPS 健康检查、Secure Cookie 和 HSTS 后才能宣称 HTTPS
已验收。

### 日志保留

Nginx 的访问日志和错误日志输出到容器 `stdout/stderr`，由 Docker 的
`json-file` 配置按单文件 10 MiB、最多 5 个文件轮转。这样日志不会因绑定目录
所在磁盘写满而阻断反向代理；`infra/logs/nginx/` 仍可保留历史文件，但不再是
线上 Nginx 的写入目标。生产变更后应检查 `docker inspect` 中的 logging 配置和
`docker logs --tail 20 deep-research-nginx-1`，确认日志可见且没有持续写盘错误。

### 阿里云 DNS API 自动续期

为专用 RAM 用户授予以下四个动作：`alidns:DescribeDomains`、
`alidns:DescribeDomainRecords`、`alidns:AddDomainRecord` 和
`alidns:DeleteDomainRecord`。将凭据保存为 `infra/certs/aliyun.ini`，权限设为
`600`，不要提交到 Git：

```ini
dns_aliyun_access_key = <AccessKey ID>
dns_aliyun_access_key_secret = <AccessKey Secret>
```

构建 `certbot.Dockerfile` 后，首次使用 DNS-01 签发并写入 renewal lineage：

```bash
docker compose --env-file .env \
  -f infra/docker-compose.yml \
  -f infra/docker-compose.certbot.yml \
  --profile certbot build certbot

docker compose --env-file .env \
  -f infra/docker-compose.yml \
  -f infra/docker-compose.certbot.yml \
  --profile certbot run --rm certbot certonly \
  --authenticator dns-aliyun \
  --dns-aliyun-credentials /etc/letsencrypt/aliyun.ini \
  --dns-aliyun-propagation-seconds 60 \
  --cert-name techradar.top \
  -d techradar.top
```

之后每天运行 `infra/certbot-renew.sh` 即可自动创建 DNS TXT、续期并 reload
nginx；建议用 `flock` 防止 cron 重复执行。

## Continuous radar repair

The optional independent repair project and its backup/Admin/retry/deletion gates
are specified in [the governance contract](../docs/contracts/radar-governance.md#continuous-repair-and-confirmed-noise-deletion).
Use the formal immutable `AI_ENGINE_IMAGE` and the VPS `.env` values
`RADAR_REPAIR_DIR`/`RADAR_REPAIR_ACTOR`; after a verified pilot, enable
`.radar-repair-enabled` so deployment updates the worker as well as the API.
Start with `docker compose --env-file .env -f infra/docker-compose.radar-repair.yml up -d --no-build`.
This separate project shares existing network/volumes and is not an orphan of the
main deployment. Preserve its checkpoint, deletion archives and verified backup.
