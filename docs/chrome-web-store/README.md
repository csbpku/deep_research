# Reader Chrome Web Store 发布

这是商店发布材料与操作入口，不代表已经上传、审核通过或上架。注册费和 Google 账号验证由发布者操作。当前安装包版本以 `apps/extension/package.json` 与每次生成的 `package-report.json` 为准。

## 已准备的文件

- `listing-zh-CN.md`：商店名称、简介、详细介绍和分发建议。
- `privacy-fields.md`：单一用途、逐项权限理由和数据披露草稿。
- `reviewer-instructions.md`：可复制到私有 Test instructions 的审核操作说明；提交前填写实际测试凭据。
- `assets/`：128px 图标、440×280 小宣传图，以及 1280×800 功能截图。
- `brand-spec.md`：素材所用的现有 Reader 标识、颜色和真实 UI 来源。
- `capture-assets.mjs`：在独立 Chromium 中捕获现有扩展 UI，并生成商店截图；不接触用户 Chrome 配置或私人网页。

公开页面：

- 隐私政策：<https://techradar.top/reading/privacy>
- 使用与支持：<https://techradar.top/reading/support>
- 支持工单：<https://github.com/csbpku/deep_research/issues>

部署和匿名可访问状态以本次验收证据为准。政策的唯一内容源是 `apps/extension/privacy-policy.json`；构建时生成扩展内 `privacy.html` 和 `PRIVACY.md`，Web 直接读取同一份 JSON。

## 生成上传包

```sh
pnpm --dir apps/extension package:store
```

命令构建普通生产包并检查：Manifest V3、版本一致、无固定 host 权限、权限集合、图标尺寸、隐私副本和资源文件。输出到 `.output/store/reader-<version>-<随机后缀>/`，每次生成独立目录，不覆盖历史 ZIP。

上传 `deep-research-reader-store-<version>.zip`，不要上传源码目录、测试构建或完整材料目录。ZIP 根目录含 `manifest.json`。商店包移除 Beta 固定公钥；现有 Beta 构建和固定 ID 保持原样。

## 发布顺序

1. 用长期维护的 Google 账号注册开发者，支付页面显示的注册费、验证联系邮箱并启用两步验证。填真实发布者身份信息；商店要求的账号联系邮箱仍由发布者提供，GitHub Issues 不能替代该字段。
2. Add new item，上传商店 ZIP。这一步只创建草稿，不提交或发布。
3. 记录后台 Item ID。在 Package → View public key 取得商店公钥；本地验证商店版时使用该公钥，使验证版 ID 与商店一致。
4. 将 Item ID 加入生产 `READING_EXTENSION_IDS`（保留 Beta ID，逗号分隔），按现有部署方式使配置生效；验证平台授权往返与独立模式。不要把商店公钥直接替换进 Beta 默认构建，避免已有解压用户失去本地数据。
5. 填 Store Listing、Privacy practices、Distribution 和 Test instructions。补齐审核凭据后，核对页面、声明与当前包行为一致。
6. 建议先用 Unlisted 安装链接做商店版验收。Unlisted 同样需要审核，并且知道链接的任何人均可安装；平台账号权限仍独立控制。
7. 提交审核并选择“通过后手动发布”。审核通过后最多 30 天内发布，超过时需重新提交审核。
8. 从商店真实安装并验证侧栏、选段、问答、全文翻译、原文/译文切换、模型发现、本地导出导入及平台授权。通过后再转公开可见。

后续更新在同一个 Item 上传更高版本并提交审核。后端部署、Beta Release 和商店发布分别记录，不能把其中一项成功当作另两项已完成。

## 尚需发布者提供

- 已完成注册的开发者账号及已验证的联系邮箱。
- 商店草稿 Item ID / 公钥。
- 审核可用的有限额模型服务凭据；平台模式的可用审核登录入口。不要将密钥写进公开仓库或商店描述。
- 最终提交审核和公开发布的确认。

没有可用银行卡时，注册费没有公开的免费豁免流程。可在持卡人同意后请可信亲友协助支付，能否接受以注册收银台和发卡行结果为准；材料准备可以继续。解压包仍可分发。Edge Add-ons 免注册费，但面向 Edge，需另行授权与验收，不自动替代 Chrome 发布。

## 官方资料

- 注册：<https://developer.chrome.com/docs/webstore/register>
- 上传和提交：<https://developer.chrome.com/docs/webstore/publish>
- 图像：<https://developer.chrome.com/docs/webstore/images>
- 隐私声明：<https://developer.chrome.com/docs/webstore/cws-dashboard-privacy>
- 审核说明：<https://developer.chrome.com/docs/webstore/cws-dashboard-test-instructions>
- 扩展 ID：<https://developer.chrome.com/docs/extensions/reference/manifest/key>
- 分发：<https://developer.chrome.com/docs/webstore/cws-dashboard-distribution>

