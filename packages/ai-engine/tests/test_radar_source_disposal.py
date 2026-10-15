from __future__ import annotations

import copy
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock

import pytest

from ai_engine.radar import repair as r
from ai_engine.radar.source_disposal import (
    SOURCE_DISPOSAL_ACTION,
    SOURCE_DISPOSAL_POLICY,
    source_disposal_eligible,
)


def candidate():
    row = {
        "id": "row",
        "source": "daily",
        "canonicalUrl": "https://example.org/article",
        "updatedAt": "stamp",
        "fingerprint": "full-row-fingerprint",
        "distilledScore": None,
        "title": "article",
        "body": "",
        "interpretation": "",
        "syncRunId": "source-run",
    }
    proof = {
        "id": "row",
        "updatedAt": "stamp",
        "fingerprint": row["fingerprint"],
        "checkedAt": 1000,
        "status": "unavailable",
        "errorCode": "SOURCE_HTTP_403",
        "prior": {
            "status": "blocked",
            "attempts": 5,
            "errorCode": "SOURCE_HTTP_403",
            "observedUpdatedAt": "stamp",
        },
    }
    return row, proof


@pytest.mark.parametrize(
    "code",
    ["SOURCE_HTTP_403", "SOURCE_HTTP_404", "SOURCE_HTTP_401", "SOURCE_INSUFFICIENT", "URL_FETCH_BLOCKED"],
)
def test_terminal_source_history_and_fresh_exact_snapshot_are_eligible(code):
    row, proof = candidate()
    proof["errorCode"] = code
    assert source_disposal_eligible(row, proof, incomplete=True, now=1010)


@pytest.mark.parametrize(
    "code",
    [
        "MODEL_UNASSESSABLE",
        "MODEL_REQUEST_REJECTED",
        "SOURCE_RATE_LIMITED",
        "SOURCE_GITHUB_API_RATE_LIMITED",
        "SOURCE_README_PATH_UNVERIFIED",
        "URL_FETCH_TOO_LARGE",
        "SOURCE_HTTP_503",
        "ATTEMPT_TIMEOUT",
    ],
)
def test_model_transient_and_implementation_limits_are_retained(code):
    row, proof = candidate()
    proof["errorCode"] = code
    assert not source_disposal_eligible(row, proof, incomplete=True, now=1010)


@pytest.mark.parametrize(
    "changed",
    [
        "version",
        "fingerprint",
        "id",
        "history_version",
        "history_status",
        "history_attempts",
        "history_model",
        "freshness",
        "future",
        "complete",
        "share",
    ],
)
def test_changed_stale_unproven_or_complete_records_cannot_be_deleted(changed):
    row, proof = candidate()
    incomplete = True
    if changed == "version":
        row["updatedAt"] = "later"
    elif changed == "fingerprint":
        row["fingerprint"] = "changed"
    elif changed == "id":
        proof["id"] = "another"
    elif changed == "history_version":
        proof["prior"]["observedUpdatedAt"] = "older"
    elif changed == "history_status":
        proof["prior"]["status"] = "pending"
    elif changed == "history_attempts":
        proof["prior"]["attempts"] = 0
    elif changed == "history_model":
        proof["prior"]["errorCode"] = "MODEL_TIMEOUT"
    elif changed == "freshness":
        proof["checkedAt"] = -86400
    elif changed == "future":
        proof["checkedAt"] = 2000
    elif changed == "complete":
        incomplete = False
    else:
        row["source"] = "share"
    assert not source_disposal_eligible(row, proof, incomplete=incomplete, now=1010)


def test_timeout_requires_repeated_observations():
    row, proof = candidate()
    proof["errorCode"] = "URL_FETCH_TIMEOUT"
    assert not source_disposal_eligible(row, proof, incomplete=True, now=1010)
    proof["checks"] = [{"errorCode": "URL_FETCH_TIMEOUT", "checkedAt": stamp} for stamp in (900, 1000)]
    assert source_disposal_eligible(row, proof, incomplete=True, now=1010)
    proof.pop("checks")
    proof["prior"].update(errorCode="URL_FETCH_TIMEOUT", attempts=3)
    assert source_disposal_eligible(row, proof, incomplete=True, now=1010)


def test_repeated_source_failures_can_be_disposed_during_backoff():
    row, proof = candidate()
    proof["prior"].update(status="retry_wait", attempts=2)
    assert not source_disposal_eligible(row, proof, incomplete=True, now=1010)
    proof["prior"]["attempts"] = 3
    assert source_disposal_eligible(row, proof, incomplete=True, now=1010)


@pytest.mark.parametrize("outcome", ["delete", "protected", "CAS", "model_error"])
async def test_mutation_checks_protection_CAS_and_archives_distinct_reason(tmp_path, monkeypatch, outcome):
    import time

    row, proof = candidate()
    proof["checkedAt"] = time.time()
    current = copy.deepcopy(row)
    if outcome == "CAS":
        current["updatedAt"] = "later"
    if outcome == "model_error":
        proof["errorCode"] = "MODEL_TIMEOUT"

    class Cursor:
        def __init__(self, value=None):
            self.value = value

        async def fetchone(self):
            return self.value

        async def fetchall(self):
            return []

    class Conn:
        def __init__(self):
            self.deleted = False

        @asynccontextmanager
        async def transaction(self):
            yield

        async def execute(self, query, params=None):
            text = query if isinstance(query, str) else query.as_string()
            if text.startswith("SELECT * FROM summaries"):
                return Cursor(current)
            if text.startswith("SELECT md5"):
                return Cursor({"fingerprint": row["fingerprint"]})
            if text.startswith("DELETE FROM summaries"):
                self.deleted = True
            return Cursor()

    conn = Conn()

    class Pool:
        @asynccontextmanager
        async def connection(self):
            yield conn

    audit = AsyncMock()
    monkeypatch.setattr(r.g, "verify_admin", AsyncMock(return_value="real-admin"))
    monkeypatch.setattr(
        r.g,
        "protected_ids",
        AsyncMock(return_value={"row": ["research_sources"]} if outcome == "protected" else {}),
    )
    monkeypatch.setattr(r, "audit", audit)
    if outcome in {"CAS", "model_error"}:
        with pytest.raises(r.RepairFailure):
            await r.mutate(
                Pool(),
                "actor",
                "run",
                row,
                {},
                None,
                delete=True,
                directory=tmp_path,
                deletion_policy=SOURCE_DISPOSAL_POLICY,
                source_failure=proof,
            )
    else:
        result = await r.mutate(
            Pool(),
            "actor",
            "run",
            row,
            {},
            None,
            delete=True,
            directory=tmp_path,
            deletion_policy=SOURCE_DISPOSAL_POLICY,
            source_failure=proof,
        )
        assert result == ("protected" if outcome == "protected" else "deleted")
    assert conn.deleted is (outcome == "delete")
    if outcome == "delete":
        assert audit.call_args.args[4] == SOURCE_DISPOSAL_ACTION
        assert audit.call_args.args[5]["sourceFailure"] == proof
        assert (tmp_path / "deleted/row-run.json").exists()
    else:
        audit.assert_not_awaited()
        assert not list(tmp_path.glob("deleted/*"))
