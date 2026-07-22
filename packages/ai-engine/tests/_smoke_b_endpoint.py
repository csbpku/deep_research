"""一次性 B 端到端 smoke test:W2 review 验证 AI endpoint 真接 DB runner。

启动 uvicorn 在子进程,JOB_RUNNER_BACKEND=db,POST 一个 job 后立刻 GET。
要求 POST 写入的 job id 在 GET 时可见(同一进程同一 store instance)。

跑法:
  cd packages/ai-engine
  set -a && source .env && set +a
  JOB_RUNNER_BACKEND=db uv run python tests/_smoke_b_endpoint.py
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

import httpx


def _wait_health(port: int, timeout: float = 15.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            r = httpx.get(f"http://127.0.0.1:{port}/healthz", timeout=1.0)
            if r.status_code == 200:
                return True
        except Exception:
            time.sleep(0.3)
    return False


def _create_user_and_research() -> tuple[str, str]:
    """预先在 DB 创建 user + research,async pg 客户端直连。
    返回 (user_id, research_id)。smoke 不清理(留给手工或后续脚本)。
    """
    import psycopg
    dsn = os.environ["DATABASE_URL"]
    user_id = str(uuid.uuid4())
    research_id = str(uuid.uuid4())
    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(
                'INSERT INTO "users" ("id", "email", "name", "role", "createdAt", "updatedAt") '
                "VALUES (%s, %s, %s, 'member', now(), now())",
                (user_id, f"{user_id[:8]}@smoke.local", "smoke"),
            )
            cur.execute(
                'INSERT INTO "researches" ("id", "type", "status", "title", "body", "authorId", "createdAt", "updatedAt") '
                "VALUES (%s, 'research', 'draft', %s, 'smoke body', %s, now(), now())",
                (research_id, f"smoke title {research_id[:8]}", user_id),
            )
    return user_id, research_id


def main() -> None:
    dsn = os.environ["DATABASE_URL"]
    user_id, research_id = _create_user_and_research()
    print(f"[setup] user={user_id[:8]} research={research_id[:8]}")

    port = 14001
    env = os.environ.copy()
    env["JOB_RUNNER_BACKEND"] = "db"
    # W2 review 修正:fake 的 succeeded 路径要求 caller 传 draft_research_id,
    # 否则 mark_terminal 抛 ValueError。B smoke 只验证 process-level store
    # (POST 入 DB 后 GET 能读到),用 fake + 短超时让 job 走 failed 路径。
    # 真 succeeded 路径在 W3 由 Claude adapter 自己 INSERT research + 传 id。
    env["AI_ENGINE_ADAPTER"] = "fake"
    env["AI_ENGINE_TEST_FAST_POLL"] = "1"
    env["DATABASE_URL"] = dsn

    proc = subprocess.Popen(
        [
            sys.executable, "-m", "uvicorn",
            "ai_engine.server.app:app",
            "--host", "127.0.0.1", "--port", str(port),
            "--log-level", "warning",
        ],
        env=env,
        cwd=str(Path(__file__).resolve().parent.parent),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    try:
        if not _wait_health(port):
            print("[FAIL] uvicorn never reached /healthz")
            sys.exit(1)
        print(f"[OK] uvicorn ready on :{port}")

        # 1. POST 一个 AI job
        r = httpx.post(
            f"http://127.0.0.1:{port}/api/ai/jobs",
            json={
                "job_id": str(uuid.uuid4()),
                "requester_id": user_id,
                "topic": "B-smoke topic",
                "context": "B-smoke context",
                "source_policy": "prefer_user_sources",
                "report_type": "research_report",
            },
            timeout=5.0,
        )
        assert r.status_code == 202, f"POST status={r.status_code} body={r.text}"
        body = r.json()
        posted_id = body["job_id"]
        assert body["status"] == "queued"
        print(f"[OK] POST returned 202 + queued, job_id={posted_id[:8]}")

        # 2. GET 同一个 job — 必须能看见(process-level store)
        r = httpx.get(f"http://127.0.0.1:{port}/api/ai/jobs/{posted_id}", timeout=5.0)
        assert r.status_code == 200, f"GET status={r.status_code} body={r.text}"
        body = r.json()
        assert body["job_id"] == posted_id
        assert body["final_status"] in ("queued", "running", "succeeded", "partial", "failed")
        print(f"[OK] GET saw job (final_status={body['final_status']}) — process-level store works")

        # 3. 直接查 DB 看 row 是否真在
        import psycopg
        with psycopg.connect(dsn) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT id, status, \"partialSources\" FROM ai_research_jobs WHERE id = %s", (posted_id,))
                row = cur.fetchone()
                assert row is not None, "job row not in DB"
                print(f"[OK] DB row exists: id={row[0][:8]} status={row[1]} partialSources_count={len(row[2])}")
                # W2 review 修正后,partialSources 应该是 adapter 真给(>=1 on succeeded),
                # 不是 db_store 自造 _sentinel。
                if row[1] == "succeeded":
                    sources = row[2]
                    assert isinstance(sources, list), f"sources must be list, got {type(sources)}"
                    assert len(sources) >= 1, f"succeeded needs >=1 source, got {len(sources)}"
                    for s in sources:
                        # 不应有 _sentinel 标记
                        assert "_sentinel" not in (s or {}), f"_sentinel leaked into sources: {s}"
                    print(f"[OK] succeeded has {len(sources)} real source(s), no _sentinel")

        print("\n=== ALL B-SMOKE CHECKS PASSED ===")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    main()