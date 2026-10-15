"""Explicit Admin disposal of incomplete automatic radar with unavailable evidence.

This policy never asserts noise. A recent failed source-only preflight must agree
with a terminal historical source failure and the exact unchanged database row.
Model, rate-limit, size-limit and unverified README-path failures are ineligible.
"""

from __future__ import annotations

import time
from typing import Any

SOURCE_DISPOSAL_POLICY = "incomplete_source_unavailable_v1"
SOURCE_DISPOSAL_ACTION = "radar_source_unavailable_delete"
UNAVAILABLE_CODES = frozenset(
    {
        "SOURCE_HTTP_401",
        "SOURCE_HTTP_402",
        "SOURCE_HTTP_403",
        "SOURCE_HTTP_404",
        "SOURCE_HTTP_410",
        "SOURCE_INSUFFICIENT",
        "URL_FETCH_BLOCKED",
        "CONTENT_TYPE_REJECTED",
        "URL_FETCH_TIMEOUT",
        "SOURCE_INVALID_PDF",
        "SOURCE_PDF_ENCRYPTED",
        "SOURCE_PDF_NO_TEXT",
    }
)


def source_disposal_eligible(
    row: dict[str, Any], proof: dict[str, Any] | None, *, incomplete: bool, now: float | None = None
) -> bool:
    if not proof or not incomplete or row.get("source") != "daily":
        return False
    now = time.time() if now is None else now
    prior = proof.get("prior") or {}
    checked = proof.get("checkedAt")
    # Reject future/stale proofs, changed snapshots and incomplete histories.
    if (
        not isinstance(checked, (int, float))
        or not 0 <= now - checked <= 86400
        or str(proof.get("id")) != str(row.get("id"))
        or str(proof.get("updatedAt")) != str(row.get("updatedAt"))
        or not row.get("fingerprint")
        or proof.get("fingerprint") != row["fingerprint"]
        or prior.get("observedUpdatedAt") != str(row.get("updatedAt"))
        or prior.get("status") != "blocked"
        or int(prior.get("attempts") or 0) < 1
        or not str(prior.get("errorCode") or "").startswith(("SOURCE_", "URL_", "CONTENT_TYPE_"))
        or proof.get("status") != "unavailable"
        or proof.get("errorCode") not in UNAVAILABLE_CODES
    ):
        return False
    # A single slow network request never establishes persistent unavailability.
    if proof["errorCode"] == "URL_FETCH_TIMEOUT":
        checks = proof.get("checks") or []
        return (
            prior.get("errorCode") == "URL_FETCH_TIMEOUT"
            and int(prior["attempts"]) >= 3
            or len(checks) >= 2
            and all(x.get("errorCode") == "URL_FETCH_TIMEOUT" for x in checks)
            and all(isinstance(x.get("checkedAt"), (int, float)) for x in checks)
            and 0 <= checks[0]["checkedAt"] < checks[-1]["checkedAt"] <= checked
        )
    return True
