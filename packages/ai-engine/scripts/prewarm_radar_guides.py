"""Pre-generate cached v4 article maps for high-value radar entries.

The script calls the existing Web transform endpoint so the same cache key,
source hash, chunking, and guide normalization path are used as interactive
page loads. It is intentionally sequential to respect anonymous transform
rate limits and provider capacity.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
import urllib.error
import urllib.request


WEB_URL = os.environ.get("RADAR_WEB_URL", "http://localhost:3000").rstrip("/")
LANGUAGE = os.environ.get("RADAR_GUIDE_LANGUAGE", "zh-CN")
LOG_EVERY = 1


def load_ids() -> list[str]:
    query = (
        "SELECT id FROM summaries "
        "WHERE source='daily' AND \"syncRunId\" IS NOT NULL "
        "AND status IN ('candidate','published') "
        "AND \"distilledTier\" IN ('collection','deep_read') "
        "ORDER BY CASE \"distilledTier\" WHEN 'collection' THEN 0 ELSE 1 END, "
        "\"createdAt\" ASC;"
    )
    result = subprocess.run(
        ["psql", "-h", "localhost", "-U", "postgres", "-d", "deep_research", "-Atc", query],
        check=True,
        capture_output=True,
        text=True,
    )
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def transform(summary_id: str) -> tuple[bool, str]:
    payload = json.dumps({"mode": "ai_reading", "language": LANGUAGE}).encode()
    request = urllib.request.Request(
        f"{WEB_URL}/api/radar/{summary_id}/transform",
        data=payload,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            body = json.loads(response.read().decode("utf-8"))
        guide = body.get("guide")
        if not isinstance(guide, dict):
            return False, str(body.get("message") or "guide missing")
        coverage = body.get("coverage") or {}
        return True, (
            f"cached={body.get('cached', False)} "
            f"coverage={coverage.get('resolvedOutlineCount', 0)}/"
            f"{coverage.get('outlineCount', 0)}"
        )
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        return False, f"{type(exc).__name__}: {exc}"


def main() -> int:
    ids = load_ids()
    print(f"prewarm targets={len(ids)} language={LANGUAGE}", flush=True)
    succeeded = 0
    failed = 0
    for index, summary_id in enumerate(ids, start=1):
        ok, detail = transform(summary_id)
        if ok:
            succeeded += 1
        else:
            failed += 1
        print(
            f"[{index}/{len(ids)}] {summary_id} "
            f"{'ok' if ok else 'failed'} {detail}",
            flush=True,
        )
        # The request itself is usually slow enough, but keep a small spacing
        # between fast cache misses/errors to stay under anonymous request rate.
        if index < len(ids):
            time.sleep(2)
    print(f"prewarm completed succeeded={succeeded} failed={failed}", flush=True)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
