"""Preserve diagnostic evidence while bounding current work and retries."""
from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone
from typing import Any

DETERMINISTIC_ERRORS = ('TOO_LARGE', 'URL_FETCH_TOO_LARGE', 'SOURCE_NOT_FOUND')


def publication_identity(title: str, published_at: Any) -> str:
    stamp = ''
    if published_at is not None:
        parsed = published_at if isinstance(published_at, datetime) else datetime.fromisoformat(str(published_at))
        stamp = parsed.replace(tzinfo=parsed.tzinfo or timezone.utc).astimezone(timezone.utc).isoformat(timespec='milliseconds')
    return hashlib.sha256((re.sub(r'\s+', ' ', title).strip().casefold() + '\n' + stamp).encode()).hexdigest()


async def deleted_publication(pool: Any, source_id: str, url: str, title: str, published_at: Any) -> bool:
    """Minimal audit tombstone; a different publication remains eligible."""
    async with pool.connection() as conn:
        row = await (await conn.execute(
            "SELECT 1 FROM admin_actions a WHERE a.action='radar_noise_delete' "
            "AND a.metadata->>'canonicalUrl'=%s AND a.metadata->>'sourceId'=%s "
            "AND a.metadata->>'publicationIdentity'=%s "
            "AND NOT EXISTS (SELECT 1 FROM admin_actions r WHERE r.action='radar_noise_restore' "
            "AND r.metadata->>'deletionAuditId'=a.id::text) LIMIT 1",
            (url, str(source_id), publication_identity(title, published_at)),
        )).fetchone()
    return row is not None


async def retire_duplicate_pending(conn: Any, source_id: str, url: str, reason: str,
                                   kind: str, markdown: str | None, body: str) -> None:
    # Held until the surrounding insertion commits. Filtered content with
    # different evidence stays independent even when its URL is identical.
    await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',
                       (f'radar-diagnostic:{source_id}:{url}:{reason}',))
    await conn.execute(
        "UPDATE radar_sync_diagnostics SET status='dismissed', \"updatedAt\"=now() "
        'WHERE "sourceId"=%s AND "canonicalUrl"=%s AND "reasonCode"=%s '
        "AND status='pending' AND kind=%s::\"RadarDiagnosticKind\" "
        'AND (%s OR md5(COALESCE("originalMarkdown",body,\'\'))=md5(%s))',
        (source_id, url, reason, kind, kind == 'failed', markdown if markdown is not None else body),
    )


async def deterministic_retry_blocked(pool: Any, source_id: str, url: str,
                                      title: str, published_at: Any) -> bool:
    async with pool.connection() as conn:
        row = await (await conn.execute(
            'SELECT count(*) AS attempts FROM radar_sync_diagnostics '
            'WHERE "sourceId"=%s AND "canonicalUrl"=%s '
            'AND ("reasonCode"=ANY(%s) OR "errorType"=\'SourceNotFoundError\') '
            "AND lower(regexp_replace(btrim(title), '\\s+', ' ', 'g'))=lower(%s) "
            'AND "publishedAt" IS NOT DISTINCT FROM %s::timestamptz',
            (source_id, url, list(DETERMINISTIC_ERRORS), re.sub(r'\s+', ' ', title[:300]).strip(), published_at),
        )).fetchone()
    return bool(row and dict(row)['attempts'] >= 3)


async def close_scored_pending(conn: Any, summary_id: str) -> None:
    # Only this scoring insertion's source run is evidence of resolution.
    # A different article at the same URL cannot resolve an old failure.
    await conn.execute(
        "UPDATE radar_sync_diagnostics d SET status='dismissed', \"updatedAt\"=now() "
        'FROM summaries s WHERE s.id=%s AND d."runId"=s."syncRunId" '
        'AND d."canonicalUrl"=s."canonicalUrl" AND d."reasonCode"=\'PENDING_SCORE\' '
        "AND d.status='pending' AND s.\"distilledScore\" IS NOT NULL "
        "AND s.\"distilledScore\"->>'isDefault'='false' "
        'AND EXISTS (SELECT 1 FROM jsonb_each(s."distilledScore"->\'dimensions\') v '
        "WHERE v.value::text IN ('1','2','3'))",
        (summary_id,),
    )
