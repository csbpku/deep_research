"""The same cases exercise Python, Web and the actual PostgreSQL gate."""
import json
import math
import os
from pathlib import Path
from typing import Any

import psycopg
import pytest

from ai_engine.radar.score_validity import RADAR_PUBLIC_SCORE_SQL, has_public_radar_score

ROOT = Path(__file__).resolve().parents[3]
CASES = json.loads((ROOT / 'packages/shared/fixtures/radar-public-scores.json').read_text())


@pytest.mark.parametrize('case', CASES, ids=[case['name'] for case in CASES])
def test_public_score_contract(case: dict[str, Any]) -> None:
    assert has_public_radar_score(case['row']) is case['expected']


@pytest.mark.parametrize('value', [math.nan, math.inf, -math.inf])
def test_nonfinite_total(value: float) -> None:
    row = json.loads(json.dumps(CASES[0]['row']))
    row['distilledScore']['total'] = value
    assert not has_public_radar_score(row)


def test_sql_mirror() -> None:
    source = (ROOT / 'apps/web/src/lib/radar/score-validity.ts').read_text()
    assert source.split('String.raw`', 1)[1].split('`;', 1)[0] == RADAR_PUBLIC_SCORE_SQL


def assert_public_score_postgres(conn: Any) -> int:
    for case in CASES:
        result = conn.execute(
            f'SELECT {RADAR_PUBLIC_SCORE_SQL} AS eligible '
            'FROM json_populate_record(NULL::summaries, %s::json) AS s',
            (json.dumps(case['row']),),
        ).fetchone()
        actual = result['eligible'] if isinstance(result, dict) else result[0]
        assert actual is case['expected'], (case['name'], actual, case['expected'])
    return len(CASES)


def test_public_score_postgres() -> None:
    url = os.environ.get('TEST_TOPIC_DATABASE_URL')
    if not url:
        pytest.skip('set TEST_TOPIC_DATABASE_URL for read-only PostgreSQL cases')
    with psycopg.connect(url, options='-c default_transaction_read_only=on') as conn:
        assert assert_public_score_postgres(conn) == len(CASES)
