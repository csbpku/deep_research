# infra/ — 部署与运维脚手架

该目录保存目标部署拓扑和运维脚本。Week 8 完成初版，可作为部署基线。

## 当前状态（2026-07-28）

- `docker-compose.yml`：四服务目标拓扑，含健康检查和卷挂载。
- `nginx.conf`：Web/AI 反代、5 MB 上传、300 秒 AI 超时、JSON access log、健康路径 `/healthz` 和 `/ai-healthz`。
- `pg-backup.sh`：每日 `pg_dump` + 7 天保留。
- `pg-restore.sh`：恢复脚本，支持 `--yes` 强制覆盖；恢复后做行数校验。
- `import-tmp-cleanup.sh`：24h 导入临时清理，默认 dry-run，加 `--apply` 才真删。
- `web.Dockerfile`：Next.js 多阶段构建（deps → build → runner），内置 HEALTHCHECK。
- `ai-engine.Dockerfile`：Python 3.11 + uv 多阶段构建，内置 HEALTHCHECK。
- Web BFF 已实现 `/api/healthz` liveness 端点（`apps/web/src/app/api/healthz/route.ts`）。
- AI engine `/healthz` 已存在（W1）。

## 文件

| 文件 | 用途 | 状态 |
|---|---|---|
| `docker-compose.yml` | 四服务目标拓扑 | 配置就绪，未做部署验收 |
| `nginx.conf` | 反代、限制和访问日志 | 配置就绪 |
| `web.Dockerfile` | Web 镜像 | 已写，需真实构建验证 |
| `ai-engine.Dockerfile` | AI engine 镜像 | 已写，需真实构建验证 |
| `pg-backup.sh` | `pg_dump` 备份 | 脚本就绪 |
| `pg-restore.sh` | `psql` 恢复 + 行数校验 | 脚本就绪 |
| `import-tmp-cleanup.sh` | 24h 临时文件清理 | 脚本就绪 |

## Week 8 验收门

- Dockerfiles 入库且镜像可构建（需真实 `docker compose build` 验收）。
- `docker compose config` 校验通过。
- 健康检查：postgres / web / ai-engine 都过。
- PostgreSQL 备份、保留和空环境恢复演练通过。
- 导入临时文件 24 小时清理可验证，备份不包含原始导入文件。
- nginx 反代把 `/healthz` 转发到 web `/api/healthz`，把 `/ai-healthz` 转发到 ai-engine `/healthz`。

## 备份与恢复契约

- **RPO**：24 小时（每日 0:00 / 12:00 跑 `pg-backup.sh`；保留 7 天）。
- **RTO**：2 小时（恢复时间受网络 + 数据库大小影响；Week 8 演练验证）。
- 备份写入 `./backups/deep_research-YYYYMMDD-HHMMSS.sql.gz`；不上传异地。
- 恢复演练脚本：`infra/pg-restore.sh <file> --yes`；恢复后自动校验核心表行数。

完成真实构建与恢复演练前，不把以上项目标为已部署或 live verified。
