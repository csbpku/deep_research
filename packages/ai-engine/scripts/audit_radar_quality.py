"""Inspect every radar under one read-only DB snapshot; write private artifacts only."""
from __future__ import annotations

import argparse
import asyncio
import csv
import hashlib
import json
import os
from pathlib import Path
from typing import Any

from psycopg import AsyncConnection
from psycopg.rows import dict_row

from ai_engine.radar import governance as g
from ai_engine.radar import quality_audit as q
from ai_engine.radar.repair import SCOPE_SQL
from ai_engine.radar.topic_eligibility import TOPIC_ELIGIBILITY_SQL

ROWS_SQL = ('SELECT s.*,rr."sourceId",rs.name AS "sourceName",rs."sourceType",'
            'EXISTS(SELECT 1 FROM share_submissions sh WHERE sh."publishedSummaryId"=s.id '
            "AND sh.status='approved') AS \"approvedShare\", "
            + TOPIC_ELIGIBILITY_SQL.replace('%%', '%') + ' AS "topicEligible" '
            'FROM summaries s LEFT JOIN radar_sync_runs rr ON rr.id=s."syncRunId" '
            f'LEFT JOIN radar_sources rs ON rs.id=rr."sourceId" WHERE {SCOPE_SQL} '
            'ORDER BY s."createdAt" DESC,s.id')
DIAGNOSTICS_SQL = ('SELECT id,"runId","sourceId","canonicalUrl",kind,"reasonCode",'
                   '"createdAt","updatedAt",md5(COALESCE("originalMarkdown",body,\'\')) AS evidence_hash,'
                   'count(*) OVER(PARTITION BY "sourceId","canonicalUrl","reasonCode",kind,'
                   'md5(COALESCE("originalMarkdown",body,\'\'))) AS "duplicateCount" '
                   "FROM radar_sync_diagnostics WHERE status='pending'")


def read_state(path: Path | None) -> dict[str, Any]:
    return json.loads(path.read_text()) if path and path.exists() else {'items': {}}


async def run(actor: str, output: Path, state_path: Path | None) -> dict[str, Any]:
    os.umask(0o077)
    output.mkdir(parents=True, exist_ok=False)
    state_before = read_state(state_path)
    conn = await AsyncConnection.connect(os.environ['DATABASE_URL'], row_factory=dict_row)
    try:
        async with conn.transaction():
            await conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
            await conn.execute("SET LOCAL statement_timeout='120s'")
            await g.verify_admin(conn, actor)
            captured = await (await conn.execute('SELECT clock_timestamp() AS at, '
                'txid_current_snapshot()::text AS snapshot, current_setting(\'transaction_read_only\') AS readonly,'
                '(SELECT count(*) FROM summaries) AS "allSummaries"')).fetchone()
            assert captured
            capture = dict(captured)
            inventory = [dict(row) for row in await (await conn.execute(ROWS_SQL)).fetchall()]
            count = await (await conn.execute(f'SELECT count(*) AS n FROM summaries s WHERE {SCOPE_SQL}')).fetchone()
            assert count and count['n'] == len(inventory)
            protections = await g.protected_ids(conn, inventory)
            diagnostics = [dict(row) for row in await (await conn.execute(DIAGNOSTICS_SQL)).fetchall()]
            sources = [dict(row) for row in await (await conn.execute('SELECT s.id,s.name,s.enabled,'
                's."lastSyncAt",s."consecutiveFailures",s."autoPausedAt",'
                '(SELECT max(r."completedAt") FROM radar_sync_runs r WHERE r."sourceId"=s.id '
                "AND r.status='completed') AS last_completed FROM radar_sources s ORDER BY s.name")).fetchall()]
    finally:
        await conn.close()
    state_after = read_state(state_path)
    # User requested scored noise be disposed of rather than included in brief
    # completeness statistics. Classification alone never authorizes deletion.
    noise_rows = [row for row in inventory if q.valid_score(row)
                  and row['distilledScore']['tier'] == 'noise']
    noise_ids = {str(row['id']) for row in noise_rows}
    rows = [row for row in inventory if str(row['id']) not in noise_ids]
    duplicates = q.duplicate_candidates(rows)
    by_run_url: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for diagnostic in diagnostics:
        by_run_url.setdefault((str(diagnostic['runId']), diagnostic['canonicalUrl']), []).append(diagnostic)
    results = []
    for row in rows:
        sid = str(row['id'])
        item = state_before['items'].get(sid)
        result = q.audit_row(row, now=capture['at'], protections=protections.get(sid, []),
            diagnostics=by_run_url.get((str(row.get('syncRunId')), row['canonicalUrl']), []), item=item,
            checkpoint_stable=item == state_after['items'].get(sid), duplicate_ids=duplicates.get(sid, []))
        result['topicEligible'] = bool(row['topicEligible'])
        results.append(result)
    summary = {'capturedAt': capture['at'], 'databaseSnapshot': capture['snapshot'],
               'readOnly': capture['readonly'],
               'scope': 'all daily + approved shares, all statuses; valid scored noise excluded for disposition',
               'databaseRadarTotal': len(inventory), 'noiseExcludedFromQuality': len(noise_rows),
               'allSummaries': capture['allSummaries'], **q.aggregate(results),
               'pendingDiagnosticDuplicateGroups': len({(str(d['sourceId']), d['canonicalUrl'], d['reasonCode'],
                   d['kind'], d['evidence_hash']) for d in diagnostics if d['duplicateCount'] > 1}),
               'sourceHealth': sources, 'repairReservedModelCalls': state_after.get('modelCalls'),
               'repairLastCycleAt': state_after.get('lastCycleAt'),
               'limits': ['No source fetching, model calls or production writes during audit.',
                          'Nonempty summaries and valid score structures do not prove semantic fidelity.',
                          'Checkpoint is outside DB transaction; concurrent/version conflicts are unverified.']}
    assert summary['total'] == summary['uniqueIds'] == count['n'] - len(noise_rows)
    g.save(output / 'summary.json', summary)
    g.save(output / 'all-radar-checks.json', {'checks': q.CHECKS, 'summary': summary, 'rows': results})
    g.save(output / 'pending-diagnostics.json', {'rows': diagnostics})
    g.save(output / 'noise-disposition.json', {'rows': [
        {'id': row['id'], 'title': row['title'], 'canonicalUrl': row['canonicalUrl'],
         'scoreVersion': row['distilledScore'].get('version'), 'protectedBy': protections.get(str(row['id']), []),
         'directUserProtection': bool(row.get('userNote') or row.get('sharedByUserId')),
         'disposition': 'separate deletion verification; excluded from quality checks'} for row in noise_rows]})
    with (output / 'all-radar-checks.csv').open('w', newline='') as stream:
        fields = ['id', 'title', 'canonicalUrl', 'sourceType', 'status', 'updatedAt', 'protected', 'basicComplete',
                  'topicEligible', 'defects', *q.CHECKS, 'evidence_and_actions']
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        for result in results:
            writer.writerow({**{key: result[key] for key in fields if key in result},
                             'defects': '|'.join(result['defects']),
                             **{key: value['state'] for key, value in result['checks'].items()},
                             'evidence_and_actions': json.dumps(result['checks'], ensure_ascii=False, default=str)})
    with (output / 'issues.csv').open('w', newline='') as stream:
        issue_writer = csv.writer(stream)
        issue_writer.writerow(['id', 'title', 'protected', 'check', 'state', 'severity', 'evidence', 'next_action'])
        for result in sorted(results, key=lambda value: not value['protected']):
            for key in result['defects']:
                value = result['checks'][key]
                severity = 'high' if key in {'identity', 'lineage', 'score', 'score_fields', 'lifecycle'} else 'medium'
                issue_writer.writerow([result['id'], result['title'], result['protected'], key, value['state'], severity,
                                       json.dumps(value['evidence'], ensure_ascii=False, default=str), value['action']])
    (output / 'queries.sql').write_text(ROWS_SQL + ';\n\n' + DIAGNOSTICS_SQL + ';\n')
    manifest = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in output.iterdir()}
    g.save(output / 'manifest.json', manifest)
    serial_summary: dict[str, Any] = g.serial(summary)
    return serial_summary


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--actor', required=True)
    parser.add_argument('--output', type=Path, required=True, help='New private evidence directory')
    parser.add_argument('--repair-state', type=Path)
    args = parser.parse_args()
    print(json.dumps(await run(args.actor, args.output, args.repair_state), ensure_ascii=False))


if __name__ == '__main__':
    asyncio.run(main())
