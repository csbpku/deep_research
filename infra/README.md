# infra/ — 部署与运维脚手架

该目录保存目标部署拓扑和运维脚本。目前不是已验证的生产部署。

## 当前状态（2026-07-24）

- `docker-compose.yml` 描述 PostgreSQL、Web、AI engine 和 nginx 四服务。
- `nginx.conf` 包含 Web/AI 反代、5 MB 上传限制、300 秒 AI 超时和 JSON access log。
- `pg-backup.sh` 提供 PostgreSQL 备份脚本。
- Compose 引用的 `infra/web.Dockerfile` 与 `infra/ai-engine.Dockerfile` 尚未入库，因此 `docker compose up` 不能作为当前可用启动路径。
- TLS 证书目录、备份落点、24 小时导入清理、恢复演练和真实 `/healthz` 验证均待 Week 8 完成。

## 文件

| 文件 | 用途 | 状态 |
|---|---|---|
| `docker-compose.yml` | 四服务目标拓扑 | scaffold |
| `nginx.conf` | 反代、限制和访问日志 | 配置已存在，未做部署验收 |
| `pg-backup.sh` | `pg_dump` 备份 | 脚本已存在，未做恢复演练 |
| `web.Dockerfile` | Web 镜像 | 缺失 |
| `ai-engine.Dockerfile` | AI engine 镜像 | 缺失 |

## Week 8 验收门

- Dockerfiles 入库且镜像可构建。
- `docker compose config` 与干净环境启动通过。
- PostgreSQL 备份、保留和空环境恢复演练通过。
- 导入临时文件 24 小时清理可验证，备份不包含原始导入文件。
- nginx、Web 与 AI engine 健康检查通过。

完成并记录真实命令输出前，不把以上项目标为已部署或 live verified。
