# infra/ — 部署与运维

> 工程师 B 主维护，工程师 A review 端口 / 域名。
> 详见 IMPLEMENTATION_PLAN §二 §周度人力预算（Week 8 是部署周）。

## 包含

| 文件 | 用途 |
|---|---|
| `docker-compose.yml` | postgres + web + ai-engine + nginx 四服务 |
| `web.Dockerfile` | apps/web 多阶段构建 |
| `ai-engine.Dockerfile` | packages/ai-engine 多阶段构建 |
| `nginx.conf` | 反代、上传 5m 限制、长任务 300s 超时 |
| `backups/` | pg_dump 落点（gitignored） |
| `certs/` | TLS 证书（gitignored） |
| `pg-backup.sh` | 每日 pg_dump 备份（架构 §十三 §8） |

## Week 8 验收

- ✅ `docker compose up -d` 干净启动
- ✅ 每日 pg_dump + 24h 保留
- ✅ 空环境恢复演练（按 IMPLEMENTATION_PLAN §十 验收）
- ✅ `/healthz` 通过
- ✅ `/data/import-tmp` 24h 清理（架构 §四点七 P0 文件安全边界）
- ✅ 备份不包含原始导入文件
