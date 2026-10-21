# Privacy practices 可粘贴草稿

最终勾选须和上传版本、公开隐私政策及 Dashboard 当前字段一致。这里不提供密钥，也不声称模型供应商零留存。

## Single purpose

Help users read and understand the current web article in place: translate its text and images, ask questions grounded in selected or page content, return to source evidence, and save their reading notes and conclusions.

## Permissions justification

| Permission | English justification |
|---|---|
| activeTab | Grants temporary access to the active page after the user clicks the extension action to start reading. Used to extract visible article content and show reading overlays. |
| scripting | Injects the bundled article extraction, selection, citation and translation overlay code into the page that the user has enabled for reading. |
| tabs | Reads the current tab URL, title and window to bind the sidebar and source evidence to the correct article and identify protected pages. Also opens authorization and source tabs. Does not enumerate unrelated browsing history. |
| sidePanel | Displays the main reading conversation interface in Chrome's native side panel alongside the source article. |
| contextMenus | Provides explicit selection actions and a reversible original/translation toggle for the paragraph under the pointer. |
| storage | Stores extension activation state, the optional platform authorization token and short-lived coordination state across the side panel and service worker. |
| unlimitedStorage | Supports local reading sessions, saved notes, bounded translation cache and temporary task inputs without losing them to the default storage quota. Cache is capped at 500 entries; temporary task inputs are removed on completion/cancellation. |
| alarms | Wakes the service worker to inspect/resume translation work already started by the user. Does not crawl pages or start unrelated reading tasks. |
| Optional HTTP(S) host access | Users may read arbitrary article sites, configure different model API hosts, connect a self-hosted platform, or translate images served from a separate host. Access is requested per specific origin when that operation is enabled by the user. Required host access is limited to techradar.top and www.techradar.top for the trusted-click source-launch bridge; it does not read login credentials or unrelated pages. |

## Remote code

Select **No** after checking the actual production ZIP. All executable extension code is bundled locally. Calls to model APIs return text/JSON/images that are treated as data, not downloaded executable code. Website text and model responses are not evaluated as scripts.

## User data disclosure

Data is handled locally and, for user-triggered AI operations, transmitted to the configured model service or optional platform. Do not select “no user data” merely because the standalone mode stores reading records locally.

| Dashboard data category | Relevant behavior |
|---|---|
| Authentication information | The user's provider API Key authenticates requests to their chosen provider; it is stored locally. Optional platform authorization tokens are also stored locally and transmitted to that platform. |
| Web history | URL/title of the article currently enabled by the user, saved in reading history and optionally synced to the platform. No unrelated browsing-history crawl. |
| Website content | Article text, selected passages and requested image content needed for translations and grounded questions. |
| Personal communications | Questions, AI conversation history and user notes used for reading discussions and optional synchronization. |
| Personally identifiable information (optional platform account) | Platform sign-in handles account profile information. Disclose the optional platform login data flow consistently with the provider sign-in and policy; do not claim that standalone mode requires identity. |

Do not claim collection of payment, health, location or unrelated user-activity data without a corresponding feature. Model service URL and article URL are not GPS location. Provider billing is performed by that provider, not this extension.

Data-use certifications: the extension does not sell user data, transfer it for unrelated purposes, or use it for creditworthiness/lending. Data is used only for its reading purpose and necessary security/support, subject to the Chrome Web Store Limited Use requirements. The selected provider's retention policy remains applicable and must be disclosed.

Privacy policy URL: https://techradar.top/reading/privacy

Support URL: https://techradar.top/reading/support

