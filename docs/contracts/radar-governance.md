# Radar governance

Admin-only `POST /api/admin/radar/governance` accepts `mode` (`preview`, `report`,
`apply`, `recover`, `rollback`), optional `batchId`, and `limit` (1–100). The BFF
supplies the session identity; the internal engine checks the real database Admin
and batch owner again. Existing single-item governance remains available.

No schema change or physical deletion is involved. Preview fixes a server-owned
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

SSH maintenance uses the same core:

```sh
python scripts/govern_radar.py preview --actor <real-admin-email>
python scripts/govern_radar.py apply --actor <real-admin-email> --batch <uuid> --limit 10
python scripts/govern_radar.py recover --actor <real-admin-email> --batch <uuid> --limit 1
python scripts/govern_radar.py report --actor <real-admin-email> --batch <uuid>
python scripts/govern_radar.py rollback --actor <real-admin-email> --batch <uuid> --limit 100
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
deterministic oversized/missing-source failures for the same publication identity,
sync stops automatic attempts. A new publication identity permits new attempts.
Noise and unassessable results retain different reasons.

After execution, export the plan, audits/results, fresh statistics, call counts,
unresolved/deferred lists, and verify public radar/search/topics/references. A
24-hour review is read-only and reports recurrence rather than silently repairing it.
