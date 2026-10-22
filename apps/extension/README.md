# Deep Research Reader

这是 Chrome Manifest V3 原网页阅读插件（Chrome 116+）。它按用户动作读取当前公开网页，在原文中插入正文和图片文字翻译，并围绕原文证据完成技术解读和追问。插件可完全独立安装：独立模式直接调用用户选择的模型服务，阅读会话和收藏默认保存在浏览器本地；可选的平台模式连接 Deep Research，使用平台模型，并把有界会话状态和用户确认保存的结论写入平台数据库。

独立模式的服务商选择器按云端、本机、自定义协议分组，包含品牌图标与中英文别名搜索。服务商预设仅提供连接参数，不代表所有模型均已通过验证；模型列表取自当前服务，模型回复需要单独测试。本地 API 指本机已运行的兼容服务，例如 CLIProxy，并非扩展内置模型。

## 聊天与阅读

聊天是主要入口，输入区只保留总结与翻译两个快捷动作，回答跟随提问语言；翻译默认使用界面语言，其他目标语言可以直接在聊天中提出。文章地图、机制和取舍可直接在聊天中提问，不再包装为独立工具。选中原文后，复制、标注和保存摘录直接出现在原文预览旁；选中图示后显示对应上下文，解读与追问都在聊天中完成。翻译开始后才展示任务卡，提供暂停/继续、取消、恢复原文及可展开的进度；失败项自动展开并可单独重试。收藏只展示明确确认保存的摘录、结论和标注，自动阅读会话只在聊天与历史展示。重开侧栏默认进入聊天；同一文章的多轮聊天在正文版本变化后仍会保留，旧版本引用会撤销定位。原文继续在网页阅读，证据链接只滚动和高亮原文。切换某段原文/译文时有整段描边与轻底色，移开鼠标仍保留定位，点其他区域或按 Esc 清除。流式回答与完成后的回答使用同一 Markdown 渲染器及字号规范。

聊天与历史使用同一套紧凑导航和正文排版。回答正文、必要背景和 AI 推断统一使用 15px/1.8；默认展示回答正文和蓝色原文证据；背景、推断和未知项收进默认折叠的“补充说明”，只列出实际存在的内容，展开后使用绿/紫/琥珀色标题与浅底色区分。正文保持深色，明确的错误或证据不足提示直接显示。鼠标点击输入框只轻微改变中性边线；键盘 Tab 导航保留单层焦点提示。独立模式在输入区右上角显示当前模型，点击可自动读取当前连接的模型列表，搜索并切换；切换保存到本机，作用于下一问，进行中回答保持原模型。列表不可用时保留当前模型，并提供刷新与连接设置入口。平台模式只显示固定的“平台模型”，不提供下拉或切换；选段出现后可以切换整篇/选段范围；选段模式在输入框上方直接预览原文，默认两行（矮窗口一行），可展开阅读、复制或清除；“复制选段”复制当前原文，成功后显示“已复制”。长问题会自动撑高输入框，也可拖动上沿或用方向键调整高度；⌘/Ctrl+Enter 发送，Enter 换行。草稿在同一侧栏进入历史再返回时保留，不承诺浏览器关闭后的草稿持久化。聊天视觉交互参考 [Open WebUI 官方聊天界面](https://docs.openwebui.com/features/chat-conversations/chat-features/)，并按浏览器侧栏宽度收敛。

问答由扩展后台执行，固定使用发起时的正文、选段和聊天上下文。重新选段、翻译、打开设置、切换标签或关闭侧栏不会取消回答；结果写回对应文章版本的本地会话。重新打开会接回正在执行的任务，只有“停止回答”会主动取消。浏览器退出或强制停止 Service Worker 无法继续推理，会显示中断并保留问题；不会自动重发计费请求。

可放进模型上下文的普通长文直接完整发送并流式回答；独立模式超过 64,000 字符、平台模式超过 `READER_ANSWER_DIRECT_TOKENS`（默认 48,000 估算 token）时才分块，最多并行核对 3 块，再按原文顺序汇总，继续验证逐字证据。

长文先发送最多 4 段、约 600 字符的小首批（单个超长片段仍保留完整分片），随后以最多 24 段、约 3,000 字符为一批（平台与独立模式一致），带上文章标题、开头、章节标题和相邻段落（仅作语境，不是翻译目标），批间不另做串行“预总结”。独立模式默认最多 4 个模型请求、平台模式最多 3 个浏览器请求并行，完成后逐段显示。结构有效但缺段的批次保留已确认译文，只补译缺失、空白、重复 ID 或异常回复；截断或无法解析的批次仍逐段重试。独立模式的补译与正常批次共用有界队列，避免串行等待或放大并发。独立 MiniMax M3.1 正文翻译使用与平台相同的 low 推理档位，其他模型保持原参数。缓存按批次读写、每批清理一次，最多保留 500 条；缓存包含目标语言与语境，避免跨语言或跨上下文复用旧译文。GitHub 仓库优先读取 README 正文，文件列表和仓库活动不进入正文翻译队列，也不会因时间戳变化清除 README 译文。正文进度只统计网页已确认应用的译文，代码块保留原文并单独排除；节点消失或原文变化会列为待重试，处理请求数不代表显示完成数。这改善跨段指代与术语一致性，仍不能保证模型完全消除长距离歧义。

鼠标停在已翻译的段落或使用 Tab 聚焦后，段落旁显示“查看这一段原文 / 译文”按钮；右键菜单同样显示对应操作，切回原文后可再次切回译文。也可按 **Alt+Shift+O** 或 Alt+单击切换。单段操作保留原文和缓存，不发模型请求、不改正文版本；“恢复原文”则清除整页翻译覆盖。

模型配置交互参考 [Open WebUI 的连接与模型发现](https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/starting-with-openai-compatible/) 和 [LM Studio 默认可无认证的本地服务](https://lmstudio.ai/docs/python/getting-started/authentication)。Reader 的空 Key 规则仅适用于回环地址，云端仍要求 Key。


### 翻译性能验收

`pnpm e2e:full-page-translation` 验证长文、超长段落、表格及图片的实际应用覆盖。
`node e2e/translation-performance.mjs` 在独立 Chromium 和真实 IndexedDB 中使用固定延迟模型，分别测量首段、全文、缓存及异常批次恢复。可设置 `READER_COMPARE_REF=<baseline-sha>` 比较历史源码，`READER_PERF_ARTICLE_URL=<public-article-url>` 使用真实文章正文。输出是调度对比，不代表线上模型吞吐，也不评估译文质量。

## 本地加载

1. 在仓库根目录运行 `pnpm install`（首次准备依赖），再进入本目录运行 `npm run build`。
2. 打开 Chrome `chrome://extensions`，开启开发者模式，选择“加载已解压的扩展程序”，选中 `.output/chrome-mv3`，不要选源码目录。
3. 打开一篇公开技术文章，点击扩展图标。
4. 在侧栏“设置”选择运行模式：独立模式选择服务商，确认始终可编辑的 API 地址并填写所需 API Key，再点击“连接并获取模型”，在 Chrome 提示时允许该服务。已有站点权限时，修改配置会自动刷新列表；模型支持搜索，需显式选择。Local Proxy 默认 `http://127.0.0.1:8317/v1`、LM Studio 默认 `http://127.0.0.1:1234/v1`、Ollama 默认 `http://127.0.0.1:11434/v1`；localhost、127.0.0.1 和 ::1 回环地址的 Key 选填。服务没有模型列表时可手动指定模型 ID；认证失败不会被当作“不支持列表”。“保存配置”不调用模型，“测试连接”才发送一个有超时的短文本请求，图片能力在折叠项中按需检测。平台模式连接 Deep Research 后直接使用固定平台模型，不需要这些独立模式配置。
5. 输入区选择“整篇”后点击“翻译”。正文按块处理，图片会尝试识别文字：坐标可靠且译文能安全容纳时覆盖原文（图表纵向坐标轴使用纵向排版），坐标不足以安全覆盖时保留原图，并在对应文字外侧显示“原文 → 译文”的锚定旁译；完全无法定位时才显示整图旁侧说明。失败项会保留原因，可恢复原文后重试。
6. 设置页可选择简体中文、English 或跟随浏览器；选中正文后，总结、翻译与输入问题都使用当前选段，复制、标注和保存摘录位于原文预览卡。会话、收藏和有限翻译缓存使用 IndexedDB；“导出阅读数据”可导出本地 JSON，API Key 会被自动剔除；设置页可以清除全部本地会话、收藏、配置和缓存。
7. 点击顶部“历史”，可按页面查看聊天会话或收藏的知识结论，搜索历史问题，重命名、删除和分别导出；页面版本变化后旧会话会标记为旧版本，不会错误复用原文证据。

## 共享设计基础

Reader 的基础字体、间距、颜色与 MUI theme 来自 [`packages/design-system`](../../packages/design-system/README.md)。`components/reader-theme.tsx` 只保留紧凑侧栏和既有 DOM 控件的专属覆盖；不另维护基础 palette/typography。传统 DOM 的 `design-system/tokens.css` 与 `--reader-*` 别名由 `scripts/generate-design-system.mjs` 从同一共享 JSON 生成，content-script 同步脚本也读取共享源。

调整 token 后运行共享包的生成命令及 `node apps/extension/scripts/generate-design-system.mjs`，并检查 Web 与 Reader；不要手工修改生成 CSS。MUI spacing 基数为 8px，紧凑的 4/12/20px 使用共享命名间距或显式 token，不能沿用旧 4px 基数的数字 `sx`。

## 本地验收命令

- `npm run e2e:model-configuration`：独立浏览器验证生产权限门禁、空地址/Key、模型搜索、认证与超时错误、手动模型、请求取消、保存不推理及窄窗口；固定测试服务，不调用真实模型。
- `READER_LIVE_MODEL=<服务实际返回的模型 ID> npm run e2e:live-model-configuration`：显式调用本机 8317 服务，验证空 Key 的模型发现、保存和一次真实短回复；隔离测试副本预授予本机权限，不替代真实 Chrome 的授权弹窗验收。

- `npm run e2e:interaction-audit`：当前聊天侧栏的输入快捷键、空白禁发、收藏/标注防连点、导入导出、图片切换与大图、翻译暂停/取消/单项重试、历史搜索和草稿恢复；仅使用隔离服务与数据。
- `READER_LIVE_MODEL=<实际模型 ID> npm run e2e:live-reading-audit`：打开 MDN 英文文章，用本机 8317 服务执行一次选段问答和选段翻译，检查原文保留、译文可选中及历史回读；显式调用真实模型，不使用用户浏览器数据。

- `npm test`：Reader core 与本地存储边界测试。
- `npm run e2e:smoke`：本地假模型、正文/图片覆盖、原图恢复和图示解读。
- `npm run e2e:worker`：侧栏关闭后 Worker 继续执行、重开恢复和页面版本失效。
- `npm run e2e:controls`：失败项可见、单项重试、暂停、取消、导出不含 API Key/临时输入，以及清除后导入收藏。
- `READER_HEADLESS=1 npm run e2e:conversation-history`：验证历史会话、选段和结构化证据恢复，并从同一侧栏继续聊天。
- `READER_HEADLESS=1 npm run e2e:visual`：在 320/360/420px 侧栏宽度检查独立设置、平台设置、技术文章选段和网页右侧入口，断言无横向溢出或按钮文字裁切，并将截图写入 `/private/tmp`。
- `READER_PLATFORM_E2E=1 READER_HEADLESS=1 npm run e2e:pkce`：验证可选平台模式的 PKCE、平台 SSE 技术问答、会话同步、知识保存、令牌撤销和本地清理。
- `READER_HEADLESS=1 npm run e2e:image-position`：在隔离页面验证可靠图表标签原位覆盖、纵向坐标轴排版，以及长标签原图旁译不与图片相交。
- `npm run e2e:dynamic-failure`：让首轮和动态页面快照中的同一正文项暂时失败，确认旧失败记录不会被新快照覆盖，随后验证单项重试可以清除它。
- `READER_E2E=1 npm run build:e2e && npm run e2e:worker-termination`：关闭整个 Chrome 持久化会话后，用同一 profile 启动新 Worker，在新标签页恢复未完成任务；验证临时输入不会丢失，终态会清理。
- `READER_E2E_MATRIX=1 npm run build:e2e && npm run e2e:matrix`：24 个隔离模拟页面、30 张模拟图片。

矩阵还会在全文翻译已经开始后动态插入一段正文，并断言该段自动进入翻译队列；页面版本变化时，扩展先移除旧覆盖，再重新提取和处理新增内容，不会把旧译文静默当作新页面证据。

全文翻译控件的语义是：暂停停止后续请求并保留已完成结果；取消停止任务但同样保留已完成结果；恢复原文才会移除页面上的译文和图片覆盖。失败项可以单独重试，动态页面更新会排队等待当前 Worker 任务结束，并合并既有失败记录。
- `READER_E2E_MATRIX=1 npm run build:e2e && npm run e2e:live`：只读访问真实公开文章、文档、GitHub 和 Zread 页面，记录结构兼容性与站点导航失败。
- `npm run e2e:live-image-corpus`：从上述真实公开技术页面收集最多 30 张已加载栅格图片的 URL、尺寸和来源页，写入 `/private/tmp`，不保存正文或 Cookie；设置 `READER_IMAGE_INCLUDE_SVG=1` 可把 SVG 也纳入样本。
- `READER_IMAGE_CORPUS=/private/tmp/<corpus>.json READER_LIVE_BASE_URL=... READER_LIVE_VISION_MODEL=... READER_LIVE_API_KEY=... npm run e2e:live-image-benchmark`：对真实图片运行视觉翻译基准；报告区分原位覆盖、旁侧译文、模型明确判定的无可读文字图片和模型失败。只有 corpus 的 `expectedText` 标签或显式 `READER_IMAGE_NO_TEXT_IDS` 标注后，才计算含文字图片的成功率；未标注样本保持未知，不把装饰图或模型失败伪装成 OCR 成功。
- `READER_IMAGE_CORPUS=/private/tmp/<corpus>.json READER_LIVE_BASE_URL=... READER_LIVE_VISION_MODEL=... READER_LIVE_API_KEY=... READER_IMAGE_REVIEW_DIR=/private/tmp/reader-image-review npm run e2e:live-image-review`：在同一真实视觉请求上生成原图上的译文区域覆盖图和 `results.json`，供人工检查数字、箭头、坐标和遮挡；结果只写入 `/private/tmp`，不会进入仓库或普通日志。
- 可选的 corpus `difficulty`（例如 `simple`、`complex`、`decorative`）和 `reviewed: true` 会被带入 `summary.byDifficulty`，用于分别验收清晰图片和复杂图片；标签应来自人工查看原图，不能由模型结果反推。
- `READER_E2E=1 READER_E2E_LIVE_ORIGIN=https://model.example npm run build:e2e && READER_LIVE_BASE_URL=https://model.example/v1 READER_LIVE_MODEL=... READER_LIVE_VISION_MODEL=... READER_LIVE_API_KEY=... npm run e2e:live-provider`：使用用户明确配置的真实 OpenAI-compatible 服务验证正文、图片、图示解读和恢复原文；Key 只从进程环境读取，不写入报告。该命令没有配置真实服务时不会伪造通过。

上述浏览器 E2E 默认打开独立的 Chrome for Testing 窗口，方便人工观察。需要后台运行时，在任意命令前加 `READER_HEADLESS=1`；脚本仍会加载扩展、执行页面交互并输出 JSON 结果，不会弹出窗口。例如：`READER_HEADLESS=1 npm run e2e:smoke`。图片 corpus/benchmark/review 本来就使用 headless Chromium。

临时任务输入有界：正文最多 256,000 字符、正文块最多 160 个且单块最多 12,000 字符、图片最多 40 张、内嵌图片数据最多约 8 MB。超限图片保留公开 URL；没有 URL 的内嵌图片会显示明确失败，不会被标记为已翻译。

选段工具条支持键盘操作：`Alt+Shift+T` 翻译、`Alt+Shift+E` 解读、`Alt+Shift+Q` 追问、`Alt+Shift+S` 摘录；部分选段翻译会绑定精确 Range，在选区附近显示可选中、可复制的译文浮层，不替换原文。浮层支持放大/恢复、关闭和拖动右下角调整尺寸；长译文在浮层内滚动。译文浮层内聚焦时可按 `Esc` 关闭；图片放大层和选段工具条均可按 `Esc` 关闭，页面阅读位置保持不变。输入框、密码框和可编辑区域内不会拦截这些快捷键。

平台模式是可选增强，不是独立安装的前置条件。插件默认连接 `https://techradar.top`，无需填写平台地址。选中平台模式并连接后，技术问答、总结和选段操作走平台 `/api/reading/answer/stream`，全文翻译走 `/api/reading/translate`；用户发起操作时，当前 URL、标题、选段或有界正文会按该操作需要发送给平台。聊天会话可同步 URL、标题、页面版本、选区、讨论、当前回答和滚动位置；用户确认保存的摘录、笔记、AI 结论和来源写入研究库。全文翻译也支持平台视觉模型：用户发起翻译时浏览器按需读取并上传图片字节，服务端不抓取图片 URL；围绕图片的问答暂不支持。图片字节、全文翻译缓存和 API Key 不进入平台数据库。`npm run e2e:pkce` 默认只输出跳过说明；设置 `READER_PLATFORM_E2E=1` 才运行平台集成验收。

生产环境必须在 Web 服务设置 `READING_EXTENSION_IDS`（逗号分隔的 Chrome 扩展 ID）来限制授权回调来源。Beta `0.2.3+` 内置固定公钥，手动加载和跨机器安装的扩展 ID 统一为
`doopmkblckigfncakbfcbeajoamgmkmg`；本地开发未设置时允许临时加载的 `chrome-extension://` 回调页。令牌只在扩展本地存储，PKCE verifier 只在浏览器 session storage 中短暂存在，并可通过禁用账号立即失效。

模型服务和跨域图片地址通过可选 host permission 按需申请。OpenAI、Anthropic、MiniMax、DeepSeek 预置了服务地址；自定义服务可以选择 OpenAI-compatible `/chat/completions` 或 Anthropic-compatible `/messages`，并允许来自扩展页的 CORS 请求。Anthropic 使用 `/messages`、`x-api-key` 和 `anthropic-version`，并发送浏览器直连标记；Anthropic 图片请求会先转换成 base64，无法读取图片字节时明确失败，不会把 OpenAI 的 `image_url` 结构直接发给 Anthropic。扩展会在获得图片站点权限后尝试把图片读取为数据 URL，再发送给所选模型。

## 权限与边界

`tabs` 仅用于识别当前标签页的 URL、标题和窗口，不用于读取网页正文。侧栏直接打开普通 HTTP(S) 页面时，用户点击“启用此站点”后才会申请该站点的可选内容权限。

插件采用两级启动。第一级是用户点击扩展按钮：它打开原生侧栏，并只用 `activeTab` 注入当前标签页。第二级只在这个窗口已经进入阅读模式后生效：用户切换到新网页时，插件会先尝试复用已有站点权限；没有权限时在侧栏显示“启用此站点”，只有用户点击后才申请该站点权限和读取正文。Chrome 内置页、扩展商店等受保护页面会明确提示不支持。插件不会默认申请或读取所有网站。正文提取排除表单、密码和可编辑区域。API Key 只保存在扩展本地存储，不进入网页、日志或导出数据；模型请求会把用户主动开启阅读的正文或图片发送到用户配置的服务。

Reader 是 Chrome Manifest V3 扩展，使用 WXT、React 和 TypeScript。独立模式的长时间翻译任务由 MV3 service worker 执行，侧栏关闭后仍会继续；重新打开侧栏时可从本地任务状态和翻译缓存接管。平台模式按批保存已完成正文译文；暂停或取消后继续时复用缓存。进行中的任务输入保存在独立的临时 IndexedDB store，任务结束或取消后清除，不进入导出包。正文识别包含通用规则以及 GitHub/Zread 的容器适配。

隐私、兼容性和安装说明见 [PRIVACY.md](./PRIVACY.md)、[COMPATIBILITY.md](./COMPATIBILITY.md)、[BETA_CHECKLIST.md](./BETA_CHECKLIST.md) 和 [BETA_TRIAL_REPORT.md](./BETA_TRIAL_REPORT.md)。

## 构建与发布产物

- `npm run typecheck`：检查 WXT entrypoint、React 入口和扩展声明。
- `npm run build`：生成可加载目录 `.output/chrome-mv3`。
- `npm run package`：生成 Chrome ZIP `.output/deep-researchreader-extension-<version>-chrome.zip`，用于商店上传或分发给测试用户。
- `npm run package:beta`：把已生成的 `.output/chrome-mv3`、安装说明、隐私边界和兼容矩阵打成 `.output/deep-research-reader-beta-<version>.zip`；这是给个人和小团队解压后加载的独立试用包。
- `npm run package:store`：构建并检查普通生产包，生成独立的 Chrome Web Store ZIP 和 SHA-256 报告；保留默认 Beta 公钥，只在商店上传副本中移除它。材料与账号操作见 商店发布指南（本地维护文件 `../../docs/chrome-web-store/README.md`）。打包只验证本地发布产物，不会修改后台条目、来源白名单或商店发布状态。

隐私政策内容源是 `privacy-policy.json`。构建时生成扩展内离线 `privacy.html` 和本目录 `PRIVACY.md`；公开页面 `/reading/privacy` 使用同一份内容。设置中提供离线隐私与公开使用支持入口。

Beta 白名单分发由仓库的 Deploy 工作流统一发布：CI 成功后，工作流构建并校验 ZIP，
创建不可覆盖的 `reader-v<version>` GitHub Pre-release，再把下载 URL、版本和 SHA-256
写入 VPS `.env` 的 `READING_EXTENSION_BETA_*` 配置，最后部署并做健康检查。发布新扩展时，
必须同步提升 `package.json`、`manifest.json` 和 WXT manifest 的版本；扩展源码变更但未升版
会让工作流失败。已有版本不会被覆盖，修订必须使用新版本号。

用户从平台点击“打开原文”：已安装 Reader 时打开原文并唤起原生侧栏；未安装或无法唤起时直接进入 [Chrome Web Store](https://chromewebstore.google.com/detail/bldpmkepljipbadeegednfinnilgoedl)。旧 `/reading/install` 链接保留为商店跳转，不再展示 ZIP 下载引导。`package:beta` 和受保护的旧下载 API 仅保留为维护／兼容能力，不作为正常安装入口。

WXT 会在构建时生成 Manifest V3 的 service worker、content script、side panel 和授权回调页。源码目录中的静态 Alpha 文件只作为迁移兼容层同步进构建，不应直接作为发布包加载。

## Content script 端到端夹具

`e2e/fixture.html` 是不依赖数据库和模型服务的浏览器验证页。需要验证“扩展按钮 → 注入 → 选段 → 侧栏”时，在另一个终端运行：

```bash
python3 -m http.server 8765 --directory e2e
```

然后访问 `http://localhost:8765/fixture.html`，在 `chrome://extensions` 加载 `.output/chrome-mv3`，点击 Reader 扩展按钮并授权当前站点。页面会显示选段工具条，侧栏会显示当前 URL 和选段；未配置模型时不会发起 AI 请求。

图片链路有一个可重复的隔离 smoke test。它会启动/连接本地 Fake OpenAI 兼容服务，验证 SVG 图片的 OCR 区域覆盖、原图切换、放大、图示解读和恢复原文；测试构建只给 `127.0.0.1` 固定 host permission，不改变普通构建的最小权限：

```bash
npm run build:e2e
node e2e/fake-openai.mjs   # 另一个终端保持运行
npm run e2e:smoke
```

`e2e:smoke` 会自动在 `127.0.0.1:8765` 托管 `e2e/fixture.html`；如果设置 `READER_E2E_URL`，则使用外部测试页面而不启动该 fixture 服务。

自动化 smoke test 直接打开扩展侧栏文档；工具栏手势交互应在 Chrome for Testing 中验证。

当前 Beta 的处理边界：`pre`/代码块会保留原样，不会作为翻译请求发送；正文中的大型内嵌 SVG 会和静态图片一起进入图片翻译队列。一次全文任务最多处理 40 张候选图片，超过上限会在进度提示中明确显示。图片覆盖会按实际显示缩放，覆盖后的图片提供“原图”切换和“放大”查看；视觉模型取消、网络失败和无法读取的图片会显示为可逐项重试失败。图片定位置信度低于 `0.75` 时绝不原位覆盖：有 OCR 坐标就保留原图，并把带原文对应关系的译文放在图片真正的左/右外侧；视口两侧都没有足够空间时才放在图片外部下方并保留对应锚点；没有可用坐标才显示整图旁侧说明。高置信度且译文能容纳的图表轴、图例和标签会直接覆盖原文，窄而高的轴标签使用纵向排版；视觉模型不可用时保留原图并继续正文翻译。GIF/APNG 等可能包含动画的图片默认不会被覆盖；失败项和图片控制条提供“标记当前帧”，用户确认当前帧后再重试全文翻译。解读和追问支持 OpenAI 兼容 SSE 增量输出；不支持流式的服务会回退到普通 JSON 响应。连续追问会把最近一组问答保存在当前页面的本地阅读会话中，重启侧栏后可以继续。

Service worker 持久化链路可用以下命令验收。它会关闭正在翻译的侧栏，确认任务继续、图片和正文结果仍能应用，再重新打开侧栏确认缓存结果可接管：

```bash
npm run build:e2e
npm run e2e:worker
```

兼容性矩阵会在隔离的本地页面中模拟 6 篇技术文章、6 个官方文档、6 个 GitHub README 和 6 个 Zread 小节，并放入 30 张架构图，检查正文/图片翻译、动态内容、链接、代码和恢复原文：

```bash
READER_E2E_MATRIX=1 npm run build:e2e
npm run e2e:matrix
```

阅读台使用 Chrome 原生侧栏，顶部入口为聊天、收藏、历史和设置。工具合并进聊天输入区，提示可单独收起。

原网页承担阅读，侧栏承担聊天，不再提供独立宽窗口或复制正文阅读区。侧栏宽度通过 Chrome 的侧栏分隔线调整；输入区上缘可上下拖动，也可聚焦分隔线后用方向键调整，尺寸保存在本机。

在原网页选中文本后点击“问 AI”，侧栏显示可展开的选段卡片；清除选段后明确恢复“基于整篇文章”，更换选段不会清空已有对话。每条证据的“在网页中定位”和带锚点的引用会滚动、高亮原网页对应段落，聊天保持可见。若段落已切为译文，则高亮对应的可见译文。输入区的“翻译”在原网页按段显示译文，可恢复原文。导航切换保留输入草稿。

已同步收藏的编辑使用 `PUT /api/reading/save` 更新本人对应的 knowledge 草稿。平台端必须支持对应的更新接口；仅收到 POST 去重响应不能视为编辑同步成功。

翻译目标语言可在聊天输入区的“翻译”旁选择，并保存在本地设置中；默认跟随界面语言。界面目前为简体中文和英文，目标语言另支持繁体中文、日语、韩语、法语、德语、西班牙语、葡萄牙语、意大利语、俄语和阿拉伯语。问答仍按用户提问语言回答。
