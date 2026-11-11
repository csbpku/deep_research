# Reader 独立模式模型请求

适用于浏览器直接请求模型的翻译、阅读问答与收藏问答。平台模式仍由服务端决定模型参数。图片逐张展示同时适用于两种模式。

## 推理强度

`apps/extension/model-policy.js` 维护明确核验过的型号能力，JSON 与流式请求使用同一个策略。默认“自动（优先速度）”；翻译使用快速档，回答可在设置的“用量”区域选择低、中、高或服务商默认。只有支持的参数才会被自动附加。

| 型号 | 自动 / 翻译 | 参数与兼容性 |
| --- | --- | --- |
| Grok 4.5、4.6、4.7 | `low` | `reasoning_effort`；不能关闭推理 |
| MiniMax M3.1 / M3.1-Flash | `low` | Chat Completions 用 `reasoning_effort`，Messages 用 `output_config.effort` |
| OpenAI o1、o3、o3-mini、o4-mini、GPT-5 / mini / nano | `low` | 用 `max_completion_tokens`，省略自定义 temperature |
| OpenAI GPT-5.1、5.2、5.4 | `none` | 简单任务保持非推理速度；回答可显式提高强度 |
| DeepSeek `deepseek-flash`、`deepseek-v4-pro` | `low` | 两种协议分别使用 `reasoning_effort` / `output_config.effort`；中档映射为 `high` |
| Gemini 2.5 Pro / Flash / Flash-Lite、3 Flash、3.1 Pro / Flash-Lite | `low` | OpenAI 兼容接口使用 `reasoning_effort`；中档保守映射为 `high` |
| 其他型号（包括原生 Claude、未知别名、pro-only 型号） | 保留原参数 | 不根据兼容协议猜测模型能力 |

精确匹配的稳定别名和部分日期快照见实现；不覆盖同前缀的未知变体。第三方网关可能有不同参数契约，不能仅凭模型名声称其后端已验证。增加适配时应核对该型号和协议的官方参数，并补充 JSON / SSE 请求契约验证。

适配依据（2026-11-11 核对）：

- [xAI reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning)
- [MiniMax OpenAI SDK](https://platform.minimax.io/docs/api-reference/text-openai-api)
- [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning)、[GPT-5.4](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.4)
- [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/)
- [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)

## 调度、取消和限流

`model-scheduler.js` 在同一运行上下文内按模型服务地址共用队列，不持久化 Key、正文或回答。MV3 后台的全文翻译与问答共享该队列；侧栏内的独立调用拥有自己的运行上下文，浏览器重启后不保留冷却计时。

- 每个地址最多 4 个在途请求，后台翻译最多 3 个，为交互留出一个位置；待处理的问答先于后台翻译取空位，不打断已发送的请求。
- 一个槽位覆盖完整 JSON / SSE 响应，不能在收到响应头时提前释放。取消排队任务不会向模型发送请求。
- HTTP 429 最多重试 2 次，重发原请求；同地址的后续调用共享冷却期。优先尊重 `Retry-After` 秒数或 HTTP 日期，没有该头时按 1 / 2 / 4 秒加随机抖动退避。超过 60 秒的服务端等待直接向用户报告，仍保留冷却期。
- 持续 429 或认证 / 模型访问错误停止本次翻译；HTTP 错误不再触发批量到逐段的回退。已经完成的译文缓存保留。无效或缺失的批量译文仍只补对应段落。
- 不自动重放网络异常或已经输出部分内容的流。用户取消后不重发，也不应用晚到的图片结果。

## 图片

每张图片完成后立即应用到原网页，不等待其他图片完成。保留图片串行与高清 OCR，避免加剧限流或降低小字识别覆盖。已适配的推理型号设置 12,000 token 输出上限；未知型号保留原有输出参数，Messages 路径原有默认仍为 4,096。达到输出上限仍视为不完整，不缓存为成功。

这些策略缩短不必要的推理与显示等待，不能保证特定模型的绝对耗时。上线性能结论需要同输入、同服务、同推理档位的实际测量；模拟服务验收只证明调度和参数行为。
