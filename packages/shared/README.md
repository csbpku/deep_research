# @deep-research/shared

> 双方共用的类型、Zod schema、错误码、状态枚举。
> 工程师 A / 工程师 B 都**只读**这个包。
> 修改必须开 `[shared]` PR，并由主会话 review。

## 包含

- `errors.ts` —— 错误码与 HTTP 状态常量、ApiError 类型
- `states.ts` —— 业务状态枚举（job / import / summary / research / promote / role）
- `schemas.ts` —— Zod 输入校验（API 入口）
- `metrics.ts` —— Week 13 产品事件名与管理动作类型

## 使用

```ts
import { ERROR_CODES, AI_JOB_STATUS } from '@deep-research/shared';
import { CreateAiJobInput } from '@deep-research/shared/schemas';
```

## 修改流程

1. 改 `docs/contracts/error-codes.md` / `docs/contracts/state-machines.md` / `docs/contracts/api-schemas.md`
2. 同步改 `packages/shared/src/...`
3. PR 标题：`[shared] <改动简介>`
4. 影响 `apps/web` 或 `packages/ai-engine` 时，必须同时改对应子包，并在 PR 描述里给出影响面
