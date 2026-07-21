"""DB-backed job runner (Week 1 skeleton).

The Week 1 goal is to *expose the contract* that the Week 5 worker and the
HTTP layer depend on. The actual `FOR UPDATE SKIP LOCKED` query and the
psycopg transaction body are intentionally left as TODO; implementing them
in Week 1 would require a real DB (which lives in `apps/web/prisma/` —
out of B's scope) and risks drift from the schema freeze.

What we DO provide in Week 1:
- A Protocol describing the runner surface (`acquire_next_job`,
  `heartbeat`, `release_lease`, `run_once`).
- A pure-Python in-memory implementation (`InMemoryJobStore`) backed by
  the fake adapter — used by the spike harness and tests.
- A factory that selects between `db` (TODO) and `memory` based on the
  `JOB_RUNNER_BACKEND` env var. Default: `memory` so tests and `pnpm dev:ai`
  run without a DB.

Week 5 will:
- Add `psycopg`-backed `acquire_next_job` using `SELECT ... FOR UPDATE SKIP LOCKED`.
- Wire heartbeat/lease into the reaper loop.
- Persist token totals, cost cents, current_step, partial_sources and
  `draft_research_id` on `succeeded`.
"""

from ai_engine.job_runner.models import (
    HeartbeatResult,
    JobLease,
    JobSnapshot,
    LeaseLostError,
    RunnerHooks,
)
from ai_engine.job_runner.store import (
    InMemoryJobStore,
    JobStore,
    build_store,
)

__all__ = [
    "HeartbeatResult",
    "JobLease",
    "JobSnapshot",
    "JobStore",
    "LeaseLostError",
    "RunnerHooks",
    "InMemoryJobStore",
    "build_store",
]