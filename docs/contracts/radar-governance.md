# Radar governance

Every-row quality requirements and the read-only inspection command are defined
in [the radar quality checklist](./radar-quality-checklist.md). Structural completeness,
source evidence, and public eligibility remain separate results.

Admin-only `POST /api/admin/radar/governance` accepts `mode` (`preview`, `report`,
`apply`, `recover`, `rollback`), optional `batchId`, and `limit` (1–100). The BFF
supplies the session identity; the internal engine checks the real database Admin
and batch owner again. Existing single-item governance remains available.

This batch API changes no schema and performs no physical deletion. Separate
Admin maintenance commands support confirmed-noise and unavailable-source disposal.
Preview fixes a server-owned
inventory, evidence, protections, before/after fields and timestamps. Duplicate
titles are review suggestions only. Apply uses at most 100 operations per atomic
transaction, locks target rows, checks snapshot values and `updatedAt`, rechecks
references for noise, and writes `admin_actions` in the same transaction. Start
with a 10-operation pilot. A shared batch lock serializes apply/recover/rollback.
Audits use the actual `UPDATE RETURNING` row, including trigger-normalized tags
and retired enrichment queue fields, and retain the requested values separately.
Rollback checks these actual values; the narrowly scoped legacy external-reading
tag normalization remains compatible without accepting later edits.

Before writes, `RADAR_GOVERNANCE_STATE_DIR/backup-verified.json` must identify a
full dump, its SHA256, `restoreVerified: true`, and an isolated restored database
named `governance_verify_*`. Runtime checks the actual dump checksum. The operator
must first verify restore using `pg_restore --exit-on-error --single-transaction`;
the receipt is an operational attestation, not a substitute for restoration.
Preserve the dump and isolated database. Default state root is
`/data/zread/governance`, on the existing persistent volume.

Recovery processes at most 20 distinct items and 40 reserved provider attempts,
at most two per item including format retries. Calls use `single_attempt=True`
to disable hidden transport retries/fallback. Reservations and item starts are
persisted before work; interrupted items with unknown outcomes are not retried
automatically. Quota stops model work. Existing valid scores are retained; source
text is ephemeral. Verified external-reading migration retains old body/review
history and never changes a rejected review to approved.

SSH maintenance uses the same core; run from the AI-engine package root (or `/app` in the production image):

```sh
python -m scripts.govern_radar preview --actor <real-admin-email>
python -m scripts.govern_radar apply --actor <real-admin-email> --batch <uuid> --limit 10
python -m scripts.govern_radar recover --actor <real-admin-email> --batch <uuid> --limit 1
python -m scripts.govern_radar report --actor <real-admin-email> --batch <uuid>
python -m scripts.govern_radar rollback --actor <real-admin-email> --batch <uuid> --limit 100
```

Rollback reverses recovery before deterministic operations, requires the recorded
post-write timestamp and values, and records another audit transaction. It accepts
only an exact same-plan rollback transition when undoing chained edits. Later
background/user edits cause a conflict instead of being overwritten. Repeat until
no results remain; inspect conflicts separately. Restore from the dump is disaster
recovery, not the normal rollback path.

Sync retains diagnostic history while keeping one current pending action per
source/URL/reason; filtered rows also require identical evidence. Score success
closes missing-score diagnostics only for the same source run and URL. After three
deterministic oversized/missing-source failures for the same publication identity
(source, canonical URL, normalized title and publication timestamp),
sync stops automatic attempts. A new publication identity permits new attempts.
Noise and unassessable results retain different reasons.
The scheduled loop does not consume a source's polling window when a live-run
guard skips work; the next tick checks again and reaps any lease that expired
in the meantime. A stale run then records `STALE_RUN_REAPED` before normal retry.

After execution, export the plan, audits/results, fresh statistics, call counts,
unresolved/deferred lists, and verify public radar/search/topics/references. A
24-hour review is read-only and reports recurrence rather than silently repairing it.

## Continuous repair and confirmed-noise deletion

`python -m scripts.repair_radar --actor <real-admin> --state-dir <durable-path>`
scans automatic radar plus approved shares, including archived/rejected rows.
The default 20-item limit is per cycle, not a limit on the inventory. It retains
valid legacy scores, prioritizes missing scores and references, then fills missing
summaries/judgements. Source text is transient; limited abstracts/excerpts may
support a limited-evidence score. Source completeness is separate from noise disposal.
Brief repair writes only the missing summary or judgement fields. A valid existing
summary, judgement or score is preserved when another field needs recovery.
Valid scored noise is excluded from brief completion and content-completeness
statistics. It proceeds directly to deletion/protection/evidence disposition;
current-score validity and reference guards still apply, without a fetch/model call.
Each attempt reserves at most two single-attempt model calls, and writes score
and summary separately so a later summary failure cannot discard a score.
Summary evidence options are extracted verbatim from the source; the model may
select an integer index or supply a direct quote. Both paths must match the actual
source, allowing only layout whitespace differences. Invalid/missing evidence,
invalid JSON or short summaries remain explicit failures. A completion checkpoint
is accepted only while a valid score and usable summary/judgement are present.

Length alone does not establish a usable brief. Sync, repair and the quality
audit recognize explicit source-unavailable responses and summaries inferred
only from a title. They preserve useful abstracts and honest limitations.
Repair replaces only missing/placeholder fields and rejects another refusal as
`MODEL_SUMMARY_INVALID`; sync records `REPAIR_SUMMARY_UNAVAILABLE` for follow-up
instead of persisting the refusal as successful interpretation.

Automatic all-zero handling remains unresolved. A separate internal Admin
operation may explicitly review a readable, seven-zero assessment as noise
without manufacturing nonzero dimensions or changing public score gates. The
`reviewed_zero_noise_v1` proof requires a null existing score, current rubric,
no hard veto, a grounded weakness quote, live source hash, unchanged row
fingerprint/updatedAt, a reasoned review decision and a successful scoring usage
event. Deletion uses the same real-Admin check, reference locks, archive,
transactional audit and conditional restore as other noise dispositions. It is
not a new public or automatic deletion endpoint.

Generic HTML repair first reads at most 2 MB. Only a size-limit failure permits
one further read up to 8 MB/15 seconds with the same host, redirect and SSRF
constraints; the entire source phase has a 55-second deadline. Larger reads and
18,000-character extracts are explicitly labelled partial source evidence, never
as a full-source or all-chunks review. Generic article selection prefers the
article/main containing the page heading and avoids unrelated recommendation
cards. A recognized robot challenge fails before a model call. Cached originals
are eligible only with ready reader status and exact byte count/SHA-256; other
caches remain preserved while the live source is checked.

Scoring distinguishes malformed dimensions (`MODEL_SCORE_FORMAT`), title mismatch
(`MODEL_TITLE_MISMATCH`), safety veto (`MODEL_UNSAFE_VETO`) and actual seven-zero
output (`MODEL_UNASSESSABLE`). Vetoes and unassessable results stop automatic model
retries until new evidence or a corrected request justifies an audited requeue.
None of these model failures establishes noise or source unavailability. A
publication URL correction requires verified original identity, an unchanged-row
check and an Admin audit retaining the old URL; it preserves the content ID,
existing valid scores and historical source evidence.

GitHub repository evidence prefers the README API. API rate limiting cools that
API for one hour within the running worker while allowing same-repository public
raw `HEAD/README.md`, `README.rst`, or `README` reads. Both hosts use bounded safe
fetches without redirects; an explicit zero redirect limit overrides the default
and environment. An API redirect falls back to the original repository's raw
path without following the API destination. Other safety errors, raw HTML/error
pages and identity mismatches are rejected. An unresolved path during API cooldown records
`SOURCE_GITHUB_API_RATE_LIMITED` for that repository with a one-hour retry delay;
it does not pause other repositories' raw reads. Actual raw-host rate limiting
still pauses the source. A missing conventional path does not prove there is no README. Only a
fully read source of at most 18,000 characters can prove completeness; larger
sources remain limited evidence. No source body is persisted by this fallback.

Dev.to articles use their official article API with no redirects. The response
must be JSON from the exact API URL, with a positive article ID and matching
article URL, canonical URL and title. Only its `body_markdown` is evidence;
this path takes precedence over legacy cached captures, which can contain unrelated
widgets despite having valid hashes. The old cache remains unchanged; an API
failure does not fall back to it. Missing/short bodies remain unresolved. A complete body of at most 18,000
characters may prove completeness, while a longer body is limited evidence.
Verified API/raw Markdown may contain an interior `access denied` error example
without being mistaken for a fetch failure. Leading error pages, HTML shells and
other challenge markers are still rejected; generic HTML and cached content keep
their existing checks. This exception never rewrites the evidence text.

Explicit `.pdf` source URLs use a per-request PDF opt-in in the SSRF-safe fetcher,
with the exact original host/URL, zero redirects, PDF MIME and magic verification,
and a 12 MiB/25-second fetch cap. Generic fetches retain their text-only defaults.
Extraction runs in a credential-free child process with a 12-second wall deadline,
6 CPU seconds, 512 MiB address-space limit on Linux, at most 80 pages and 200,000
characters. The scoring input remains at most 18,000 characters; truncation or a
page without extractable text never proves complete evidence. Damaged, encrypted,
scanned and extraction-limit failures have explicit terminal reasons. Neither PDF
bytes nor extracted body is stored. Exhausted historical failures require a
verified new source preflight and audited Admin requeue; deployment alone does
not reset a budget.

The owner's standing policy `current_valid_noise_v1` disposes automatic radar
with a current, valid, non-default, non-zero seven-dimension noise score. Source
fetch failures, excerpts and missing quotations do not block deletion. Missing,
invalid and legacy scores remain reviewable; fetch failure alone is not noise.
The owner's separate unavailable-source authorization below does not require a noise score.
Existing valid scores are preserved rather than replaced to force eligibility.

New sync skips unreferenced confirmed noise before inserting into `summaries`.
Research/chat URL references and pinned repositories that predate a summary also
protect that discovery. A dismissed
`NOISE_NOT_STORED` receipt keeps only source, URL, publication identity, scoring
version and policy; no body, brief or dimensional score is stored. The same
publication/version is skipped before fetch/model work. A new identity or scoring
version remains eligible. Receipt errors are reported as failures. Unassessable
and default results remain distinct pending work.

`--delete-confirmed-noise` or `RADAR_REPAIR_DELETE_CONFIRMED_NOISE=1` opts the Admin
worker into this standing policy, including old source-failure terminals without
resetting their source/model budgets. Production enablement requires explicit
owner authorization and the verified backup gate.

For a fixed inventory with zero source/model calls, stop the repair worker between
cycles, preview into a new private directory, execute 10, inspect archives/audits,
then apply at most 100 per batch. Repeated apply is idempotent:

```sh
python -m scripts.purge_scored_noise preview --actor <admin> --state-dir <new-private-path>
python -m scripts.purge_scored_noise apply --actor <admin> --state-dir <same-path> --limit 10
python -m scripts.purge_scored_noise apply --actor <admin> --state-dir <same-path> --limit 100
```

### Incomplete radar with unavailable sources

`incomplete_source_unavailable_v1` is a separate owner-authorized Admin maintenance
policy for automatic radar still missing a valid score or usable brief. It requires
a source-only preflight within 24 hours, a matching full-row fingerprint and
`updatedAt`, and historical source failures tied to that same row version. Historical
attempts must be blocked, or already failed at least three times during backoff.
The latest observation must confirm access denial/payment/authentication, missing
content, unsafe access, unusable text or supported-document failure. A timeout
requires three historical timeouts or two separately timestamped fresh timeouts.
Model failures, rate limits, oversized responses and unverified README paths remain
ineligible. Complete rows and approved/manual shares are outside this policy.

```sh
python -m scripts.purge_unavailable_radar preview --actor <admin> --state-dir <new-private-path> --inspection <private-source-preflight.json>
python -m scripts.purge_unavailable_radar apply --actor <admin> --state-dir <same-path> --limit 10
python -m scripts.purge_unavailable_radar apply --actor <admin> --state-dir <same-path> --limit 100
```

This command makes no source/model calls. It reuses the verified backup, real Admin,
reference-table locks, same-transaction audit, full-row archive, CAS and committed
checkpoint safeguards. `radar_source_unavailable_delete` records the original score
and failure evidence without asserting noise. Restore accepts only the matching
archive hash and committed audit, rejects later ID/URL conflicts and records
`radar_source_unavailable_restore`.

Source disposal retains its narrowly scoped diagnostics in the database. Historical
rows stay unchanged; pending rows become dismissed because their content was disposed,
not because scoring succeeded. `radar_source_diagnostics_preserve` records old states,
timestamps, archive hash and post-change full-row fingerprints in the same transaction.
The Admin-only maintenance core `retain_deleted_diagnostics` can recover diagnostics
from an already committed legacy source-disposal archive, without restoring content
or invoking a model. It rejects changed diagnostic rows and reconciles repeated work
using the committed audit. Recovery and content restore share a per-content transaction
lock. Content restore checks the retained full-row fingerprints before restoring the
original diagnostic states; any later diagnostic edit causes `RESTORE_CONFLICT` and
rolls back the whole restore. It never overwrites subsequent changes.

Sync respects both deletion policies for the same source/URL/publication identity;
an audited restore or a new publication permits normal discovery again. Unavailable
source disposal is explicit maintenance, not unconditional future-source deletion.

Preview fixes row fingerprints, timestamps, scores and protection reasons. Changed
rows are skipped. Execution loads full rows individually and reuses Admin checks,
reference locks, CAS, archive and audit transactions. Each <=100-row execution
holds reference locks in one pinned transaction and scans references once; every
row still checks its actual snapshot and score. An audit failure rolls back the
whole database batch. The checkpoint advances only after commit; stable audit IDs
reconcile a crash between commit and checkpoint. Old `complete_grounded_noise`
audits keep their original meaning and remain restorable.

User notes, shares, bookmarks, annotations, manually pinned repositories and research/
chat/topic references protect the row. Reference tables are locked during the
final check. The full summary and only same-run/URL missing-score or repair
diagnostics are fsynced to `<state-dir>/deleted/` before the delete transaction.
The transaction records the archive hash, deletion policy, optional evidence hash and minimal publication
identity in `admin_actions`; source/body is removed from the business database.
Other diagnostics at the same URL remain independent. Original backup and archive
files must remain available; no backup retention cleanup runs during deployment.

Failures have precise source/model/DB codes and a durable audit outbox. Retry
starts at five minutes, doubles to at most one day, and stops at five attempts;
404/410/oversize stop at three. Source rate limits and model quota pause for one
hour. A restart defers an interrupted attempt with unknown outcome and retains its
call reservation. Blocked items require an explicit Admin requeue with a reason:

The allowance belongs to the existing summary ID. `updatedAt` is a conditional-write
token, not a new retry allowance: display cleanup, bookmarks and other row edits
preserve attempts, cooldown, terminal state and cumulative model reservations.
Only an explicit audited Admin requeue resets attempts, retaining previous state
and cumulative usage; it also verifies the backup gate.

Safe-fetch errors retain their original code without raw exception text or
credentials. Rejected media types and unsafe URLs stop immediately. Model HTTP
400/404/422 responses are explicit request-rejection failures requiring a corrected
request before Admin requeue; they do not consume repeated identical attempts.
Model 5xx, connection, timeout and open-circuit failures have distinct safe reasons;
configuration failures require correction before requeue. Each item failure records
its source/score/summary/write/delete phase. Unclassified internal failures retain
the exception class and code location for investigation without raw request text.
The 500-character diagnostic message remains valid JSON; full safe details stay
in the audit and durable checkpoint.

```sh
python -m scripts.repair_radar --actor <admin> --state-dir <path> --report
python -m scripts.repair_radar --actor <admin> --state-dir <path> --requeue <id> --reason '<new evidence or repaired cause>'
python -m scripts.repair_radar --actor <admin> --state-dir <path> --restore-archive <path>/deleted/<id>-<run>.json
python -m scripts.repair_radar --actor <admin> --state-dir <path> --rollback-audit <repair-apply-audit-id>
```

Stop the worker before requeue/restore. Restore verifies the archive against the
committed deletion audit and refuses any existing ID/URL; it restores the row and
archived diagnostics in one transaction and audits restoration. Ordinary repair
updates carry before/after fields and timestamps; rollback checks the recorded
post-write row and diagnostic fields/times and refuses later edits. The database check
`python -m scripts.verify_radar_repair --database governance_verify_<name>` is
restricted to an isolated restore and rolls back all synthetic fixtures.

Production uses the independent `deep-research-repair` Compose project from
`infra/docker-compose.radar-repair.yml`, sharing the existing network and persistent
volume. Set `RADAR_REPAIR_DIR` (verified-backup root) and `RADAR_REPAIR_ACTOR` in the
VPS environment. After the backup gate and pilot, `.radar-repair-enabled` makes
formal deploys update the worker to the same immutable image. Its restart policy
and checkpoint survive host/container replacement; main `--remove-orphans` cannot
remove the independent project. Inspect each unresolved item and public/referenced
paths before claiming that the backlog is cleared.

# Unified external reading and scoring (5.1)

Current reading tiers are `deep_read`（精读）、`skim`（速读）and `noise`.
The former `collection` tier is included in `deep_read`; personal bookmarks are
independent and remain unchanged. Readers accept the legacy tier and filters
as aliases during migration. New scoring never emits `collection`.

Version 5.1 preserves the numerical rubric of 5.0. Reading migration keeps every
existing numeric score, dimension and scoring version. It only merges the
`collection` label into `deep_read` and verifies the external reading path.
It does not relabel an old score as current or implicitly call a model.
Continuous repair also preserves valid scores. An explicit
`--review-legacy-noise` scope alone permits source-backed paid review of legacy
noise; retained legacy content is never included in that scoring scope.

```sh
python -m scripts.unify_radar --actor <real-admin> --state-dir <private-persistent-dir> --preview
python -m scripts.unify_radar --actor <real-admin> --state-dir <same-dir> --limit 10
python -m scripts.unify_radar --actor <real-admin> --state-dir <same-dir> --limit 100
python -m scripts.unify_radar --actor <real-admin> --state-dir <same-dir> --rollback-audit <audit-id>
# Optional, separately authorized legacy-noise review; carry previous reservations:
python -m scripts.unify_radar --actor <real-admin> --state-dir <new-dir> --review-legacy-noise --previous-state <stopped-dir>/state.json --preview
```

The immutable preview captures row fingerprints and references. Execution needs
the verified independent backup receipt, a real Admin, row-version comparison
and same-transaction audit. It uses one source/model operation at a time and at
most two reserved model calls per explicitly selected legacy-noise item, including format retries and
brief completion. Reservations and responses persist before applying changes;
reruns reuse recorded responses, uncertain calls remain unresolved, and quota
errors stop further model work. Previous per-item reservations are carried into
a replacement batch; budgets from other repair scopes are untouched. Default
reading-only migration has a zero model-call budget.

Legacy server reading changes to external reading only after a safe live read
matches the publication identity. Cached originals and review outcomes remain
historical evidence. Cache replacement retains the old value in backup/audit.
Current noise without references uses the standing deletion policy; referenced
noise is archived with `reference_only_noise`, preserving direct citations.
Deletion retains historical diagnostics, and restore checks their later versions.
Unverified sources or model failures remain explicit unresolved items; the
migration does not grant a review pass or manufacture a score.
