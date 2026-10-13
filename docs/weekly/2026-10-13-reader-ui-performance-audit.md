# Reader 0.2.9 UI 与任务性能验收（2026-10-13）

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

用户后续指出选段缺少复制入口，已在回答范围旁增加“复制选段”，独立Chromium和专门回归验证复制原文而非AI回答。首个0.2.10提交的CI在发布前取消，最终包包含此补齐；复制按钮原生复验待官方包加载。
