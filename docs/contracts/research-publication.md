# Research Publication Contract

Publication permission and factual verification are separate boundaries. The author or an administrator may publish a structurally complete draft. Known high-risk contradictory facts must be corrected; accepting uncertainty or starting an unfinished retry does not bypass this gate. Other evidence gaps and unavailable reviews require explicit disclosure acknowledgement.

## Revision Confirmation

`GET /api/researches/{id}` returns `publicationVersion`, a fingerprint of the current research snapshot, contributing review inventory, decisions, and research sufficiency. It is not an authorization token.

`POST /api/researches/{id}/publish` accepts:

```json
{
  "acknowledgeDisclosure": true,
  "publicationVersion": "64-character fingerprint from the latest detail response"
}
```

- AI research disclosure acknowledgement requires the matching fingerprint. Missing or stale confirmation returns `409 AI_REVIEW_CONFLICT`.
- A clean current review retains the no-body compatibility path. Manual content does not require the AI fingerprint.
- The serializable publication transaction re-reads the snapshot, checks the fingerprint, and conditionally updates the unchanged draft. Concurrent edits or review changes return a conflict without a publication audit.
- Editors must save changes before asking the author to confirm a new version.

## Summary And Artifact Gates

AI research drafts derive `background`, `conclusion`, and `risks` from the finished report without another model call. Missing sections remain empty, represented as database `NULL`; no risk statement is invented. The queued review revision hashes the exact persisted fields, including these nulls and tags. Replaying the same job does not overwrite an existing draft.

Generic research reports require complete summary fields before publication. Learning paths instead use their own structural contract. Comparison matrices require evidence or an explicit gap marker per cell and must remain neutral rather than naming a unique recommendation.

Learning paths and comparison matrices with an absent or empty coverage table require disclosure acknowledgement. A heading-only or header-only table is missing coverage, not complete coverage. Any artifact with partial, unknown, or conflicting coverage rows also requires acknowledgement. Legacy generic reports without a coverage table remain compatible.

## Review Inventory

The newest completed full inventory replaces the older full inventory for the same revision. Newer partial or unfinished runs still contribute evidence; they do not erase previous unresolved risks. A completed run with zero extracted claims is not a complete replacement inventory.

`details.reviewMode`, `details.review_mode`, or `triggeredBy` equal to `evidence_challenge` marks a claim-scoped run. Its local `coverage_status=complete` never means whole-report coverage. A supported local result can withdraw only the exact matching target from an earlier completed source run, with valid `requestedFromRunId` lineage. Other known conflicts remain. Queries resolving this inventory must include timestamps, scope details, and trigger metadata, including the batch-decision route.

## Reader Disclosure

`reviewVerification` is `verified | disclosed | conflicted | unverified | null`. Historical `passed` mirrors do not certify the current revision. `reviewDisclosure` preserves unresolved findings, accepted uncertainty, evidence status, and the author's reason. `reviewDisclosureSummary` records coverage, sufficiency, hard blockers, and incomplete machine verification.

Drafts expose the equivalent confirmation projection through `publicationDisclosure`, `publicationDisclosureSummary`, and `publicationHardBlocked`. Published pages and Markdown exports use the same reader disclosure. A retry does not hide the same-revision risks it has not resolved.

## Isolated Database Verification

Web integration tests require explicit `TEST_DATABASE_URL` pointing to `127.0.0.1/pr56_publication_test`; they never fall back to the application database. The draft-factory PostgreSQL regression uses the same explicit database. Fixtures are retained for inspection.

```sh
TEST_DATABASE_URL=postgresql://USER@127.0.0.1:PORT/pr56_publication_test pnpm --filter @deep-research/web exec vitest run src/app/api/__tests__/research-publication.integration.test.ts src/lib/search/radar-search.integration.test.ts
```
