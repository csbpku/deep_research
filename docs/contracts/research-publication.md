# 研究发布、核验与读者披露

发布权限与事实核验是不同边界。作者或管理员可将结构完整的草稿发布；已捕获证据反驳的高风险事实必须修订，不能通过接受不确定性或发起一次未完成的重试绕过。其他证据缺口、覆盖不足、核验未开始或失败，可以由作者明确确认后带披露发布。

## 版本确认与事务

`GET /api/researches/{id}` 返回 `publicationVersion`，是当前完整研究快照、最新同版本审核及声明决策、资料充分性状态的 SHA-256 指纹。它不是鉴权凭据；发布仍检查作者或管理员身份。

`POST /api/researches/{id}/publish` 请求体：

```json
{
  "acknowledgeDisclosure": true,
  "publicationVersion": "从最新详情响应读取的64位十六进制指纹"
}
```

- AI 调研提交 `acknowledgeDisclosure: true` 时必须同时提供所见的 `publicationVersion`。缺失或与当前快照不符，返回 `409 AI_REVIEW_CONFLICT`，需要刷新、阅读当前披露并重新确认。
- 当前干净审核的发布保留无请求体兼容；手工内容也不强制提供指纹。提供了 AI 版本指纹时总会核对。
- 核验未完成、`review_unavailable` 或编辑后无审核结果，不再因旧 `reviewStatus` 白名单被拒绝；显式确认仍必需。
- 发布事务重新读取完整快照、核对初读指纹，并按原正文、摘要、标签、状态、`updatedAt` 做条件更新。事务使用 PostgreSQL Serializable；并发编辑或审核更新导致的序列化冲突（Prisma `P2034`）统一返回 `409 AI_REVIEW_CONFLICT`，不会写入发布审计。
- 用户确认后若编辑器还需保存 AI 正文，先完成保存，再要求用户根据新版本重新确认；后台审核更新也会清除旧的勾选。

## 统一的读者投影

详情响应的 `reviewVerification` 为 `verified | disclosed | conflicted | unverified | null`。`verified` 只用于当前版本已有完整、干净且完成的审核；`conflicted` 表示已知高风险反证，`unverified` 表示最新核验尚未完成或不完整。状态不会从历史的 `passed` 镜像推断。

`reviewDisclosure` 同时包含仍未解决的声明和作者接受的不确定性，保留声明、风险、证据状态及作者理由。`reviewDisclosureSummary` 包含覆盖情况、资料充分性、未核验与冲突数量、`hardBlockCount`、`machineIncomplete`、当前审核状态及是否保留上一轮风险。

草稿详情通过 `publicationDisclosure`、`publicationDisclosureSummary` 返回发布确认所需的同一投影，并通过 `publicationHardBlocked` 保证编辑器与服务端对历史同版本高风险冲突的阻断一致；草稿的读者披露字段仍保持空值。

已发布内容重新核验进入排队、运行、失败或失效状态时，仍显示尚未完成核验的警示，并保留同一正文版本此前发现的风险。只有完成的新声明清单可以替代旧清单；不同正文版本的历史风险不冒充当前结论。历史面板的条数限制不限制安全披露的回溯。

页面和 Markdown 导出使用同一组披露字段与文案。导出必须保留当前核验状态、覆盖与资料缺口、冲突及未核验声明、作者接受不确定性的理由。

## 独立数据库回归

回归测试仅在显式设置 `TEST_DATABASE_URL` 时连接数据库，且仅接受 `127.0.0.1` 的 `pr56_publication_test` 库，不回落到业务 `.env`。迁移后在 `apps/web` 执行：

```sh
TEST_DATABASE_URL=postgresql://USER@127.0.0.1:PORT/pr56_publication_test pnpm exec vitest run src/app/api/__tests__/research-publication.integration.test.ts
```

测试覆盖未审核和不可用状态的真实条件更新、事务快照读取后的并发正文与审核更新、旧版本确认、高风险拒绝，以及发布审计的原子性。测试保留自己创建的隔离库记录用于复核。
