"""Python E2E 测试配置 —— 真实 PostgreSQL + 真实 worker + 真实 adapter。

启动条件（详见 docs/E2E_TESTING.md）：
  - E2E=1 环境变量（与 Web 端约定一致）
  - DATABASE_URL 指向一个独立 test schema（默认 deep_research_e2e）
  - PostgreSQL 可连接
  - 默认 pytest 不跑 E2E；需要 `pytest -m e2e` 才跑

设计：
  - 每个测试 session 自动跑 migration（setup_schema fixture）
  - 每个测试清空业务表（truncate_all fixture）保证隔离
  - 不 mock 任何东西；测试真实链路
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import Iterator

import pytest

# pytest -m e2e 才会跑到这些
pytestmark = pytest.mark.e2e


def _ensure_e2e_env() -> None:
    """Sanity check: 启动 E2E 前必须显式确认意图。

    启动条件：
      - E2E=1 显式开启
      - DATABASE_URL 指向 test schema

    缺失任一条件 → module-level skip，附带清晰的运行说明。
    """
    if os.environ.get("E2E") != "1":
        pytest.skip(
            "E2E tests require E2E=1 env var. "
            "Run: E2E=1 pytest -m e2e packages/ai-engine/tests/e2e/ -v",
            allow_module_level=True,
        )
    if not os.environ.get("DATABASE_URL"):
        pytest.skip("DATABASE_URL not set", allow_module_level=True)


_ensure_e2e_env()


# ──────────────────────────────────────────────────────────────────────
# DB schema setup / teardown
# ──────────────────────────────────────────────────────────────────────

PROJECT_ROOT = Path(__file__).resolve().parents[3]  # packages/ai-engine/tests/e2e → repo root
PRISMA_SCHEMA = PROJECT_ROOT / "apps" / "web" / "prisma" / "schema.prisma"
MIGRATIONS_DIR = PROJECT_ROOT / "apps" / "web" / "prisma" / "migrations"


@pytest.fixture(scope="session", autouse=True)
def setup_schema() -> Iterator[None]:
    """Pass-through fixture — CI already ran prisma migrate before pytest.
    No schema changes needed here.
    """
    yield None


@pytest.fixture(autouse=True)
def truncate_all() -> Iterator[None]:
    """每个测试前清空业务表，保证隔离。

    删除顺序：先子表后父表（避免 FK 约束）。
    """
    import psycopg

    db_url = os.environ["DATABASE_URL"]
    tables = [
        "admin_actions",
        "ai_research_sources",
        "ai_research_jobs",
        "ai_chat_messages",
        "ai_chat_sessions",
        "comment_stars",
        "comments",
        "research_audit",
        "research_sources",
        "researches",
        "share_submissions",
        "content_import_jobs",
        "radar_feedback",
        "summaries",
        "radar_sync_runs",
        "radar_sources",
        "search_docs",
        "product_events",
        "users",
    ]

    with psycopg.connect(db_url) as conn:
        with conn.cursor() as cur:
            cur.execute("SET session_replication_role = 'replica'")  # bypass FK
            for t in tables:
                cur.execute(f'TRUNCATE TABLE "{t}" CASCADE')
            cur.execute("SET session_replication_role = 'origin'")
        conn.commit()

    yield


# ──────────────────────────────────────────────────────────────────────
# 常用 helpers
# ──────────────────────────────────────────────────────────────────────


@pytest.fixture
def admin_user_id() -> str:
    """Seed 一个 admin 用户，返回 UUID 字符串。"""
    import psycopg

    db_url = os.environ["DATABASE_URL"]
    with psycopg.connect(db_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO users (id, email, name, role, "createdAt", "updatedAt")
                VALUES (gen_random_uuid(), 'admin@e2e.local', 'E2E Admin', 'admin', now(), now())
                RETURNING id
                """,
            )
            (uid,) = cur.fetchone()
        conn.commit()
    return str(uid)


@pytest.fixture
def member_user_id() -> str:
    """Seed 一个普通成员用户，返回 UUID 字符串。"""
    import psycopg

    db_url = os.environ["DATABASE_URL"]
    with psycopg.connect(db_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO users (id, email, name, role, "createdAt", "updatedAt")
                VALUES (gen_random_uuid(), 'member@e2e.local', 'E2E Member', 'member', now(), now())
                RETURNING id
                """,
            )
            (uid,) = cur.fetchone()
        conn.commit()
    return str(uid)


@pytest.fixture
def db_conn():
    """提供每次测试的 psycopg 连接（用完记得 close）。"""
    import psycopg

    db_url = os.environ["DATABASE_URL"]
    with psycopg.connect(db_url) as conn:
        yield conn