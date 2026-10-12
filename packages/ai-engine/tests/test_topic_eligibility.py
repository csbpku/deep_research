"""Gate regression tests opt into an explicitly supplied test database."""

import os

import psycopg
import pytest

from .topic_eligibility_cases import assert_topic_eligibility_cases


def test_topic_eligibility_postgres() -> None:
    url = os.environ.get("TEST_TOPIC_DATABASE_URL")
    if not url:
        pytest.skip("set TEST_TOPIC_DATABASE_URL for read-only PostgreSQL cases")
    with psycopg.connect(url, options="-c default_transaction_read_only=on") as conn:
        assert assert_topic_eligibility_cases(conn) == 17
