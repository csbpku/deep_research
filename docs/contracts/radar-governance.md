# Radar governance

Every-row quality requirements and the read-only inspection command are defined
in [the radar quality checklist](./radar-quality-checklist.md). Structural completeness,
source evidence, and public eligibility remain separate results.

Admin-only `POST /api/admin/radar/governance` accepts `mode` (`preview`, `report`,
`apply`, `recover`, `rollback`), optional `batchId`, and `limit` (1–100). The BFF
supplies the session identity; the internal engine checks the real database Admin
and batch owner again. Existing single-item governance remains available.

This batch API changes no schema and performs no physical deletion. The separate
opt-in continuous repair command below supports confirmed-noise deletion.
Preview fixes a server-owned
inventory, evidence, protections, before/after fields and timestamps. Duplicate
titles are review suggestions only. Apply uses at most 100 operations per atomic
transaction, locks target rows, checks snapshot values and `updatedAt`, rechecks
references for noise, and writes `admin_actions` in the same transaction. Start
with a 10-operation pilot. A shared batch lock serializes apply/recover/rollback.

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
support a limited-evidence score but never prove deletion eligibility.
Brief repair writes only the missing summary or judgement fields. A valid existing
summary, judgement or score is preserved when another field needs recovery.
Valid scored noise is excluded from brief completion and content-completeness
statistics. It proceeds directly to deletion/protection/evidence disposition;
the same complete-source, current-score and reference guards still apply.
Each attempt reserves at most two single-attempt model calls, and writes score
and summary separately so a later summary failure cannot discard a score.
Summary evidence options are extracted verbatim from the source; the model may
select an integer index or supply a direct quote. Both paths must match the actual
source, allowing only layout whitespace differences. Invalid/missing evidence,
invalid JSON or short summaries remain explicit failures. A completion checkpoint
is accepted only while a valid score and usable summary/judgement are present.

GitHub repository evidence prefers the README API. API rate limiting cools that
API for one hour within the running worker while allowing same-repository public
raw `HEAD/README.md`, `README.rst`, or `README` reads. Both hosts use bounded safe
fetches without redirects; raw HTML/error pages and identity mismatches are
rejected. An unresolved path during API cooldown records
`SOURCE_GITHUB_API_RATE_LIMITED` for that repository with a one-hour retry delay;
it does not pause other repositories' raw reads. Actual raw-host rate limiting
still pauses the source. A missing conventional path does not prove there is no README. Only a
fully read source of at most 18,000 characters can prove completeness; larger
sources remain limited evidence. No source body is persisted by this fallback.

`--delete-confirmed-noise` requires complete source proof, a current valid noise
score and its verbatim weak-point evidence, plus explicit user authorization for
production deletion. Production leaves deletion disabled by default; after that
authorization, explicitly set `RADAR_REPAIR_DELETE_CONFIRMED_NOISE=1` in the VPS environment.
A generic HTML article container is
not completeness proof. User notes, shares, bookmarks, annotations, manually pinned repositories and research/
chat/topic references protect the row. Reference tables are locked during the
final check. The full summary and only same-run/URL missing-score or repair
diagnostics are fsynced to `<state-dir>/deleted/` before the delete transaction.
The transaction records the archive hash, evidence hash and minimal publication
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
