# Deep Research Reader

这是 Chrome Manifest V3 原网页阅读插件（Chrome 116+）。它按用户动作读取当前公开网页，在原文中插入正文和图片文字翻译，并围绕原文证据完成技术解读和追问。插件可完全独立安装：独立模式直接调用用户选择的模型服务，阅读会话和收藏默认保存在浏览器本地；可选的平台模式连接 Deep Research，使用平台模型，并把有界会话状态和用户确认保存的结论写入平台数据库。

## 聊天与阅读

聊天是主要入口，输入区包含总结、翻译和“工具”菜单（文章地图、关键机制、取舍、标注与保存）。收藏和历史保持独立入口。原文继续在网页阅读，证据链接只滚动和高亮原文。

聊天与历史使用同一套紧凑导航和正文排版。回答正文、必要背景和 AI 推断统一使用 15px/1.8；默认展示回答正文和蓝色原文证据；背景、推断和未知项收进默认折叠的“补充说明”，只列出实际存在的内容，展开后使用绿/紫/琥珀色标题与浅底色区分。正文保持深色，明确的错误或证据不足提示直接显示。鼠标点击输入框只轻微改变中性边线；键盘 Tab 导航保留单层焦点提示。独立模式在输入区右上角显示当前模型，点击可自动读取当前连接的模型列表，搜索并切换；切换保存到本机，作用于下一问，进行中回答保持原模型。列表不可用时保留当前模型，并提供刷新与连接设置入口。平台模式只显示固定的“平台模型”，不提供下拉或切换；选段出现后可以切换整篇/选段范围；选段模式在输入框上方直接预览原文，默认两行（矮窗口一行），可展开阅读、复制或清除；“复制选段”复制当前原文，成功后显示“已复制”。长问题会自动撑高输入框，也可拖动上沿或用方向键调整高度；⌘/Ctrl+Enter 发送，Enter 换行。草稿在同一侧栏进入历史再返回时保留，不承诺浏览器关闭后的草稿持久化。聊天视觉交互参考 [Open WebUI 官方聊天界面](https://docs.openwebui.com/features/chat-conversations/chat-features/)，并按浏览器侧栏宽度收敛。

问答由扩展后台执行，固定使用发起时的正文、选段和聊天上下文。重新选段、翻译、打开设置、切换标签或关闭侧栏不会取消回答；结果写回对应文章版本的本地会话。重新打开会接回正在执行的任务，只有“停止回答”会主动取消。浏览器退出或强制停止 Service Worker 无法继续推理，会显示中断并保留问题；不会自动重发计费请求。

可放进模型上下文的普通长文直接完整发送并流式回答；独立模式超过 64,000 字符、平台模式超过 `READER_ANSWER_DIRECT_TOKENS`（默认 48,000 估算 token）时才分块，最多并行核对 3 块，再按原文顺序汇总，继续验证逐字证据。

翻译以最多约 3,000 字符为一批，带上文章标题、开头、章节标题和相邻段落（仅作语境，不是翻译目标），批间不另做串行“预总结”。独立模式最多 4 批、平台模式最多 3 批并行，完成后逐段显示。缓存包含语境，避免同一段在不同上下文复用旧译文。这改善跨段指代与术语一致性，仍不能保证模型完全消除长距离歧义。

鼠标停在已翻译的段落或使用 Tab 聚焦后，段落旁显示“查看这一段原文 / 译文”按钮；右键菜单同样显示对应操作，切回原文后可再次切回译文。也可按 **Alt+Shift+O** 或 Alt+单击切换。单段操作保留原文和缓存，不发模型请求、不改正文版本；“恢复原文”则清除整页翻译覆盖。

模型配置交互参考 [Open WebUI 的连接与模型发现](https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/starting-with-openai-compatible/) 和 [LM Studio 默认可无认证的本地服务](https://lmstudio.ai/docs/python/getting-started/authentication)。Reader 的空 Key 规则仅适用于回环地址，云端仍要求 Key。

## 本地加载

1. 在仓库根目录运行 `pnpm install`（首次准备依赖），再进入本目录运行 `npm run build`。
2. 打开 Chrome `chrome://extensions`，开启开发者模式，选择“加载已解压的扩展程序”，选中 `.output/chrome-mv3`，不要选源码目录。
3. 打开一篇公开技术文章，点击扩展图标。
4. 在侧栏“设置”选择运行模式：独立模式选择服务商或 Local Proxy，填写服务地址与所需的 API Key 后自动读取模型列表；localhost、127.0.0.1 和 ::1 本地服务的 Key 选填。模型列表不可用时可展开自定义模型 ID。快速连接验证只发送一个短文本请求，图片能力按需检测；平台模式连接 Deep Research 后直接使用平台 AI Engine，不需要本地模型配置。两种模式各自只显示当前模式所需的连接配置。
5. 点击“全文翻译”。正文按块处理，图片会尝试识别文字：坐标可靠且译文能安全容纳时覆盖原文（图表纵向坐标轴使用纵向排版），坐标不足以安全覆盖时保留原图，并在对应文字外侧显示“原文 → 译文”的锚定旁译；完全无法定位时才显示整图旁侧说明。失败项会保留原因，可恢复原文后重试。
6. 在当前页面“全文翻译”旁选择目标语言，再点击全文翻译；选择正文使用“解读 / 追问 / 收藏”。会话、收藏和有限翻译缓存使用 IndexedDB；“导出阅读数据”可导出本地 JSON，API Key 会被自动剔除；设置页可以清除全部本地会话、收藏、配置和缓存。
7. 点击顶部“历史”，可按页面查看聊天会话或收藏的知识结论，搜索历史问题，重命名、删除和分别导出；页面版本变化后旧会话会标记为旧版本，不会错误复用原文证据。

## 本地验收命令

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

这是一个可直接加载的独立 Beta，便于小团队试用并验证全文翻译、图片文字覆盖、技术讨论和本地知识积累。当前构建使用 WXT + React + TypeScript；独立模式的长时间翻译任务由 MV3 service worker 执行，侧栏关闭后仍会继续，重新打开侧栏会根据本地 jobs 状态和翻译缓存重新接管。平台模式目前由侧栏执行，按批保存已完成正文译文；暂停/取消后继续会复用缓存，关闭侧栏后的任务延续尚未完成真实验收。进行中的任务输入放在独立的临时 IndexedDB store，任务结束或取消后清除，不进入导出包。正文识别包含通用规则以及 GitHub/Zread 的容器适配。

Beta 交付边界见 [PRIVACY.md](./PRIVACY.md)、[COMPATIBILITY.md](./COMPATIBILITY.md)、[BETA_CHECKLIST.md](./BETA_CHECKLIST.md) 和 [BETA_TRIAL_REPORT.md](./BETA_TRIAL_REPORT.md)。它们描述本地数据流、真实页面退化方式、个人/小团队安装路径和仍需真实参与者填写的对照试用；商店发布材料已准备，账号注册、商店版安装验收与审核仍待完成。

## 构建与发布产物

- `npm run typecheck`：检查 WXT entrypoint、React 入口和扩展声明。
- `npm run build`：生成可加载目录 `.output/chrome-mv3`。
- `npm run package`：生成 Chrome ZIP `.output/deep-researchreader-extension-<version>-chrome.zip`，用于商店上传或分发给测试用户。
- `npm run package:beta`：把已生成的 `.output/chrome-mv3`、安装说明、隐私边界和兼容矩阵打成 `.output/deep-research-reader-beta-<version>.zip`；这是给个人和小团队解压后加载的独立试用包。
- `npm run package:store`：构建并检查普通生产包，生成独立的 Chrome Web Store ZIP 和 SHA-256 报告；保留默认 Beta 公钥，只在商店上传副本中移除它。材料与账号操作见 [商店发布指南](../../docs/chrome-web-store/README.md)。商店发布尚需开发者注册、上传草稿取得 Item ID、平台来源白名单、审核凭据和提交审核。

隐私政策内容源是 `privacy-policy.json`。构建时生成扩展内离线 `privacy.html` 和本目录 `PRIVACY.md`；公开页面 `/reading/privacy` 使用同一份内容。设置中提供离线隐私与公开使用支持入口。

Beta 白名单分发由仓库的 Deploy 工作流统一发布：CI 成功后，工作流构建并校验 ZIP，
创建不可覆盖的 `reader-v<version>` GitHub Pre-release，再把下载 URL、版本和 SHA-256
写入 VPS `.env` 的 `READING_EXTENSION_BETA_*` 配置，最后部署并做健康检查。发布新扩展时，
必须同步提升 `package.json`、`manifest.json` 和 WXT manifest 的版本；扩展源码变更但未升版
会让工作流失败。已有版本不会被覆盖，修订必须使用新版本号。

用户统一访问调研平台的 `/reading/install` 页面，登录后由
`/api/reading/extension/download` 受保护地代理下载；不要把本机
`apps/extension/.output` 路径当成用户地址。`npm run package:beta` 仍可在本地生成 ZIP，
用于安装前检查，但不替代工作流中的 Release 发布和平台配置更新。

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

自动化环境无法伪造 Chrome 工具栏用户手势，因此 smoke test 直接打开扩展侧栏文档；“工具栏按钮 → 原生侧栏”仍需用 Chrome for Testing 的交互验收路径验证。

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

在原网页选中文本后点击“问 AI”，侧栏显示可展开的选段卡片；清除选段后明确恢复“基于整篇文章”，更换选段不会清空已有对话。聊天里的“定位原文”和带锚点的引用会滚动、高亮原网页对应段落，聊天保持可见。若段落已切为译文，则高亮对应的可见译文。输入区的“翻译”在原网页按段显示译文，可恢复原文。导航切换保留输入草稿。

已同步收藏的编辑使用 `PUT /api/reading/save` 更新本人对应的 knowledge 草稿。旧平台未部署更新接口时，插件会提示本地修改已保存、云端尚未更新；仅收到 POST 去重响应不能视为编辑同步成功。
