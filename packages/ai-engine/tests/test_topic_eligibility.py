"""Gate regression tests opt into an explicitly supplied test database."""

import os
from pathlib import Path

import psycopg
import pytest

from .topic_eligibility_cases import assert_topic_eligibility_cases
from ai_engine.radar.score_validity import RADAR_PUBLIC_SCORE_SQL
from ai_engine.radar.topic_eligibility import TOPIC_ELIGIBILITY_SQL


def test_web_topic_gate_matches_pipeline() -> None:
    root = Path(__file__).resolve().parents[3]
    source = (root / 'apps/web/src/lib/radar/topic-eligibility.ts').read_text()
    template = source.split('TOPIC_ELIGIBILITY_SQL = `', 1)[1].split('`;', 1)[0]
    assert template.replace('${RADAR_PUBLIC_SCORE_SQL}', RADAR_PUBLIC_SCORE_SQL) == (
        TOPIC_ELIGIBILITY_SQL.replace('%%', '%')
    )


def test_topic_eligibility_postgres() -> None:
    url = os.environ.get("TEST_TOPIC_DATABASE_URL")
    if not url:
        pytest.skip("set TEST_TOPIC_DATABASE_URL for read-only PostgreSQL cases")
    with psycopg.connect(url, options="-c default_transaction_read_only=on") as conn:
        assert assert_topic_eligibility_cases(conn) == 17
