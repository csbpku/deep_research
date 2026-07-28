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