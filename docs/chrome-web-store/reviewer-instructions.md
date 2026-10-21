# Private Test instructions draft

**Choose the review access route before copying this draft into Dashboard.** Chrome's [Test instructions documentation](https://developer.chrome.com/docs/webstore/cws-dashboard-test-instructions) says this tab is not required for publishing; it is useful when restricted credentials or a paid account are needed for full access. A publisher-supplied model API key is a recommendation for easier functional review, not a universal submission requirement. Never commit API keys, account passwords or authorization tokens to this document or public listing.

## Review access options

- Standalone is bring-your-own-model: document its provider URL, model discovery and key requirements. A publisher test endpoint is optional. Without one, inference requires the reviewer's compatible model service; do not imply that Google supplies paid model access or that this route guarantees acceptance.
- For easier end-to-end review, the publisher can supply a dedicated, limited-quota endpoint/key/model in Dashboard's private test fields. The publisher's personal local proxy is not remotely accessible.
- Platform mode has a separate account allowlist. To enable review of this mode, supply a working test login/access procedure in the private fields. Standalone access does not unlock platform mode.

## Private fields, if publisher test access is supplied

- Standalone provider Base URL: **[OPTIONAL PUBLISHER TEST ENDPOINT]**
- Protocol: OpenAI-compatible Chat Completions or Anthropic-compatible Messages.
- Reviewer API Key: **[IF SUPPLIED: dedicated, limited quota, valid throughout review]**
- Model ID: **[FOR THE CHOSEN ENDPOINT; available via /models where supported]**
- Optional platform mode: **[TEST LOGIN/ACCESS PROCEDURE IF THIS MODE IS TO BE TESTED]**. Production uses an account allowlist.

## Main purpose and setup

Deep Research Reader is an in-page AI reading assistant with Chinese and English interfaces. Settings → 界面语言 (Interface language) can change the UI language; labels below use Chinese with English translations. Responses follow the user's question language. The standalone mode works independently of the Deep Research platform. The platform mode is optional and requires an authorized account. The extension is free to install; external model services may charge the end user for usage. All JavaScript is bundled locally; API outputs are data, not executable code.

1. Install the submitted package. Open a public English article, for example https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Introduction . Click the extension action to open the native side panel and enable reading of that page.
2. Click 设置 (Settings). Keep 独立模式 (Standalone). Select the provider, confirm API 地址 (API URL) and enter the test Key from the private fields, if supplied; otherwise configure an available compatible model service. A key is optional for a local loopback service and required for a cloud provider. Click 连接并获取模型 (Connect and fetch models), and approve access to the specific provider origin if Chrome prompts. Choose a model from the searchable list. If the endpoint does not expose /models, expand 手动指定模型 ID (Specify model ID manually) and enter its ID.
3. Click 保存配置 (Save configuration). Saving does not run inference. Click 测试连接 (Test connection) for a short model-response check; expect 连接成功 (Connection successful). API list discovery and successful model replies are separate checks. Return with 返回聊天 (Back to chat).

## Reading, translation and source evidence

4. Ask “这篇文章的核心观点是什么？” (What are the key ideas of this article?). Expect a streamed answer in the conversation. Select a sentence on the article and ask “解释这段” (Explain this passage). The composer shows the original selection and allows copying/clearing it.
5. When source evidence is returned, click its 在网页中定位 (Locate in page) action to scroll/highlight that exact passage. Background, inference and limitations can be expanded under 补充说明 (Additional details). “继续追问” (Follow up) is one grouped question list; clicking a question sends it as the next turn. Previous turns remain in the conversation for that article.
6. Click 翻译 (Translate) in the composer. Text appears progressively on the source page. Hover a translated paragraph, use its original/translation button or the right-click toggle, then switch both ways. Alt+Shift+O also toggles the current paragraph. This does not send another model request. 恢复原文 (Restore original) removes the whole-page overlay. Code blocks remain original.
7. Text-only models cannot translate images; the extension reports the affected item and preserves the image. With a configured vision-capable model, image translations use an overlay only when positioning is reliable, otherwise show adjacent text. Platform mode currently does not support image questions.
8. During an answer, select another passage or close/reopen the side panel. An existing answer is owned by the background worker and is not cancelled by those actions. The square icon in the send-button position has the accessible label 停止回答 (Stop answer) and explicitly cancels. Browser exit or forced service-worker termination can interrupt the request. In standalone mode, the model name/chevron above the input opens a searchable model list; a selection applies to the next request. Expanding 手动指定模型 ID or 图片能力 in settings reveals the additional fields or test button, with the chevron indicating the expanded state.

## Local data and privacy

9. 保存结论 (Save conclusion) lets the user review/edit their excerpt, note and AI conclusion before saving. 收藏 (Saved) contains explicitly saved excerpts, notes and conclusions. Automatic reading/chat sessions appear in 历史 (History); they do not become saved conclusions automatically. Records are local by default; an authorized platform connection can also show synchronized records.
10. In settings, 导出阅读数据 (Export reading data) exports local reading records without API keys, temporary task inputs or translation caches. 清除翻译缓存 (Clear translation cache) clears cache; 清除本地数据 (Clear local data) requests confirmation then clears local reading records/configuration. These do not delete previously synced platform data.
11. 隐私政策 (Privacy policy) opens the packaged offline policy. Public policy and support pages are available without login at https://techradar.top/reading/privacy and https://techradar.top/reading/support .

## Optional platform mode

12. The publisher must first allowlist the Store Item ID on the production platform. In settings choose 平台模式 (Platform) → 连接平台 (Connect platform). Follow the private review login procedure, authorize the connection and return to the extension callback page. PKCE checks the authorization response; the extension never receives platform model API keys.
13. Ask and translate as above. The composer shows a fixed 平台模型 (Platform model) label with no model-switch control. Reading sessions synchronize; only confirmed conclusions are saved to the research library. In settings click 断开连接 (Disconnect) to revoke the token and remove it locally. Local records remain.

## Limitations and permissions

Chrome internal pages and the Chrome Web Store are protected and cannot be read. Arbitrary provider endpoints, article origins and cross-origin images need optional per-origin access, only requested after an explicit action. Required host access is limited to techradar.top and www.techradar.top for the bundled Open original → article + native Reader sidebar bridge. Other article, image and model endpoint access is optional and requested per origin. Clipboard copy is triggered by an explicit user action. Private/review access does not change these permissions or enable hidden functionality.

