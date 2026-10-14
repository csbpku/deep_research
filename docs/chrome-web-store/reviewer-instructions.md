# Private Test instructions draft

**Not ready to submit until the credentials below are completed and tested.** Put the filled credentials only into the Chrome Web Store Developer Dashboard private testing fields. Never commit API keys, account passwords or authorization tokens to this document or public listing.

## Credentials required before submission

- Standalone provider Base URL: **[PUBLISHER TO SUPPLY]**
- Protocol: OpenAI-compatible Chat Completions or Anthropic-compatible Messages.
- Reviewer API Key: **[PUBLISHER TO SUPPLY; dedicated, limited quota, valid throughout review]**
- Model ID: **[PUBLISHER TO SUPPLY; available via /models where supported]**
- Optional platform mode: **[PUBLISHER TO SUPPLY a usable review login/access procedure]**. Production uses an account allowlist. Do not ask reviewers to register or pay for a model account just to test the feature.

## Main purpose and setup

Deep Research Reader is a Chinese-language in-page AI reading assistant. The standalone mode works independently of the Deep Research platform. The platform mode is optional and requires an authorized account. The extension is free to install; external model services may charge the end user for usage. All JavaScript is bundled locally; API outputs are data, not executable code.

1. Install the submitted package. Open a public English article, for example https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Introduction . Click the extension action to open the native side panel and enable reading of that page.
2. Click 设置 (Settings). Keep 独立模式 (Standalone). Select the provider and enter the review endpoint and Key supplied in the private credential fields. The model list is discovered automatically. If the endpoint does not expose /models, expand 服务未提供模型列表？ and enter the provided model ID.
3. Click 保存并快速验证 (Save and quickly validate). Approve access to the specific provider origin if Chrome prompts. Expect 连接成功 (Connection successful). Return with 返回聊天 (Back to chat).

## Reading, translation and source evidence

4. Ask “这篇文章的核心观点是什么？” (What are the key ideas of this article?). Expect a streamed answer in the conversation. Select a sentence on the article and ask “解释这段” (Explain this passage). The composer shows the original selection and allows copying/clearing it.
5. When source evidence is returned, click 定位原文 (Locate original) to scroll/highlight its exact passage. Background, inference and limitations can be expanded under 补充说明 (Additional details).
6. Click 翻译 (Translate) in the composer. Text appears progressively on the source page. Hover a translated paragraph, use its original/translation button or the right-click toggle, then switch both ways. Alt+Shift+O also toggles the current paragraph. This does not send another model request. 恢复原文 (Restore original) removes the whole-page overlay. Code blocks remain original.
7. Text-only models cannot translate images; the extension reports the affected item and preserves the image. With the supplied vision-capable model, image translations use an overlay only when positioning is reliable, otherwise show adjacent text. Platform mode currently does not support image questions.
8. During an answer, select another passage or close/reopen the side panel. An existing answer is owned by the background worker and is not cancelled by those actions. 停止回答 (Stop answer) explicitly cancels. Browser exit or forced service-worker termination can interrupt the request.

## Local data and privacy

9. 保存结论 (Save conclusion) lets the user review/edit their excerpt, note and AI conclusion before saving. 收藏 (Saved) and 历史 (History) show local records.
10. In settings, 导出阅读数据 (Export reading data) exports local reading records without API keys, temporary task inputs or translation caches. 清除翻译缓存 (Clear translation cache) clears cache; 清除本地数据 (Clear local data) requests confirmation then clears local reading records/configuration. These do not delete previously synced platform data.
11. 隐私政策 (Privacy policy) opens the packaged offline policy. Public policy and support pages are available without login at https://techradar.top/reading/privacy and https://techradar.top/reading/support .

## Optional platform mode

12. The publisher must first allowlist the Store Item ID on the production platform. In settings choose 平台模式 (Platform) → 连接平台 (Connect platform). Follow the private review login procedure, authorize the connection and return to the extension callback page. PKCE checks the authorization response; the extension never receives platform model API keys.
13. Ask and translate as above. The composer shows a fixed 平台模型 (Platform model) label with no model-switch control. Reading sessions synchronize; only confirmed conclusions are saved to the research library. In settings click 断开连接 (Disconnect) to revoke the token and remove it locally. Local records remain.

## Limitations and permissions

Chrome internal pages and the Chrome Web Store are protected and cannot be read. Arbitrary provider endpoints, article origins and cross-origin images need optional per-origin access, only requested after an explicit action. The production manifest declares no required website host access. Clipboard copy is triggered by an explicit user action. Private/review access does not change these permissions or enable hidden functionality.

