# 雷达 Zread enrichment 缺口盘点

## 2026-09-08 fallback 策略真实验证

- remote 根发现请求默认最多等待 `45s`。无 catalog 且无可读根正文时立即放弃 remote，交给本地 CLI；这条路径已对 `Juror-AI/juror` 真实验证，耗时 `45.0s` 返回空结果。
- 已存在 `zread-cli` draft 的 retry 不再先访问 remote，直接复用 durable checkout 的 `--draft resume`。remote 仍用于新仓库和没有本地 CLI draft 的候选；有 catalog 的 remote 任务继续按页面逐步抓取，不把慢误判成失败。
- 2026-09-08 当前 durable 快照：`collection/deep_read=380`，`ready=362`、`retryable=11`、`running=2`、`manual=5`。正在运行的两条中，`mksglu/context-mode` remote catalog 为 `24` 页且正在抓取，`Juror-AI/juror` 由独立 repair job 续租。

## 2026-09-08 deep_read+ 全量缺口

数据库只读快照显示 `collection/deep_read` 共 `377` 条：`ready=357`、`manual=11`、状态 `NULL=9`，无 `running/retryable`；正文与 hash 为 `377/377`。严格不完整为 `20` 条：

| 分类 | 数量 | 实际对象 |
|---|---:|---|
| `zread-cli` partial | 4 | BrightbeamAI/chap、calmrocks/ai-engineer-notebooks、getkern/kern、Juror-AI/juror |
| README fallback partial | 3 | lajosdeme/mole、okf-memory/okf-agent-memory、Staatsgeheim/MathKernel |
| Zread failed | 4 | kelviq/tare、magnitudedev/magnitude、radixark/miles、WorldFlowAI/everything-claude-code |
| NULL / no Zread | 9 | bytedance/deer-flow、heygen-com/hyperframes、jo-inc/camofox-browser、lightpanda-io/browser、microsoft/markitdown、mksglu/context-mode、timgordontg/engrim、trailofbits/coop、Hugging Face Papers `2609.04611` |

其中“7 条 partial”不是同一种问题：只有前 4 条适合直接做 page-level CLI resume；3 条 README fallback 需要先强制进入 CLI enrichment。`NULL/no Zread` 是没有 durable enrichment 记录的首次生成缺口，不能伪装成历史 page gap。

## 2026-09-08 page-level 修复后的真实状态

本轮对 5 条此前授权的目标做了数据库只读复核。应以 canonical catalog 覆盖为准；保存页数包含历史保留页，不能直接当作目录完成度。

| repo | source 状态 | 保存页数 | canonical catalog 覆盖 | 备注 |
|---|---|---:|---:|---|
| BrightbeamAI/chap | manual / partial | 13 | 2/25 | 仍有 23 个 canonical page 缺失 |
| calmrocks/ai-engineer-notebooks | manual / partial | 34 | 5/29 | 仍有 24 个 canonical page 缺失 |
| getkern/kern | manual / partial | 10 | 1/28 | 仍有 27 个 canonical page 缺失 |
| Juror-AI/juror | manual / partial | 18 | 5/63 | 有重复目录语义，仍有 58 个 canonical page 缺失 |
| vivekhaldar/seed | ready / complete | 22 | 22/22 | 正文完整；内容审核尚需人工，页面审核仍排队 |

当前 5 条没有活动 lease/claim。对 `Juror-AI/juror` 的真实 remote 探针在 2026-09-08 返回空结果，说明本轮 remote 仍不可依赖，但不能据此断言永久不可用。CLI fallback 仍可定位到本机 npm 全局安装的 `zread_cli`，并已在 `seed` 上真实验证 resume 修复路径。

后续继续修复的前置条件是重新取得稳定且无歧义的 canonical catalog；`juror` 应先做目录去重/语义合并，再执行有界 page-level CLI resume。未满足前，不应把其余 4 条当作“只差少量页面”自动重跑。

快照时间：2026-08-29 14:42（Asia/Shanghai）。
范围：originalKind='github_repo' 且 distilledTier IN ('collection','deep_read')。

## 主批跑结果（已结束）

前台 PTY 会话 99747（concurrency=1、item-timeout=0、ZREAD_CLI_TIMEOUT_SECONDS=14400、minimax-m3 直连、GitHub API 60/60）已结束：

| repo | 结果 | 备注 |
|---|---|---|
| volcengine/OpenViking | complete 24/24 | 12:33 完成 |
| unslothai/unsloth | complete 30/30 | 13:40 前完成 |
| nvm-sh/nvm | complete 24/24 | 13:40 前完成 |
| Juror-AI/juror | partial 28/33 | zread 写完 33 篇 drafts 后 hang 在 publish 阶段，14:41 SIGKILL 进程组释放 wrapper，落库 28 篇（5 篇 0 字节/空 content 被 _read_wiki 过滤） |

## 缺口（更新于 2026-08-29 14:42）

| 状态 | 数量 |
|---|---|
| complete（deep_read） | 68（+3） |
| 真实仓库无 zread | 0 |
| 真实仓库 partial | 5（4 条 1/1 README fallback + juror 28/33） |
| legacy digest 行 | 2（continue、aider，管道按设计跳过） |
| collection 档 github_repo | 0 |

## 备注

- 2026-08-28 17:19 已按用户要求杀掉全部遗留 zread / run_enrichment 进程；之后用户重新打开跑批。
- 2026-08-29 12:33 启动前台 PTY 批跑（session 99747），全部目标在 14:41 之前完成；OpenViking/unsloth/nvm 走通 complete；juror 因已知 zread publish 阶段 hang，最后通过 SIGKILL 进程组让 wrapper 把 32 篇 drafts 读出（过滤 0 字节/空 content 后剩 28 篇）。
- 4 条 README fallback（1/1）的 retry 受 GITHUB_ENRICHMENT_RETRY_SECONDS 控制，本批跑完后可单独强制重试。
