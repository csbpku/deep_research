"""Read-only PostgreSQL regression cases; no fixtures or database writes."""

import json
from pathlib import Path
from typing import Any

from ai_engine.radar.topic_eligibility import TOPIC_ELIGIBILITY_SQL


def assert_topic_eligibility_cases(conn: Any) -> int:
    score = json.loads((Path(__file__).resolve().parents[2] / 'shared/fixtures/radar-public-scores.json').read_text())[0]['row']['distilledScore']
    base = {
        "id": "00000000-0000-4000-8000-000000000001",
        "source": "daily", "status": "candidate", "distilledTier": "deep_read",
        "syncRunId": "00000000-0000-4000-8000-000000000002",
        "distilledScore": score, "tags": ["external_reading"],
        "canonicalUrl": "https://github.com/example/tool",
    }
    cases = [
        ({}, True),
        ({"status": "published"}, True),
        ({"distilledTier": "collection", "distilledScore": score | {"tier": "collection"}}, True),
        ({"status": "archived"}, False),
        ({"status": "rejected"}, False),
        ({"distilledTier": "noise"}, False),
        ({"distilledTier": "skim"}, False),
        ({"distilledScore": None}, False),
        ({"syncRunId": None}, False),
        ({"source": "user"}, False),
        ({"tags": []}, False),
        ({"tags": [], "enrichmentStatus": "ready", "readerQualityStatus": "ready",
          "contentReviewStatus": "approved"}, True),
        ({"tags": [], "enrichmentStatus": "ready", "readerQualityStatus": "ready",
          "contentReviewStatus": "needs_manual_review"}, False),
        ({"tags": ["external_reading", "repo_digest"]}, False),
        ({"originalKind": "github_issue"}, False),
        ({"canonicalUrl": "https://github.com/example/tool/pull/1"}, False),
        ({"canonicalUrl": "https://github.com/example/tool/releases/tag/v1"}, False),
    ]
    for changes, expected in cases:
        row = conn.execute(
            f'SELECT {TOPIC_ELIGIBILITY_SQL} AS eligible '
            'FROM json_populate_record(NULL::summaries, %s::json) AS s',
            (json.dumps(base | changes),),
        ).fetchone()
        actual = row["eligible"] if isinstance(row, dict) else row[0]
        assert actual is expected, (changes, actual, expected)
    return len(cases)
