# Quick-brief evidence display: TDD record

Date: 2026-10-28. Scope: BFF and reader-facing display only. No generation algorithm, database contract, or review-state changes.

## Finding and plan

Isolated local task `9cf4e6af-324b-4a5a-b3be-a65b2fca35ff` has report type `summary_brief`, empty sourceRefs, and no formal draft. Its only partial source uses `context:<jobId>` as canonical key and source ref. The snippet contains the confirmed research plan, not a retrieved webpage. The raw engine counter is 1; the BFF and UI previously promoted it to captured evidence.

Filter context/model/plan synthetic sources from the reader-facing ledger. Keep raw counters for diagnostics. Quick briefs must honor the durable BFF captured count, including zero, and explain their lightweight capability boundary. Real URLs remain evidence; full research retains the existing runtime fallback.

## RED

Commit: `ea3e2f1`. Before production changes, ran:

```sh
pnpm --filter @deep-research/web test src/app/api/ai-research/__tests__/status-evidence.test.ts src/components/ai-research/AiResearchTrustStates.test.ts
```

Actual result: 4 intended assertion failures, 45 passes. Failures covered synthetic and mixed-source projection, runtime 1 overriding BFF 0, and missing quick-brief limitation text.

## GREEN

Implementation commit: `8e1123c`. Ran after the final implementation edit:

```sh
pnpm --filter @deep-research/web test src/app/api/ai-research/__tests__/status-evidence.test.ts src/components/ai-research/AiResearchTrustStates.test.ts src/components/ai-research/InlineAiResearchStatus.test.ts src/lib/research-user-status.test.ts
pnpm --filter @deep-research/web typecheck
git diff --check
```

Actual result: 4 test files, 56 tests passed. Web typecheck and diff check passed. Existing MUI SSR :first-child diagnostic did not fail tests.

The integrated workspace owns real-browser acceptance of this task. These unit results do not claim browser acceptance. History listing still forwards upstream summary counters and is outside this detail/inline projection fix.
