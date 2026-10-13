# Reader 0.2.9–0.2.13 UI 与任务性能验收（2026-10-13）

## 本轮范围

聊天与工具合并；选段和 Chrome 右键菜单简化；自动模型发现与回环地址可无 Key；短文本快速验证；翻译附邻段语境和逐段原文切换；后台持久问答与全文流式响应。无数据库迁移。

## 修复前复现

真实 Chrome 在 Claude 的 The AI-native SDLC playbook（362 块、58,197 字符）发起整页问题，在第 37 秒的观察点看到平台失败，请求编号 `4f950a2d-b020-4521-ac3c-f0aab0f43c05`。该数字是观察上界，不能作为精确完成耗时。代码确认选段事件会 abort 当前问答，长文逐块串行分析、最后阻塞汇总；连接验证还强制等待图片能力测试。

## 实现和边界

- 顶部仅保留聊天、收藏、历史、设置。总结/翻译在输入区，“更多”容纳次要动作；原文证据回到网页定位。修复菜单被选段卡片遮挡。
- 模型列表自动读取 `/models`，兼容 OpenAI 和 Anthropic 分页。回环地址 Key 选填、空 Key 不发送 Authorization。没有列表的服务保留折叠手动 ID；实机 cc-switch 的 `/v1/models` 返回空数组，不能声明该代理自动发现成功。
- 验证连接只发一个短文本请求，12 秒截止；图片能力按需单独检测。失败不替换已有工作配置。
- 问答在后台运行，固定请求时原文与历史。选段、翻译、设置、切换标签和关闭侧栏不主动取消；完成写回相应文章版本。只有停止按钮主动取消。浏览器退出或强制结束 worker 后显示中断、不自动重新计费。
- 普通常文完整流式发送；超过独立模式 64,000 字符或平台默认 48,000 估算 token 后，并行三块核对再汇总。保留全文及逐字证据检查。
- 翻译约 3,000 字符/批，并行显示完成段落；附标题、文章开头、章节和前后段落语境，语境进入缓存指纹。不能保证模型完全消除远距离歧义。
- 译文 hover/Tab 聚焦后 Alt+Shift+O，或 Alt+单击，仅切换这一段原文/译文，不请求模型。全文恢复还原原段落 display/title/tabindex。
- 真实右键首次打开侧栏发现历史恢复覆盖新选段范围；已保留实时选段并新增范围断言。

## 本地验证

- Node 94/94；扩展和 Web TypeScript、WXT production build、diff check 通过。
- Reading translate/answer/stream Vitest 14/14；Python research assistant 19/19；全量 Ruff 和 Mypy（103 源文件）通过。
- 隔离浏览器/受控兼容模型：连接验证一次文本请求；回答期间重新选段、全文翻译、关闭重开只发一次问答；逐段切换、关闭侧栏后选段动作恢复、显式停止通过。截图 `reader-audit-20261013/chat-controlled-final.png`。
- 全文翻译隔离浏览器：1,042/1,042 块，长段尾部、标题、目录、表格、图片锚定及恢复原文通过（56 请求）。这是受控服务完整性测试，不代表真实模型速度。
- 真实 Chrome 最终构建显示 0.2.9；英文 MDN 验证聊天合并布局、Local Proxy Key 选填和模型选择入口。真实平台问答在设置及关闭侧栏后完成并恢复，带可定位英文证据；因观察期间还执行其他操作，未把约 50 秒的观察上界作为模型延迟。

## 0.2.9 发布与真实后端复验

0.2.9 已于本日正式发布：[Reader release](https://github.com/csbpku/deep_research/releases/tag/reader-v0.2.9)，CI `38374325351`、Deploy `38374726519` 成功，生产 Web/AI Engine 为 `5846e9f8eec6ba42c605d0c261534674644c1c74` 且 healthy。官方 ZIP 213,043 bytes，SHA256 `35f3f198ff65ddb4f96ef0138573e7db7f5b1754cbe2b7efd79af102f78cc97b`；安装页元数据一致。

生产 MiniMax-M3 对公开 Claude SDLC 文章的直接流式调用：独立 bs4 正文提取 69,391 字符（不同于上面的原生提取），首个文本增量 8.237 秒、完整结果 17.096 秒，engine latency 16,476ms，streaming=true、truncated=false，3 条证据逐字匹配。仅为本次样本，不与修复前37秒观察上界计算加速比例。真实 MDN 翻译18/18块、1/1图片，Alt+Shift+O往返与右键首次选段范围恢复通过；图片可能使用缓存。

## 0.2.10 聊天和历史重设计

按用户指定 UI UX Pro Max / Web Design Engineer，研究 [Open WebUI 官方界面](https://docs.openwebui.com/features/chat-conversations/chat-features/) 与 [MessageInput 源码](https://github.com/open-webui/open-webui/blob/main/src/lib/components/chat/MessageInput.svelte)。单列侧栏使用48px共享导航、36px来源行、无外框回答、22px圆角输入框、集中总结/翻译/工具、模型设置入口和空白态建议。输入框自动随长草稿增高，保留拖动/键盘调高；历史统一同套字体和导航，次要记录操作折叠。历史往返草稿通过sessionStorage保留，不承诺浏览器关闭后的持久化。

真实生产模型在首次重设计验收中返回了answer字段包含未转义双引号的JSON，平台回退后整个JSON展示为代码。增加限定信封格式的正文恢复，并兼容旧本地会话；保留服务器验证后的证据，不改写存储、不绕过逐字证据检查。随后真实Chrome在聊天和历史中均恢复正文，新的MDN问题返回正常正文、1条完整英文可定位证据。背景/推断/限制中的引用也绑定到原文，避免跳到插件内部碎片URL；普通会话恢复与已完成翻译不再重复占用提示区，异常/旧版本提示保留。

最终本地门禁：Node96/96、WXT production build、扩展TypeScript和diff check通过。独立Chromium验收覆盖320×560、380×860、520×720、736×740，无横向溢出；聊天滚动区分别313、609、469、489px，选段模式composer155px，header48px。长输入自动增长/缩回、模型设置、More边界/Escape、历史搜索/详情/继续/设置/收藏导航、草稿返回、键盘调高、停止和后台任务恢复均通过。背景引用href已断言原文章URL；复制选段验证写入当前原文、成功反馈及整篇模式隐藏，320px范围标签不换行；问答期间选段、翻译、关闭重开仍只有1次问答请求，模型验证1次文本请求。受控服务不代表真实模型延迟。

真实Chrome已加载0.2.10（原解压目录和ID不变），英文MDN验证工具分组、输入高度76→157→76、历史46会话/1结论、详情正文修复、草稿保留、⌘+Enter实际平台回答及证据。原生宽度拖动尚未确认：控制前用户切回了工作窗口，未继续操作该窗口。生产0.2.10发布及官方包复验待追加。

设计约定见 [reader-conversation](../design/reader-conversation.md)。受控截图：[380px聊天](./reader-audit-20261013/chat-openwebui-380.png)、[320px聊天](./reader-audit-20261013/chat-openwebui-320.png)、[历史](./reader-audit-20261013/history-openwebui.png)；原生历史截图为 `reader-audit-20261013/history-openwebui-native.png`。

用户后续指出选段缺少复制入口，已在回答范围旁增加“复制选段”，独立Chromium和专门回归验证复制原文而非AI回答。首个0.2.10提交的CI在发布前取消；第二个提交CI `38384026157` 成功，但 Deploy `38384445685` 因第二次源码改动未再次升版被发布门禁拒绝，0.2.10没有正式发布。当前改为0.2.11，保留发布门禁。


## 0.2.11 段落切换、统一排版与结构辨识

用户继续指出回答字体不一致、分区难辨和输入框蓝色外框。共享回答排版与 Markdown 样式已应用到正文、背景、推断和历史；证据/背景/推断/未知项使用带文字标签的蓝/绿/紫/琥珀浅底色，保持正文深色。用户进一步指出四块冗余后，默认收敛为正文+原文证据，其他三项放入一个默认折叠的“补充说明”；明确警告直接显示。输入区去掉鼠标点击的外层蓝框，仅为 Tab 导航保留焦点提示。原文选段直接在输入框上方显示，默认两行，矮窗口一行，支持展开、复制与清除。

单段增加“查看这一段原文 / 译文”按钮和动态右键菜单；切换只读取已有译文，双向可逆，不开启聊天、不新建任务。content script 重注入可接管页面已有翻译；新增控件从正文提取和 MutationObserver 页面变化判定中排除。原页面 display/title/tabindex 保存用于恢复。

初次0.2.11验证：Node97/97、WXT build、扩展TypeScript通过；独立Chromium验证段落按钮双向切换不增加模型请求、原生contextMenus API动态改名、聊天/背景/历史computed字体字号行高一致。全文翻译重新验证1,042/1,042块、长段尾部、表格、标题、图片与全部恢复通过（56次受控请求），不代表真实模型延迟。用户后续分区颜色与选段预览的最终验收另行追加。

真实Chrome已在现有解压目录加载0.2.11，扩展ID不变。直接“复制选段”后粘贴到空测试输入框，得到完整MDN英文原段，随后清除测试草稿。原生侧栏resize slider的Decrement动作未改变截图宽度，不能视为调宽通过；待继续使用实际分隔线验证。该轮原生全文翻译操作因用户交互控制中止，未宣称通过。

最终增量验证通过：Node97/97、WXT production build、TypeScript、JS语法与diff检查；独立Chromium证明默认补充说明折叠且证据可见，展开后的4种语义标题/底色互异并与历史一致；鼠标焦点无外圈、Tab有焦点圈；输入区选段可见并能展开/收起，切整篇隐藏，复制原文。四尺寸无溢出，聊天区273/557/429/449px，选段composer195/207/195/195px，header48px。问答期间选段/翻译/关闭重开仍1次问答，短验证1次；停止和历史返回无重发。受控截图见reader-audit-20261013/reader-0.2.11-*；不作为真实模型速度证据。

独立模式右上角现在可直接发现/搜索/切换模型，失败保留当前模型，可刷新或进入连接设置；不额外串行验证，图片能力需按新模型重新按需检测。平台模式为固定标签，无箭头、无菜单、不能切模型。最终Chromium重跑验证切换后本机持久化，进行中请求保留local-test-chat，下一次请求使用local-test-chat-alt；平台模式禁用。其余结构、字体、预览、尺寸和任务保护回归仍通过。


## 0.2.11 发布与 0.2.12 原生菜单修复

0.2.11 已正式发布，CI `38389383219`、Deploy `38389801622` 成功；只读 SSH 确认生产提交为 `0bf982ab851dc8da0f81689106b60b5b04168f75`，Web/AI Engine healthy。官方资产 215,979 bytes、SHA256 `8c12ab43329481a1b4ff348a71a7a64f7fd29e1044440f52478c88cc4a817f7a`。该版本最终原生验收发现段落按钮/快捷键可逆，但动态右键入口会消失，不能把受控 API 改名断言当作原生菜单通过。

真实 Chrome 事件观察证实：在正确的 `P[data-deep-research-block="block-1"]` 打开右键菜单后，页面收到一次目标为 `ASIDE` 的 pointerover；旧处理把刚同步的菜单设为隐藏。0.2.12 在菜单打开时锁定点击段落的菜单状态，下一次明确页面操作解除锁定；右键按下时提前同步，contextmenu 强制重发，补上文本节点和键盘/辅助功能触发时的聚焦段落定位。恢复全文时强制清除菜单。没有新增权限、模型请求或数据库迁移。

0.2.12 本地 Node97/97、WXT production build、TypeScript、JS语法和diff检查通过。独立 Chromium 回归验证真实 contextMenus callback 无 runtime.lastError，并复现“contextmenu 后非段落 pointerover”，入口保持可见；后台消息能切回已有译文；双向切换不新增模型请求。字体/颜色、默认折叠、选段预览/复制、独立模型切换、平台固定模型、四尺寸无溢出、问答1请求、停止/历史/草稿恢复均通过。日志 `/private/tmp/reader-0.2.12-chat-20261013.log`，受控截图目录 `/private/tmp/reader-chat-workspace-dS6DKO/`。

真实 Chrome 已在同一解压目录和扩展 ID 重载0.2.12：右键“查看这一段译文”切回中文，再右键“查看这一段原文”恢复完整英文；菜单实际可见并执行，两次均不打开聊天。原生侧栏固定“平台模型”且 disabled；生产 MDN 问答返回正常 Markdown 正文、两条英文定位证据、默认折叠“补充说明”，展开后背景/推断/未知项有明确文字标签和语义底色。原文选段展开/收起以及复制粘贴回读已在0.2.11完成，同套功能在0.2.12受控回归继续通过。原生截图只留本机临时目录，不把带个人书签的原始截图发布到仓库。

原生侧栏宽度拖动仍未确认：AX slider Decrement/键盘动作没有改变宽度，坐标控制返回 windowNotFoundAtPosition；四尺寸布局适配通过，不等同于原生拖动验收。输入区高度此前真实76→157和受控键盘/拖动回归通过。此次不新增真实模型延迟基线，历史0.2.9耗时仅保留在对应发布条目。

0.2.12 提交 `a3dfea6754a12dac69f43cf96bfec63ea4e6d817`，CI `38392083518` 成功；[官方 Release](https://github.com/csbpku/deep_research/releases/tag/reader-v0.2.12) 的 ZIP 为216,325 bytes、SHA256 `8d62134d334fbfc86e7e19530c0c73aee49a768ff6a020132c9cd34e2670e9ad`。Deploy `38392487610` 成功；SSH确认VPS提交一致且Web/AI Engine healthy。官方ZIP已下载到新的临时目录，SHA256/manifest匹配，权限集合与现有插件一致，并覆盖到现有解压目录后重载，ID不变；后台独立浏览器安装页显示0.2.12与同一SHA256。会话和默认折叠结构恢复、平台模型禁用及右键实际往返通过，但官方包连续切换复验发现方向文字偶尔滞后，因此继续修复0.2.13。


## 0.2.13 右键方向文字同步

0.2.12官方包可双向切换，但在译文段落连续右键时可能仍显示“查看这一段译文”，实际动作却切回英文。后台原先对每次消息异步`tabs.get`，可能打乱原文/译文/不可用状态更新；不可用状态还把标题统一重置为查看译文。0.2.13改用Chrome消息sender携带的active tab状态立即按消息顺序更新，隐藏时只更新visible并保留最后方向；非激活标签和子frame仍不能改写当前段落菜单。

本地Node98/98、WXT production build、TypeScript、JS语法与diff通过。新增回归覆盖有序原文→隐藏→译文更新、隐藏不改方向，以及非激活tab/子frame隔离；独立Chromium聊天全套、实际contextMenus API成功、菜单锁定、双向缓存切换不新增请求、模型限制及四尺寸继续通过，日志`/private/tmp/reader-0.2.13-chat-20261013.log`、截图`/private/tmp/reader-chat-workspace-pfNx8x/`。没有重跑全文翻译1,042块或真实速度基线，历史数字保留在对应版本条目。

真实Chrome0.2.13同一ID连续验收：英文时“查看这一段译文”→中文，紧接着中文右键显示“查看这一段原文”→完整英文，文字与动作一致；侧栏平台模型仍disabled，会话和证据保留。提交`53d2335cb66eb5b9638ea6e1378ca39b74d8ee45`已推送，CI `38393933756`成功，Deploy `38394263445`成功。


0.2.13正式发布：[官方 Release](https://github.com/csbpku/deep_research/releases/tag/reader-v0.2.13)。ZIP216,322 bytes，SHA256 `66a8b6091ef4fc54ed65da500e08039a536081776eba54679763531bc2d63e99`，下载至新目录`/private/tmp/reader-0.2.13-official-Jq76jW`并校验manifest/权限集合后更新原解压目录；Chrome最终显示0.2.13且ID不变。只读SSH确认VPS `.deployed-image-tag` 为`53d2335cb66eb5b9638ea6e1378ca39b74d8ee45`，Web/AI Engine/Postgres/AnythingLLM healthy，nginx running。独立后台浏览器刷新[生产安装页](https://techradar.top/reading/install)，显示v0.2.13和同一SHA256；未使用私人工作窗口。

最终官方包真实Chrome复验：已有MDN会话正常恢复、两条原文证据和默认折叠补充说明保留、平台模型disabled；右键实际译文→原文往返成功，状态就绪后方向文字正确。重载后的首次冷启动菜单可能先显示通用“查看这一段原文 / 译文”，可正常切换，不再显示错误的反向文字。最终原生证据只保存本机：`/private/tmp/reader-0.2.13-official-native-menu-20261013.png`和`/private/tmp/reader-0.2.13-official-native-chat-20261013.png`。原生宽度拖动仍保留前述未验证边界；没有以受控四尺寸测试替代实机拖宽结论。
