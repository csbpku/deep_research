# 技术方案总览

> 当前现役技术方案摘要；描述稳定的系统行为与边界。

## 1. 项目边界

Deep Research 是面向个人和小团队的技术调研平台，负责：

- 从 GitHub、arXiv、RSS、厂商更新和社区来源发现技术候选；
- 对候选做正文抽取、AI 解读、Distilled 评分和阅读等级分层；
- 按专题聚合候选，生成热点议题和带引用的专题综述；
- 支持 AI 调研、研究稿、快速判断、Slides 提纲、网页简报和知识卡片；
- 提供独立 Chrome MV3 原网页阅读助手：在公开技术网页中按需全文翻译（含图片文字覆盖）、选段解读、连续追问、续读和本地收藏；雷达与研究库同步是可选连接；
- 支持登录、收藏、批注、评论、分享、全文搜索和 Admin 治理。
- AI 开题按关键词及专题自动展示本人已有判断和研究，只有明确选择的资料才带入调研；手动搜索和可选语义检索继续可用。语义索引只接收用户确认的笔记/判断，不收 Reader 摘录或完整报告。
- 雷达概览/详情支持记录个人判断，Reader 保存可携带经服务端校验的雷达身份并继承专题。保存确认与公开发布独立：本人已确认知识草稿可在专题和相关雷达再次出现，其他人仅能看到已发布研究。Reader 同页重读展示已有本地收藏和本人平台判断，保留来源及版本提示。“打开原文”先探测 Reader：已安装兼容版本时打开来源页并唤起原生侧栏；未安装时进入 Chrome Web Store。旧安装引导页直接重定向商店。

当前不追求高可用多机部署或异地数据库自动切换。生产目标是单 VPS、受控账号、可恢复后台任务和可验证的内容质量；注册策略需在生产设置 `AUTH_BETA_MODE=1` 才会关闭公开注册，代码默认 `0` 并不符合仅白名单开放的目标。

## 2. 运行拓扑

| 部件 | 责任 | 本地原生 | Docker / VPS |
|---|---|---|---|
| `apps/web` | Next.js 页面、BFF、NextAuth、Prisma | `3000` | `web:3000` |
| `packages/ai-engine` | FastAPI、LLM、雷达和后台 worker | `4000` | `ai-engine:4000` |
| PostgreSQL | 业务数据、队列、全文索引 | `5432` | `postgres:5432` |
| nginx | 公网反代、上传限制、健康路由 | 可选 | `80/443` |
| `apps/extension` | 独立 Chrome 侧栏、正文/图片处理、会话与收藏 | 加载解压目录 | Chrome 116+ |
| AnythingLLM | AI 调研助手的可选集成、个人知识语义索引及遗留雷达会话 API | 可选独立服务 | Compose 内网服务；宿主只绑定 loopback |

默认生产 Compose 运行 PostgreSQL、Web、AI engine、AnythingLLM 和 nginx。AnythingLLM 的 UI/API 只绑定 VPS loopback；Chromium `render-review` 是可选 profile，不属于默认生产资源预算。
个人知识索引使用独立于旧共享讨论 workspace 的 per-user workspace，`ANYTHINGLLM_PERSONAL_KNOWLEDGE_ENABLED` 默认关闭。

## 3. 核心数据流

### 雷达

```text
source sync
  -> transient original-source fetch (prefer full text; source snippet fallback)
  -> utility LLM brief + distilled score from the fetched text
  -> persist brief, score, URL and bounded source metadata; never persist full source text
  -> external reading entry (browser mode, default)
  -> topic workers retain their full-enrichment and review gates

legacy enriched mode (explicit opt-in only)
  candidate persistence -> 正文抓取 / enrichment -> reader quality -> content review
```

浏览器模式仍会在同步期间尽量抓取来源原文，供摘要和评分使用；全文只在处理期间暂存，不写入 summaries 或诊断正文，也不启动后续正文 enrichment。抓取失败或只拿到短内容时才回退到来源摘要，并在评分依据中标明。用户阅读、翻译和保存由原文/Reader 完成。显式启用 legacy enriched mode 时才持久化站内阅读正文并执行后续质量与内容审核。网络失败、正文不完整、评分缺失、内容审核未完成和主题聚类失败不能互相伪装成成功。

评分和摘要对较长正文按章节/段落及离线保守 token 估算分块（默认每块约 6,000 token-equivalent），逐块提取证据/要点，再聚合全文结论；评分引用会对照当次抓取的原文校验。模型没有 tokenizer 可用时使用偏保守的混合文本估算，仍受来源抓取响应大小上限约束。分块正文不持久化。

### Enrichment 与审核

- 阅读等级统一为精读（`deep_read`）、速读（`skim`）、噪声（`noise`），原 `collection` 并入精读，用户收藏保持独立。新评分使用 Distilled 5.1，已有有效分数及版本保留；站外阅读迁移使用显式 Admin 来源核验和审计，默认不重评分。只有单独选定的旧噪声允许按当前标准复核。
- `distilledTargetTier` 保存评分得到的目标层级；`distilledTier` 表示雷达展示层级。传统服务端阅读模式下，目标为 `collection/deep_read` 但 enrichment 未完成时，实际层级为 `skim`；带 `external_reading` 标记的候选通过原文 URL/Reader 阅读，不要求服务端 enrichment，可保留评分层级。数据库 trigger 区分两种阅读路径，详情接口仍不返回外部阅读候选的缓存原文。
- `enrichmentStatus` 表示来源正文资产是否完成；
- `readerQualityStatus` 表示正文是否满足阅读质量门槛；
- `contentReviewStatus` 表示当前正文内容审核结果；
- `renderReviewStatus` 只属于可选 Chromium 页面审核，不是默认交付门槛。

当前默认审核路径是“正文质量检查 + 内容审核 + 可恢复 reconciliation”。历史 Chromium `unavailable` 不能代表当前内容审核失败；关闭 browser-review 时不会启动 Chromium，也不会重新创建 render 队列。

### AI 调研

Web 先创建可追踪任务，AI engine 通过 durable job store 异步执行研究、草拟、来源绑定、事实核验和产物入库。HTTP 请求只负责提交、查询和取消，不在请求线程内等待完整研究。

研究助手对长草稿的改写、摘要和反方观点按全文分块处理；事实核验的声明抽取也覆盖完整报告。Reader 选择“整页”问答/解释时，正文按章节/段落和离线 token 估算分块、逐块分析并汇总；单块或汇总失败会明确失败，不返回伪装成全文结论的部分结果。默认每块约 6,000 token-equivalent，可分别用 `RESEARCH_ASSISTANT_CHUNK_TOKENS`、`RESEARCH_REVIEW_CHUNK_TOKENS` 和 `READER_ANSWER_CHUNK_TOKENS` 调整。分块正文仅在请求处理中使用，不持久化。

### 研究库与个人语义索引

PostgreSQL `Research` 是研究库权威数据源；AnythingLLM 只提供可选的个人知识语义候选，不另建个人聊天入口，也不复用旧共享雷达/讨论 workspace。

- Reader 在平台模式下保存为本人私人草稿；原文摘录与锚点保留为来源，不进入向量文本。索引只含本人笔记和确认过的 AI 结论。AI 调研稿自动入研究库、不复制整份报告；用户选中一条回答或报告判断并确认后，才另存为私人知识草稿。
- 知识索引文本与持久 outbox 操作在同一数据库事务提交。outbox 不设 Research 外键，以便硬删除后保留清理墓碑；worker 从数据库读取当前有效草稿和来源引用，再执行 upsert/delete，失败时退避重试。编辑会生成新一代任务；发布、归档和硬删除会排队移除向量文档。
- 每位用户使用独立的 `dr-private-<user UUID>` workspace。AnythingLLM 检索 API 只返回记录 UUID；Web BFF 按当前用户、`knowledge` 类型和 `draft` 状态回查数据库最新版本，不信任向量返回的文本。候选在“已有资料”中默认不勾选，用户确认后才写入调研 `sourceRefs`；AnythingLLM 关闭、超时或索引滞后时保留关键词结果。AI engine 还会重新校验调研来源权限。
- `ANYTHINGLLM_PERSONAL_KNOWLEDGE_ENABLED` 默认 `0`。旧共享讨论 workspace 不复用，历史已发布知识卡片不批量导入。

### 原网页阅读

独立 Beta 在用户点击扩展按钮后通过 `activeTab` / `scripting` 注入当前页，提取正文块、选段和正文图片；侧栏直接调用用户配置的 OpenAI-compatible `/chat/completions` 或 Anthropic-compatible `/messages` 接口，不加载 Web iframe、不要求平台账号、不把 API Key 放进网页。正文翻译的长文首批缩小以提前显示，后续按最多约 3,000 字符批量处理，仍携带标题、提纲、开头及相邻段落语境；结构有效的部分结果只补译缺失或冲突项，截断结果仍完整重试。独立模式的正常批次与补译共享有界队列，翻译缓存按批次读写并保持 500 条上限。图片通过视觉模型返回文字区域与坐标，并在原图上生成可移除的译文覆盖层；Anthropic 图片请求在扩展边界转换为 base64，跨域图片无法读取时保留 URL并显示处理失败。正文、图片和页面内容始终按不可信资料处理，排除表单、密码和 `contenteditable`。

侧栏的阅读会话、滚动位置、选段、讨论和收藏存储在 IndexedDB；全文翻译结果只作为有界缓存，API Key 不进入导出数据。选择整页问答/解释时，平台模式把完整提取正文送入服务端分块分析并汇总；选择选段/章节时则按明确范围处理。React 负责侧栏 UI，独立控制器连接 content script、MV3 worker、IndexedDB 和可选平台服务；页面状态和模型密钥不会写回网页。

界面语言默认跟随浏览器，当前提供简体中文和英文；中文浏览器区域变体统一使用简体中文，其他语言回退英文。翻译目标语言独立选择并记忆，不限制为界面语言。聊天按用户提问语言回答。

平台连接是可选层：连接后才调用 `/api/reading/answer`、`/api/reading/answer/stream`、`/api/reading/translate`、`/api/reading/translate-image`、`/api/reading/answer-image` 和 `/api/reading/save`，将用户确认的成果同步到研究库；平台不可用时，独立翻译、图片处理、讨论和本地收藏仍可用。研究库同步继续保留数据库幂等键和安全锚点校验。雷达的新外部原文入口不依赖 enrichment；`RADAR_READING_MODE=browser` 只停止全文持久化和后续 enrichment，不停止同步期间的临时全文抓取与评分。

平台全文翻译的吞吐由批次与并发决定，不由模型决定。扩展按最多 24 块、约 3,000 字符打包请求，并最多同时发出 6 个请求；Web BFF 以同样的 24 块上限拆分并允许 6 个并发在途；AI engine 的 LLM 信号量 `RADAR_LLM_CONCURRENCY` 同样是 6（registry overlay 默认值，可用 `.env` 覆盖）。三者对齐后，287 块、41,215 字符的文章在生产链路的实测墙钟从约 96 秒降到约 52 秒，覆盖仍为 287/287。可重试的供应商失败（429/529/超时）先等待抖动指数退避再重试，避免立即重试把瞬时过载放大成连续失败；`LLM_RETRY_BACKOFF_SECONDS` 与 `LLM_RETRY_BACKOFF_MAX_SECONDS` 控制退避窗口。MiniMax 的 OpenAI 兼容端点只识别 `reasoning_effort`，不识别 Anthropic 协议的 `output_config.effort`。

Reader 与 Monica 原网页交互的对照、技术阅读差异化、双模式权威数据边界和明确非目标见 [`READER_PRODUCT_DECISIONS.md`](./READER_PRODUCT_DECISIONS.md)。

雷达迁移由 `RADAR_READING_MODE` 控制，默认值为 `browser`。新同步尽量抓取来源正文用于当次摘要和评分，但不持久化全文；后续 enrichment/recovery 队列保持关闭。专题刷新、议题提取与综合采用统一的公开阅读门槛：已评分的 external-reading 高价值候选使用入库摘要/判断参与专题，不要求持久化正文；旧站内阅读候选仍要求 enrichment、正文质量和内容审核通过。专题关联匹配标题、URL、内容标签及保存的摘要/判断，预设关键词支持中英文；噪声、未评分、已屏蔽/归档、未审核分享和 GitHub Issue/PR/Release 不进入专题。候选成员变化（包括总数不变时的替换）会清除综述缓存与输入 hash，下一轮重新生成。显式设置为 `enriched` 才运行旧的站内正文链路；历史行和显式 Admin enrichment 保留，便于渐进迁移和回滚。

雷达状态治理通过 Admin 批量预检/执行和同源 SSH 维护核心完成，保留正文、历史诊断及引用，支持审计、条件写入、断点补救和安全回滚。已授权的确认噪声使用独立物理删除流程，要求当前有效噪声评分及无引用保护，原文抓取失败或片段不阻止处置，并先保留库外恢复归档；接口、预算和操作边界见 [`contracts/radar-governance.md`](./contracts/radar-governance.md)。

每条雷达的必需内容、条件字段与检查状态见 [质量清单](./contracts/radar-quality-checklist.md)。`scripts.audit_radar_quality` 在一致性只读快照下检查全部保留雷达，有效评分噪声单列；生产内存受限时使用隔离流式检查，执行边界见清单。字段齐全、评分有效、公开资格和语义质量分别记录。公开详情、列表/搜索、调研来源回查及专题管线复用有效评分门槛；专题候选、热点证据和趋势读取时也重新核对旧关联资格，不以历史关联直接授予公开资格。

来源轮询遇到有效运行租约时保留“仍到期”状态，下个 tick 再核查；部署中断留下的过期运行会先标记 `STALE_RUN_REAPED` 再按正常链路重试，避免一次跳过消耗整个轮询窗口。确定性抓取失败上限按来源、规范 URL、规范标题与出版时间共同判断，不阻断相同 URL 上的不同出版内容。

### 统一设计系统

Web 与 Reader 共享 `packages/design-system` 的字体、间距、色彩、断点和语义状态，使用真实的 MUI 9.5 与 Emotion。Web 通过 Next.js 15 的 `AppRouterCacheProvider` 收集服务端样式，领域组件位于 `apps/web/src/components/material/`；Reader 使用相同主题并对侧栏密度作适配。Markdown、网页译文覆盖层和复杂布局继续使用受共享 token 约束的原生 DOM/CSS。

Web 的主题模式由 next-themes 和 `dr-theme` 统一管理；旧 CSS 变量的生成桥接只用于尚需原生 DOM 的内容，不另维护颜色真值。修改基础值后运行设计系统生成器，提交生成 CSS 并执行 `--check` 和对比度测试。`/mui-demo` 仅为开发环境的真实雷达复用入口，生产返回 404。

## 4. LLM 路由

业务代码只选择用途，不直接绑定供应商：

| 用途 | 环境变量 | 默认职责 |
|---|---|---|
| 重量级研究 | `RESEARCH_LLM` | gpt-researcher 主流程 |
| 工具型调用 | `UTILITY_LLM` | 评分、摘要、审核、聊天、热点聚类 |
| 统一备用 | `FALLBACK_LLM` | 主路由失败后的 fallback |
| Reader 图像翻译 | `READING_VISION_LLM` | 默认跟随 `UTILITY_LLM`；可单独指定可接收图片的模型 |

格式统一为 `<provider>:<model>`。当前默认模型路由为 MiniMax M3.1 Flash（`minimax:MiniMax-M3.1-Flash`）主模型、DeepSeek fallback；凭据只通过运行时环境注入。旧的 `SMART_LLM`、`FAST_LLM`、`STRATEGIC_LLM`、`BRIEF_LLM` 只作为兼容镜像，不是业务真相源。M3.1 不支持关闭思考：共享客户端的工具型调用使用 `low`，重量级研究默认使用 `high`；gpt-researcher 的 OpenAI 兼容调用也显式设置研究思考档位，避免供应商默认 `max`。

有效 fallback 与主路由相同时会被归一化为 `None`；清空变量仍可能使用代码默认值。AnythingLLM 的对话供应商独立配置，切换模型时需分别核对 AI Engine 有效路由与 AnythingLLM 设置。生产 registry Compose 可从 VPS 私有文件 `infra/anythingllm/.env` 加载设置快照，避免容器重建丢失供应商选择；通过 AnythingLLM API/UI 修改供应商后需同步更新该文件，不得提交凭据。嵌入模型与生成模型分别管理。

### 雷达缺分与判断维护

默认外部阅读模式在同步阶段尝试初评；初评降级后会保留缺分内容和诊断，URL 去重不会补分。`scripts.repair_radar` 提供独立于 enrichment 的持久恢复进程，覆盖现有自动雷达和已批准分享，包含归档/拒绝项；优先补有效评分，再补摘要与判断。每次至多两次单次模型请求，评分和摘要分阶段审计落库，已有有效评分保留；失败有明确代码、退避与次数上限，断点和调用预留先写持久卷。当前有效噪声评分且无用户/研究引用的自动雷达允许物理删除，原文抓取失败或片段不阻止处置，先将内容与关联诊断归档到库外，再同事务写审计和删除；审计中的最小出版身份阻止同篇噪声重新入库。新同步确认噪声后直接跳过入库，只保留无正文/摘要的已处置身份记录，避免同篇重复抓取和评分。操作、重排队及恢复边界见 [治理契约](./contracts/radar-governance.md)。

仍缺有效评分或摘要、经当前来源核验确认无法取得可用内容且无引用的自动雷达，可按独立来源处置策略删除；模型错误、临时限流、体积超限或未确认的 README 路径不直接进入删除清单。来源删除保留库内诊断历史，只结束对应当前待办；逐条恢复校验归档、提交审计和保留后整行指纹，拒绝覆盖后续修改。该策略通过显式 Admin 维护执行，具体资格与预检条件见同一治理契约。

摘要完成检查同时识别明确的来源不可读回复和仅凭标题推断的占位内容；有实质信息的论文摘要及诚实的证据限制继续保留。补救只替换缺失或占位字段，不覆盖有效评分。可读来源的七维全零结果仍不作为有效评分；仅显式 Admin 证据复核可独立确认其为噪声，须匹配真实模型调用、原文引句、来源hash及未变化的行，沿用引用保护、归档和事务审计；不会自动补造非零分数。细则见同一治理契约。

`packages/ai-engine/scripts/rescore_active_radar.py` 只补 `distilledScore IS NULL` 的条目，选取、处理前检查及落库均保护已有评分，包括旧版本评分；禁止 enrichment。`--minimax-only --state-file <path>` 必须成对使用，要求 research/utility 的 light/heavy 主路由均为 MiniMax 且有效 fallback 为 `None`。断点固定目标清单，按评分版本和证据范围隔离；普通失败进入 unresolved，需显式 `--retry-unresolved` 才重试。

`--include-archived` 同样要求 MiniMax 断点模式，默认仅使用库内已有证据；评分脚本可另外显式指定 `--transient-external` 临时获取原文，不落全文缓存。`backfill_radar_briefs.py` 只补空判断：活跃 external-reading 条目临时获取原文，归档条目在 `--include-archived` 模式下仅使用已有快照。证据或判断不足保持未解决，不根据标题生成占位内容。两种脚本的归档/活跃范围使用独立断点，不得混用。

评分脚本遇额度/429错误会取消同批未完成任务并保存断点；`--quota-wait-seconds` 默认18000秒，但当前循环最多等待900秒即清空等待截止时间并再次探测，因此不能保证实际退避5小时。判断脚本按15分钟暂停重试。两者均非已知供应商账户重置时间。评分日志记录各阶段耗时、调用和分块数量，模型审计 `requestId` 可与 `llm_usage_events` 对照，不记录正文。

`infra/docker-compose.radar-rescore.yml` 仅供独立 `compose run --no-deps` 维护容器使用，不能用于生产 API 的 `compose up`。`RADAR_RESCORE_DIR` 指向包含所挂载脚本及 `state/` 的目录，UID/GID 1000需有断点写权限；主 Compose 提供网络、数据库和凭据。`compose run` 的重启策略不能仅凭配置推定生效，实际运行后应核对容器策略。此配置不会自动运行补救或部署。

Reader 平台模式图片翻译与图示问答仅接收扩展从当前页面读取的 PNG/JPEG/WebP 图片字节，不接收远程 URL 供服务端抓取。默认复用 `UTILITY_LLM`，因此该路由必须支持图片输入；若部署提供独立视觉模型，可设置 `READING_VISION_LLM` 覆盖。定位不足时保留原图并以关联说明呈现译文，避免错误覆盖原图内容。

共享 LLM client 负责有限重试、fallback、endpoint 熔断和 token usage 审计。业务 worker 仍必须提供自己的确定性降级或可恢复状态，不能用空结果冒充成功。

Token 用量预算由 `LLM_TOKEN_BUDGET_USER_LIMIT`、`LLM_TOKEN_BUDGET_USER_PERIOD_DAYS` 和 `LLM_TOKEN_BUDGET_PLATFORM_DAILY_LIMIT` 配置，两个额度上限默认 `0`（关闭）。个人额度按滚动天数计算，平台额度按 UTC 自然日计算；输入和输出 token 均计入。启用额度时，长篇 Reader 整页问答/解释、研究助手全文改写/摘要/反方观点、事实核验的声明清单会在首个模型调用前按全部分块预留额度，结束后按实际 usage 结算；其他调用仍按单次模型调用预留。供应商不返回 usage 时按预留量结算，未完成的预留在 TTL 到期后回收。额度触顶时当前明确暂停新任务并返回额度错误，不做排队；账本或数据库不可用时失败关闭，返回服务不可用状态。

## 5. 认证与权限

- 默认开放邮箱密码注册/登录；`AUTH_BETA_MODE=1` 时，密码注册和 OAuth 首次开户都只接受 Admin 预先加入白名单的邮箱；
- `AUTH_EMAIL_VERIFICATION=1` 时，密码注册必须先通过 SMTP 邮件中的一次性验证码；已存在但无密码的账号（Admin 预创建或仅 OAuth）只能在验证通过后设置密码，验证关闭时 `/api/auth/register` 直接拒绝，避免任何人凭邮箱地址接管账号；验证码仅以 HMAC 形式持久化，并有过期、重发和尝试次数限制；
- OAuth 首次登录要求邮箱已验证（Google `email_verified`，GitHub 取已验证邮箱）；`Origin: null` 的写请求被 CSRF 检查拒绝；限流用的客户端 IP 只取 nginx 设置的 `x-real-ip`（设置 `TRUSTED_PROXY_HOPS` 才信任 XFF）；雷达 `refresh` 仅管理员，`migrate`/`transform` 需登录；
- Google 和 GitHub OAuth 可选，均不限制邮箱域；`AUTH_GOOGLE_ONLY=1` 是兼容旧部署的开关，仅保留 Google；
- `ALLOWED_EMAIL_DOMAINS` 和 `AUTH_INVITE_CODE` 仅供旧 `/api/auth/activate` 兼容接口使用，不参与公开注册或 OAuth；该接口只能给 Admin 预建、`users.oauthProviders` 为空的普通成员设密码，admin 或任何 OAuth 登录过的账号一律 403（OAuth 成功登录时写入 `oauthProviders`，迁移已对有头像或无密码 admin 的存量用户保守回填）；
- `shaobo.chen@shopee.com` 是默认 bootstrap Admin；
- Admin、成员和匿名访问由 Web BFF 服务端校验，前端隐藏不是权限边界；
- 生产密码登录必须使用 HTTPS。

## 6. 本地服务生命周期

日常开发使用：

```bash
pnpm dev:web    # http://localhost:3000
pnpm dev:ai     # http://localhost:4000
brew services start postgresql@16
```

如果使用 `infra/launchd/` 的 macOS 常驻模板，模板中的 `KeepAlive=true` 会在子进程退出后自动拉起服务。彻底停止本地常驻服务时，必须同时卸载 launchd job 和 PostgreSQL：

```bash
launchctl bootout gui/$(id -u)/com.deep-research.web
launchctl bootout gui/$(id -u)/com.deep-research.ai
brew services stop postgresql@16
```

这不会删除 plist、代码或数据库。以后恢复时按顺序启动：

```bash
brew services start postgresql@16

launchctl bootstrap gui/$(id -u) \
  "$HOME/Library/LaunchAgents/com.deep-research.ai.plist"
launchctl bootstrap gui/$(id -u) \
  "$HOME/Library/LaunchAgents/com.deep-research.web.plist"
```

检查服务：

```bash
launchctl list | rg 'com\.deep-research'
brew services list | rg 'postgresql@16'
lsof -nP -iTCP:3000 -sTCP:LISTEN
lsof -nP -iTCP:4000 -sTCP:LISTEN
lsof -nP -iTCP:5432 -sTCP:LISTEN
curl -fsS http://127.0.0.1:3000/api/healthz
curl -fsS http://127.0.0.1:4000/healthz
```

代码变更后，launchd Web 使用的是 `next start`，需要先重新构建：

```bash
pnpm --filter @deep-research/web build
```

## 7. 部署策略

### 新克隆 / 本地 Docker

```bash
./scripts/setup.sh --quick
pnpm db:deploy
pnpm db:generate
```

Web entrypoint 和 setup 都会幂等补齐默认雷达源，并引导 bootstrap Admin。默认源、认证、环境变量和脚本契约分别见：

- [`docs/contracts/env-and-scripts.md`](./contracts/env-and-scripts.md)
- [`apps/web/.env.example`](../apps/web/.env.example)
- [`packages/ai-engine/.env.example`](../packages/ai-engine/.env.example)

### GHCR + 固定 SHA + VPS

GitHub Actions 在 CI 通过后构建 Web 和 AI engine 的 Linux/amd64 镜像，推送不可变 commit SHA 标签；VPS 只拉取该 SHA，不在生产机重新构建。VPS `.env`、数据库卷、备份和日志不进入镜像。

发布后至少验证：

```bash
docker compose ps
curl -fsS https://<host>/healthz   # liveness
curl -fsS https://<host>/readyz    # readiness（web 经 prisma SELECT 1，2 秒超时，失败 503）
curl -fsS https://<host>/ai-healthz
```

健康检查不等于功能验收。雷达同步、评分、enrichment、内容审核、热点议题和真实 LLM 调研要按 [`FUNCTIONAL_CHECKLIST.md`](./FUNCTIONAL_CHECKLIST.md) 验证。

## 8. 文档入口

- [`ARCHITECTURE.md`](./ARCHITECTURE.md)：产品边界、数据模型、安全与部署架构。
- [`FUNCTIONAL_CHECKLIST.md`](./FUNCTIONAL_CHECKLIST.md)：功能验证路径与恢复场景。
- [`contracts/`](./contracts/README.md)：API、状态、错误、环境与指标契约。
- 架构决策与日期化验收记录保留在本地维护层，不随公开文档发布。
- [`infra/README.md`](../infra/README.md)：部署与运维操作。
