# Store Listing 可粘贴内容

名称（与 manifest 一致）：Deep Research Reader

简介（与 manifest 一致）：独立的开发者 AI 阅读助手：全文、图片翻译、技术解读、追问和本地知识积累。

分类建议：Productivity（生产力）

语言：简体中文

支持 URL：https://techradar.top/reading/support

隐私政策 URL：https://techradar.top/reading/privacy

主页 URL：https://techradar.top/reading/install

分发：初次验收建议 Unlisted；正式公开后改为 Public。

## 详细介绍

Deep Research Reader 是在原网页中使用的 AI 阅读助手。阅读技术文章、文档和 GitHub README 时，在 Chrome 侧栏中翻译、提问并回到原文证据，减少在网页和聊天工具之间来回复制。

阅读和聊天放在一起：

• 在侧栏直接提问，或使用总结、翻译及工具菜单。
• 选中原文后，输入区显示选段预览，支持复制、清除和围绕选段追问。
• 回答中的原文证据可以定位到网页；背景、推断和未知项在补充说明中展开。
• 全文翻译逐段显示，带上相邻语境。单段原文与译文可通过段落按钮、右键或 Alt+Shift+O 双向切换。
• 保留代码块。具有图片能力的模型可以翻译正文图片文字；定位不可靠时保留图片并显示旁译。
• 本地保存聊天、标注、摘录和结论，支持历史检索以及数据导出、导入。

两种运行方式：

独立模式：使用你自己的模型服务，支持 OpenAI-compatible 和 Anthropic-compatible API。模型列表自动获取，也兼容未提供列表的服务。Local Proxy 的 localhost、127.0.0.1 和 ::1 地址允许不填 API Key。聊天与阅读成果默认保存在浏览器本地。

平台模式：可选连接 Deep Research，需要已有平台访问权限。授权后使用平台模型，并同步阅读会话与确认保存的结论。平台模式不能在插件里切换模型。

使用前请了解：

• 扩展免费安装，AI 功能需要可用模型服务或平台账号。模型供应商可能按调用量收费。
• 只有在你启用阅读并发起操作时，才把所需文章内容、图片和问题发送给所选模型服务或平台。API Key 不进入网页或数据导出。
• 图片能力、处理速度和回答质量取决于模型与服务。AI 回答仍需对照原文核对。
• Chrome 内置页和 Chrome Web Store 等受保护页面无法读取；正文尚未加载或特殊网页结构可能影响提取。
• 平台模式不是使用独立模式的前置条件，也不向所有商店用户自动开放平台账号。

使用与支持：https://techradar.top/reading/support
隐私政策：https://techradar.top/reading/privacy

