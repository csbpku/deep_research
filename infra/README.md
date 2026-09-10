# infra/ — 部署与运维脚手架

该目录保存目标部署拓扑和运维脚本。Week 8 完成初版，可作为部署基线。

## 当前状态（2026-09-10）

- `docker-compose.yml`：五服务目标拓扑，含健康检查和卷挂载。
- `docker-compose.registry.yml`：生产覆盖文件，使用 GHCR 中按 commit SHA 固定的 Web / AI engine / render-review 镜像，不在 VPS 上重新构建。
- `nginx.conf`：Web/AI 反代、5 MB 上传、300 秒 AI 超时、JSON access log、健康路径 `/healthz` 和 `/ai-healthz`。
- `pg-backup.sh`：定期 `pg_dump` + 保留最新 7 个备份文件（不是按天数清理）。
- `pg-restore.sh`：恢复脚本，支持 `--yes` 强制覆盖；恢复后做行数校验。
- `import-tmp-cleanup.sh`：24h 导入临时清理，默认 dry-run，加 `--apply` 才真删。
- `web.Dockerfile`：Next.js 多阶段构建（deps → build → runner），内置 HEALTHCHECK。
- `ai-engine.Dockerfile`：Python 3.11 + uv 多阶段构建，内置 HEALTHCHECK。
- `render-review.Dockerfile`：Node 20 + Playwright Chromium sidecar，内置 HEALTHCHECK。
- Web BFF 已实现 `/api/healthz` liveness 端点（`apps/web/src/app/api/healthz/route.ts`）。
- AI engine `/healthz` 已存在（W1）。

本地默认运行方式是原生 PostgreSQL + `pnpm dev:web` / `pnpm dev:ai`；Docker Compose 是独立的部署/恢复演练拓扑，不是本地默认依赖。

## AI engine 镜像体积

AI engine 镜像偏大的原因有两层：

1. 研究引擎和雷达正文处理确实需要较重的 Python 依赖，包括 `gpt-researcher` 的 `unstructured` 链路、`PyMuPDF`、`litellm` 和 `faiss-cpu`。其中 Python 3.11 下的 `unstructured` 会带入 `spacy`、`numba` 和 `llvmlite`，不能只按包名删除，否则会破坏真实研究或 arXiv PDF enrichment。
2. 旧 Dockerfile 在 runtime 中复制 `.venv` 后再执行递归 `chown -R`，会把整份依赖树重新写入一个镜像 layer。VPS 上的 `2.21GB` 镜像 history 已观察到该重复层约 `1.04GB`。

当前 `ai-engine.Dockerfile` 已用 `COPY --chown` 在复制时设置属主，只复制运行时需要的 `ai_engine`、`configs` 和 `scripts`；根 `.dockerignore` 也排除了测试、报告和本地缓存。这样先消除 Docker layer 重复，再评估是否把深度研究依赖拆成独立 worker 镜像，避免为了体积牺牲现有功能。

## 文件

| 文件 | 用途 | 状态 |
|---|---|---|
| `docker-compose.yml` | 五服务目标拓扑 | 本地构建 / 运行时基线 |
| `docker-compose.registry.yml` | GHCR 镜像覆盖 | 生产部署使用 |
| `nginx.conf` | 反代、限制和访问日志 | 配置就绪 |
| `web.Dockerfile` | Web 镜像 | 已在 VPS 真实构建、启动和健康检查 |
| `ai-engine.Dockerfile` | AI engine 镜像 | 已在 VPS 真实构建、启动和健康检查 |
| `render-review.Dockerfile` | Node/Chromium 页面审核 sidecar | Compose / GHCR 配置就绪，待本批发布实跑 |
| `pg-backup.sh` | `pg_dump` 备份 | 脚本就绪 |
| `pg-restore.sh` | `psql` 恢复 + 行数校验 | 脚本就绪 |
| `import-tmp-cleanup.sh` | 24h 临时文件清理 | 脚本就绪 |

## Registry 部署

`.github/workflows/deploy.yml` 在 `CI` 成功后执行以下步骤：

1. 使用同一个提交 SHA 构建 `web`、`ai-engine` 和 `render-review` 三个镜像。
2. 推送到 GHCR 对应的三个 `<commit-sha>` 镜像，同时更新 `latest`。
3. 通过专用 SSH key 上传 Compose / nginx 运维文件到 VPS。
4. VPS 拉取固定 SHA 镜像，使用现有 `.env` 启动；Web entrypoint 负责 `prisma migrate deploy`、幂等 Admin bootstrap 和幂等默认雷达源 bootstrap。
5. 通过 `/healthz` 和 `/ai-healthz` 做发布后检查；失败时尝试恢复上一个镜像 SHA。

镜像回滚不等于数据库回滚。迁移必须保持向前兼容；需要恢复 schema 时，先使用已有 PostgreSQL 备份/恢复流程。

推荐把 `production` 作为 GitHub Environment，并配置以下 Secrets：

| Secret / Variable | 用途 |
|---|---|
| `VPS_HOST` | VPS 地址，例如 `120.76.248.204` |
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
RENDER_REVIEW_IMAGE=ghcr.io/csbpku/deep-research/render-review:local \
docker compose \
  --env-file .env \
  -f infra/docker-compose.yml \
  -f infra/docker-compose.registry.yml \
  config --quiet
```

## Week 8 验收门

- Dockerfiles 入库且镜像可构建（本地 / VPS 真实 `docker compose build` 已验收）。
- `docker compose config` 校验通过。
- 健康检查：postgres / web / ai-engine / render-review 都过。
- PostgreSQL 备份、保留和空环境恢复演练通过。
- 导入临时文件 24 小时清理可验证，备份不包含原始导入文件。
- nginx 反代把 `/healthz` 转发到 web `/api/healthz`，把 `/ai-healthz` 转发到 ai-engine `/healthz`。

GHCR 自动发布和 SSH 部署工作流已经入库，但必须等 GitHub Environment secrets 配齐并完成一次 Actions 实跑后，才能标记为 CI / live verified。

## 备份与恢复契约

- **RPO**：24 小时（每日 0:00 / 12:00 跑 `pg-backup.sh`；保留 7 天）。
- **RTO**：2 小时（恢复时间受网络 + 数据库大小影响；Week 8 演练验证）。
- 备份写入 `./backups/deep_research-YYYYMMDD-HHMMSS.sql.gz`；不上传异地。
- 恢复演练脚本：`infra/pg-restore.sh <file> --yes`；恢复后自动校验核心表行数。

完成真实构建与恢复演练前，不把以上项目标为已部署或 live verified。
