# Reader Chrome Web Store 发布

本指南介绍 Reader 扩展的 Chrome Web Store 材料准备、打包和发布流程。注册费和 Google 账号验证由发布者操作。安装包版本以 `apps/extension/package.json` 与生成的 `package-report.json` 为准。

## 已准备的文件

- `listing-zh-CN.md`：商店名称、简介、详细介绍和分发建议。
- 英文商店介绍尚未准备，当前条目以 `listing-zh-CN.md` 为准；若后续要上英文页面，需按中文说明逐条对照并保持功能与使用限制一致。
- `privacy-fields.md`：单一用途、逐项权限理由和数据披露草稿。
- `reviewer-instructions.md`：可复制到私有 Test instructions 的审核操作说明；提交前按实际访问依赖选择说明，测试凭据可选，受限平台的访问方式另行准备。
- `../../apps/extension/RELEASE_NOTES.md`：按版本记录用户可见变更和商店提交状态；每次提升版本号时先在此落一条记录。
- `assets/`：128px图标、440×280宣传图及1280×800截图。
- `brand-spec.md`：素材所用的现有 Reader 标识、颜色和真实 UI 来源。
- `capture-assets.mjs`：在独立 Chromium 中捕获现有扩展 UI，并生成商店截图；不接触用户 Chrome 配置或私人网页。
- `capture-real-articles.mjs`：直接加载真实文章并生成中英文截图、宣传图和可切换预览页。

公开页面：

- 隐私政策：<https://techradar.top/reading/privacy>
- 使用与支持：<https://techradar.top/reading/support>
- 支持工单：<https://github.com/csbpku/deep_research/issues>

发布前应验证隐私与支持页面可访问。政策的唯一内容源是 `apps/extension/privacy-policy.json`；构建时生成扩展内 `privacy.html` 和 `PRIVACY.md`，Web 直接读取同一份 JSON。

## 生成上传包

```sh
pnpm --dir apps/extension package:store
```

命令构建普通生产包并检查：Manifest V3、版本一致、无固定 host 权限、权限集合、图标尺寸、隐私副本和资源文件。输出到 `.output/store/reader-<version>-<随机后缀>/`，每次生成独立目录，不覆盖历史 ZIP。

`package-report.json`记录本地打包检查结果；它不读取开发者账号、商店草稿或平台白名单。上传前请在 Developer Dashboard 核对目标条目和平台接入配置。

上传 `deep-research-reader-store-<version>.zip`，不要上传源码目录、测试构建或完整材料目录。ZIP 根目录含 `manifest.json`。商店包移除 Beta 固定公钥；现有 Beta 构建和固定 ID 保持原样。

## 发布顺序

1. 用长期维护的 Google 账号注册开发者，支付页面显示的注册费、验证联系邮箱并启用两步验证。填真实发布者身份信息；商店要求的账号联系邮箱仍由发布者提供，GitHub Issues 不能替代该字段。
2. Add new item，上传商店 ZIP。这一步只创建草稿，不提交或发布。
3. 记录后台 Item ID。在 Package → View public key 取得商店公钥；本地验证商店版时使用该公钥，使验证版 ID 与商店一致。
4. 将 Item ID 加入生产 `READING_EXTENSION_IDS`（保留 Beta ID，逗号分隔），按现有部署方式使配置生效；验证平台授权往返与独立模式。不要把商店公钥直接替换进 Beta 默认构建，避免已有解压用户失去本地数据。
5. 填 Store Listing、Privacy practices、Distribution；按实际访问依赖决定 Test instructions 的内容，核对页面、声明与当前包行为一致。官方明确此测试说明页不是发布必填项；BYOK模式应写明模型配置依赖，专用模型凭据可选，平台受限账号的测试方式单独说明。
6. 建议先用 Unlisted 安装链接做商店版验收。Unlisted 同样需要审核，并且知道链接的任何人均可安装；平台账号权限仍独立控制。
7. 提交审核并选择“通过后手动发布”。审核通过后最多 30 天内发布，超过时需重新提交审核。
8. 从商店真实安装并验证侧栏、选段、问答、全文翻译、原文/译文切换、模型发现、本地导出导入及平台授权。通过后再转公开可见。

后续更新在同一个 Item 上传更高版本并提交审核。后端部署、Beta Release 和商店发布分别记录，不能把其中一项成功当作另两项已完成。

商店审核是逐个版本的固定成本，因此不逐个小功能提交：功能合入 `main` 后先在
`apps/extension/RELEASE_NOTES.md` 记一条，等攒够一批有用户价值的变更再提升版本号、
打商店包并提交审核。合入 `main` 只影响平台和 Beta Release，不影响已安装的商店版本。

## 提交前检查

- 核对安装包、商店页面、隐私披露与实际功能一致。
- 按审核所需访问条件填写测试说明；不要在公开字段或仓库中填写凭据。
- 提交审核与选择发布方式由发布者在 Developer Dashboard 完成。

没有可用银行卡时，注册费没有公开的免费豁免流程。可在持卡人同意后请可信亲友协助支付，能否接受以注册收银台和发卡行结果为准；材料准备可以继续。解压包仍可分发。Edge Add-ons 免注册费，但面向 Edge，需另行授权与验收，不自动替代 Chrome 发布。

## 官方资料

- 注册：<https://developer.chrome.com/docs/webstore/register>
- 上传和提交：<https://developer.chrome.com/docs/webstore/publish>
- 图像：<https://developer.chrome.com/docs/webstore/images>
- 隐私声明：<https://developer.chrome.com/docs/webstore/cws-dashboard-privacy>
- 审核说明：<https://developer.chrome.com/docs/webstore/cws-dashboard-test-instructions>
- 扩展 ID：<https://developer.chrome.com/docs/extensions/reference/manifest/key>
- 分发：<https://developer.chrome.com/docs/webstore/cws-dashboard-distribution>

