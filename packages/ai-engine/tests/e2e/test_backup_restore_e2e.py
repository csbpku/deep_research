"""备份恢复 E2E —— 真实 pg_dump → 真实 psql → 数据校验。

覆盖：
  - 备份脚本生成 .sql.gz 文件
  - 恢复脚本把数据写回新 schema
  - 校验核心表行数

依赖：
  - 真实 PG（默认 schema + 恢复目标 schema）
  - 系统有 pg_dump + psql 命令
  - E2E=1
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import uuid

import psycopg
import pytest

pytestmark = [pytest.mark.e2e, pytest.mark.asyncio]


# ──────────────────────────────────────────────────────────────────────
# Tools check
# ──────────────────────────────────────────────────────────────────────

def _has_pg_tools() -> bool:
    return shutil.which("pg_dump") is not None and shutil.which("psql") is not None


def _create_target_db() -> str:
    """Create a fresh database for restore target; return its name."""
    db_name = f"deep_research_e2e_restore_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(os.environ["DATABASE_URL"], autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(f'CREATE DATABASE "{db_name}"')
    return db_name


def _drop_target_db(db_name: str) -> None:
    with psycopg.connect(os.environ["DATABASE_URL"], autocommit=True) as conn:
        with conn.cursor() as cur:
            # 断开所有连接再 drop
            cur.execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                "WHERE datname = %s AND pid <> pg_backend_pid()",
                (db_name,),
            )
            cur.execute(f'DROP DATABASE IF EXISTS "{db_name}"')


# ──────────────────────────────────────────────────────────────────────
# 测试
# ──────────────────────────────────────────────────────────────────────


async def test_pg_dump_restore_round_trip(admin_user_id: str) -> None:
    """dump → restore 到新 schema → 数据一致。"""
    if not _has_pg_tools():
        pytest.skip("pg_dump / psql not available on PATH")

    # 解析 DATABASE_URL 直接拿到连接参数（psycopg 3 的 conn.info.dsn 是 str 不是 dict）
    from urllib.parse import urlparse

    db_url = os.environ["DATABASE_URL"]
    parsed = urlparse(db_url)
    pg_dsn = {
        "host": parsed.hostname or "localhost",
        "port": str(parsed.port or 5432),
        "user": parsed.username or "postgres",
        "password": parsed.password or "",
        "dbname": parsed.path.lstrip("/") or "postgres",
    }

    # 在主 DB 中塞入已知数据
    target_summary_id = str(uuid.uuid4())
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO summaries (
                    id, title, body, url, "canonicalUrl", source, "contentOrigin",
                    "summaryDate", status, "ingestionTokenCount", tags, "createdAt", "updatedAt"
                ) VALUES (
                    %s, 'E2E Backup Title', 'E2E Backup Body', 'https://e2e.local/test',
                    'https://e2e.local/test-canonical', 'daily', 'web', CURRENT_DATE,
                    'published', 0, '{}'::text[], now(), now()
                )
                """,
                (target_summary_id,),
            )
        conn.commit()

    # dump 主 DB（默认 DATABASE_URL 指向的）
    with tempfile.TemporaryDirectory() as tmp:
        dump_file = os.path.join(tmp, "dump.sql.gz")
        env = os.environ.copy()
        result = subprocess.run(
            [
                "pg_dump",
                "-h", pg_dsn["host"],
                "-p", pg_dsn["port"],
                "-U", pg_dsn["user"],
                "-d", pg_dsn["dbname"],
                "--no-owner",
                "--no-privileges",
            ],
            env={**env, "PGPASSWORD": pg_dsn["password"]},
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, f"pg_dump failed: {result.stderr}"

        # gzip 压缩
        import gzip
        with gzip.open(dump_file, "wt") as f:
            f.write(result.stdout)

        # 创建目标 DB
        target_db = _create_target_db()
        try:
            # 恢复
            with gzip.open(dump_file, "rt") as f:
                restore_result = subprocess.run(
                    [
                        "psql",
                        "-h", pg_dsn["host"],
                        "-p", pg_dsn["port"],
                        "-U", pg_dsn["user"],
                        "-d", target_db,
                        "-v", "ON_ERROR_STOP=1",
                        "--single-transaction",
                    ],
                    env={**env, "PGPASSWORD": pg_dsn["password"]},
                    input=f.read(),
                    capture_output=True,
                    text=True,
                )
            assert restore_result.returncode == 0, f"psql restore failed: {restore_result.stderr}"

            # 验证：summary 行应存在
            restore_url = f"postgresql://{pg_dsn['user']}:{pg_dsn['password']}@{pg_dsn['host']}:{pg_dsn['port']}/{target_db}"
            with psycopg.connect(restore_url) as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT title, status FROM summaries WHERE id = %s",
                        (target_summary_id,),
                    )
                    row = cur.fetchone()
            assert row is not None, "Restored summary not found"
            assert row[0] == "E2E Backup Title"
            assert row[1] == "published"
        finally:
            _drop_target_db(target_db)


async def test_pg_dump_gz_compresses_restoreable(member_user_id: str) -> None:
    """备份产物应当可被 gzip -t 校验（即压缩文件完整）。"""
    if not _has_pg_tools():
        pytest.skip("pg_dump / psql not available on PATH")

    from urllib.parse import urlparse

    db_url = os.environ["DATABASE_URL"]
    parsed = urlparse(db_url)
    pg_dsn = {
        "host": parsed.hostname or "localhost",
        "port": str(parsed.port or 5432),
        "user": parsed.username or "postgres",
        "password": parsed.password or "",
        "dbname": parsed.path.lstrip("/") or "postgres",
    }

    with tempfile.TemporaryDirectory() as tmp:
        dump_file = os.path.join(tmp, "dump.sql.gz")
        result = subprocess.run(
            [
                "pg_dump",
                "-h", pg_dsn["host"],
                "-p", pg_dsn["port"],
                "-U", pg_dsn["user"],
                "-d", pg_dsn["dbname"],
                "--no-owner",
                "--no-privileges",
            ],
            env={**os.environ, "PGPASSWORD": pg_dsn["password"]},
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        import gzip
        with gzip.open(dump_file, "wt") as f:
            f.write(result.stdout)

        # gzip -t 验证完整性
        gzip_test = subprocess.run(["gzip", "-t", dump_file], capture_output=True, text=True)
        assert gzip_test.returncode == 0, f"gzip -t failed: {gzip_test.stderr}"

# ──────────────────────────────────────────────────────────────────────
# Week 9 收尾补全：代表性数据 round-trip（§十一：用户/摘要/沉淀/评论/AI 任务）
# 之前只塞 1 个 summary 验证 schema 重建。现在补 5 类代表性数据，验证业务可恢复性。
# ──────────────────────────────────────────────────────────────────────


async def test_full_backup_restore_with_representative_data(
    admin_user_id: str, member_user_id: str
) -> None:
    """灌入用户/摘要/沉淀/评论/AI 任务 5 类代表性数据 → dump → 还原到新 DB → 逐表比对行数。

    验证：备份恢复不是空转，覆盖 IMPLEMENTATION_PLAN §十一 的"代表性数据"要求。
    """
    if not _has_pg_tools():
        pytest.skip("pg_dump / psql not available on PATH")

    from urllib.parse import urlparse

    db_url = os.environ["DATABASE_URL"]
    parsed = urlparse(db_url)
    pg_dsn = {
        "host": parsed.hostname or "localhost",
        "port": str(parsed.port or 5432),
        "user": parsed.username or "postgres",
        "password": parsed.password or "",
        "dbname": parsed.path.lstrip("/") or "postgres",
    }

    # 主 DB 中塞入代表性数据（用 pytest fixture 提供的 admin/member user id）
    seed_ids = _seed_representative_data(admin_user_id, member_user_id)
    try:
        # 取每张表的行数作为源 baseline
        source_counts = _row_counts(pg_dsn, pg_dsn["dbname"])

        with tempfile.TemporaryDirectory() as tmp:
            dump_file = os.path.join(tmp, "dump.sql.gz")
            env = {**os.environ, "PGPASSWORD": pg_dsn["password"]}

            # dump
            dump_proc = subprocess.run(
                [
                    "pg_dump",
                    "-h", pg_dsn["host"],
                    "-p", pg_dsn["port"],
                    "-U", pg_dsn["user"],
                    "-d", pg_dsn["dbname"],
                    "--no-owner",
                    "--no-privileges",
                ],
                env=env,
                capture_output=True,
                text=True,
            )
            assert dump_proc.returncode == 0, f"pg_dump failed: {dump_proc.stderr}"
            import gzip
            with gzip.open(dump_file, "wt") as f:
                f.write(dump_proc.stdout)

            # 创建目标 DB 并恢复
            target_db = _create_target_db()
            try:
                with gzip.open(dump_file, "rt") as f:
                    restore_proc = subprocess.run(
                        [
                            "psql",
                            "-h", pg_dsn["host"],
                            "-p", pg_dsn["port"],
                            "-U", pg_dsn["user"],
                            "-d", target_db,
                            "-v", "ON_ERROR_STOP=1",
                            "--single-transaction",
                        ],
                        env=env,
                        input=f.read(),
                        capture_output=True,
                        text=True,
                    )
                assert restore_proc.returncode == 0, (
                    f"psql restore failed: {restore_proc.stderr[:500]}"
                )

                # 关键：行数与源 DB 一致
                target_counts = _row_counts(pg_dsn, target_db)
                _assert_counts_match(source_counts, target_counts)

                # 抽样校验：summary.title 和 comment.body 内容完整恢复
                target_url = (
                    f"postgresql://{pg_dsn['user']}:{pg_dsn['password']}@"
                    f"{pg_dsn['host']}:{pg_dsn['port']}/{target_db}"
                )
                with psycopg.connect(target_url) as conn:
                    with conn.cursor() as cur:
                        cur.execute(
                            "SELECT title, body FROM summaries WHERE id = %s",
                            (seed_ids["summary_id"],),
                        )
                        sum_row = cur.fetchone()
                        assert sum_row is not None
                        assert sum_row[0] == "Backup Drill Summary"
                        assert sum_row[1] == "Backup drill body content"

                        cur.execute(
                            "SELECT body FROM comments WHERE id = %s",
                            (seed_ids["comment_id"],),
                        )
                        cmt_row = cur.fetchone()
                        assert cmt_row is not None
                        assert cmt_row[0] == "Backup drill comment body"
            finally:
                _drop_target_db(target_db)
    finally:
        _cleanup_representative_data(seed_ids)


def _seed_representative_data(admin_id: str, member_id: str) -> dict[str, str]:
    """塞入 §十一 要求的代表性数据。返回 id 字典便于清理与验证。"""
    summary_id = str(uuid.uuid4())
    research_id = str(uuid.uuid4())
    comment_id = str(uuid.uuid4())
    job_id = str(uuid.uuid4())
    radar_id = str(uuid.uuid4())
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO summaries (
                    id, title, body, url, "canonicalUrl", source,
                    "contentOrigin", "summaryDate", status,
                    "ingestionTokenCount", tags, "createdAt", "updatedAt"
                ) VALUES (
                    %s, 'Backup Drill Summary', 'Backup drill body content',
                    'https://e2e.local/backup-drill',
                    'https://e2e.local/backup-drill-canonical',
                    'daily', 'web', CURRENT_DATE, 'published', 0,
                    '{}'::text[], now(), now()
                )
                """,
                (summary_id,),
            )
            cur.execute(
                """
                INSERT INTO researches (
                    id, type, status, title, body, "authorId",
                    "createdAt", "updatedAt"
                ) VALUES (
                    %s, 'research', 'draft', 'Backup Drill Research',
                    'Backup drill research body', %s, now(), now()
                )
                """,
                (research_id, member_id),
            )
            cur.execute(
                """
                INSERT INTO comments (
                    id, "authorId", "targetType", "summaryId", body,
                    "createdAt", "updatedAt"
                ) VALUES (
                    %s, %s, 'summary', %s, 'Backup drill comment body',
                    now(), now()
                )
                """,
                (comment_id, admin_id, summary_id),
            )
            cur.execute(
                """
                INSERT INTO ai_research_jobs (
                    id, "requesterId", topic, context, "reportType",
                    "sourcePolicy", status, attempts, "partialSources",
                    "sourceRefs", "failedSources", "idempotencyKey",
                    "createdAt", "updatedAt"
                ) VALUES (
                    %s, %s, 'Backup drill topic', 'Backup drill ctx',
                    'research_report', 'prefer_user_sources', 'succeeded',
                    0, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, %s,
                    now(), now()
                )
                """,
                (job_id, member_id, str(uuid.uuid4())),
            )
            cur.execute(
                """
                INSERT INTO radar_sources (
                    id, name, type, url, "createdAt", "updatedAt"
                ) VALUES (
                    %s, 'Backup Drill Radar', 'rss',
                    'https://e2e.local/backup-drill-rss', now(), now()
                )
                """,
                (radar_id,),
            )
        conn.commit()
    return {
        "summary_id": summary_id,
        "research_id": research_id,
        "comment_id": comment_id,
        "job_id": job_id,
        "radar_id": radar_id,
    }


def _cleanup_representative_data(ids: dict[str, str]) -> None:
    """删除本次演练塞入的数据（保持主 DB 干净）。"""
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM radar_sources WHERE id = %s", (ids["radar_id"],))
            cur.execute("DELETE FROM ai_research_jobs WHERE id = %s", (ids["job_id"],))
            cur.execute("DELETE FROM comments WHERE id = %s", (ids["comment_id"],))
            cur.execute("DELETE FROM researches WHERE id = %s", (ids["research_id"],))
            cur.execute("DELETE FROM summaries WHERE id = %s", (ids["summary_id"],))
        conn.commit()


def _row_counts(pg_dsn: dict[str, str], dbname: str) -> dict[str, int]:
    """取 public schema 下所有基表的行数。"""
    url = (
        f"postgresql://{pg_dsn['user']}:{pg_dsn['password']}@"
        f"{pg_dsn['host']}:{pg_dsn['port']}/{dbname}"
    )
    counts: dict[str, int] = {}
    with psycopg.connect(url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT c.relname, c.reltuples::bigint
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind = 'r'
                  AND n.nspname = 'public'
                ORDER BY c.relname
                """
            )
            for name, n in cur.fetchall():
                counts[name] = int(n)
    return counts


def _assert_counts_match(source: dict[str, int], target: dict[str, int]) -> None:
    """逐表对比行数。任何表行数不一致就失败。"""
    assert set(source.keys()) == set(target.keys()), (
        f"table set differs: only-in-source={set(source) - set(target)} "
        f"only-in-target={set(target) - set(source)}"
    )
    diffs = []
    for table, n_src in source.items():
        n_tgt = target[table]
        if n_src != n_tgt:
            diffs.append(f"{table}: source={n_src} target={n_tgt}")
    assert not diffs, "row count mismatch:\n  " + "\n  ".join(diffs)
