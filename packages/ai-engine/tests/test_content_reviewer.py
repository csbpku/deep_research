from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import pytest

from ai_engine.radar import content_reviewer as cr


class _Cursor:
    def __init__(
        self,
        row: dict[str, Any] | None = None,
        *,
        rowcount: int = 1,
    ) -> None:
        self.row = row
        self.rowcount = rowcount

    async def fetchone(self) -> dict[str, Any] | None:
        return self.row


class _Connection:
    def __init__(self, row: dict[str, Any]) -> None:
        self.row = row
        self.updates: list[tuple[str, tuple[Any, ...]]] = []

    async def execute(self, sql: str, params: tuple[Any, ...] = ()) -> _Cursor:
        if sql.lstrip().upper().startswith("SELECT"):
            return _Cursor(self.row)
        self.updates.append((sql, params))
        return _Cursor()


class _ClaimConnection(_Connection):
    async def execute(
        self,
        sql: str,
        params: tuple[Any, ...] = (),
    ) -> _Cursor:
        if "gen_random_uuid()" in sql:
            self.updates.append((sql, params))
            return _Cursor({
                "contentReviewClaimId": "22222222-2222-4222-8222-222222222222",
            })
        return await super().execute(sql, params)


class _ConflictConnection(_Connection):
    async def execute(
        self,
        sql: str,
        params: tuple[Any, ...] = (),
    ) -> _Cursor:
        self.updates.append((sql, params))
        return _Cursor(rowcount=0)


class _Pool:
    def __init__(self, markdown: str) -> None:
        self.connection_value = _Connection({
            "id": "summary-1",
            "title": "Test paper",
            "originalKind": "arxiv",
            "originalMarkdown": markdown,
        })

    @asynccontextmanager
    async def connection(self):  # type: ignore[no-untyped-def]
        yield self.connection_value


def _agent(
    status: cr.AgentStatus,
    *,
    findings: tuple[cr.ContentFinding, ...] = (),
) -> cr.AgentReview:
    return cr.AgentReview(
        available=True,
        status=status,
        summary="test review",
        findings=findings,
    )


def test_inspect_and_repair_only_allowlisted_presentation_artifacts() -> None:
    markdown = (
        "A \\emph{readable} paragraph.\n\n"
        "††footnotetext: Corresponding author.\n\n"
        "<math><mi>x</mi><annotation encoding=\"application/x-tex\">x</annotation></math>"
        "\n\n&nbsp;"
    )

    findings = cr.inspect_content(markdown)
    codes = {item.code for item in findings}
    repaired = cr.repair_content(markdown, findings)

    assert {"extracted_footnote", "latex_text_command", "mathml_annotation_duplicate"} <= codes
    assert "footnotetext" not in repaired
    assert "\\emph" not in repaired
    assert "<math>" not in repaired
    assert "readable" in repaired


def test_prompt_marks_excerpt_boundaries_for_long_documents() -> None:
    prompt = cr._prompt_content("BEGIN\n" + ("body " * 5_000) + "\nFINAL")

    assert "BEGINNING EXCERPT" in prompt
    assert "MIDDLE CONTENT OMITTED" in prompt
    assert "BEGINNING OF FINAL EXCERPT" in prompt
    assert "FINAL" in prompt


def test_source_metadata_marks_incomplete_zread_and_legacy_cap() -> None:
    findings = cr._source_truncation_findings(
        kind="github_repo",
        original_meta={
            "zread": {
                "pageCount": 7,
                "expectedPageCount": 29,
                "truncated": True,
            },
        },
    )
    assert findings[0].code == "truncated_content"
    assert "7/29" in (findings[0].evidence or "")

    legacy = cr._source_truncation_findings(
        kind="arxiv",
        original_meta={"provider": "arxiv"},
        original_markdown="x" * (512 * 1024),
    )
    assert legacy[0].code == "truncated_content"
    assert "legacy_reader_completeness_marker_missing" in (legacy[0].evidence or "")

    assert cr._source_truncation_findings(
        kind="rss",
        original_meta={"provider": "web"},
        original_markdown="x" * (512 * 1024),
    ) == ()


@pytest.mark.asyncio
async def test_cycle_approves_clean_content_in_first_round(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool = _Pool("A clean article with enough readable content.")
    calls = 0

    async def fake_review(**_: Any) -> cr.AgentReview:
        nonlocal calls
        calls += 1
        return _agent("approved")

    monkeypatch.setattr(cr, "_review_with_agent", fake_review)

    result = await cr.run_content_review_cycle(pool, summary_id="summary-1")

    assert result.status == "approved"
    assert result.round == 1
    assert calls == 1
    assert any(
        params[0] == "approved"
        for sql, params in pool.connection_value.updates
        if "contentReviewStatus" in sql
    )


@pytest.mark.asyncio
async def test_cycle_repairs_then_runs_second_review(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool = _Pool("A \\emph{readable} paragraph.")
    statuses = iter([
        _agent(
            "needs_repair",
            findings=(cr.ContentFinding(
                code="latex_text_command",
                severity="blocking",
                message="latex",
                repairable=True,
            ),),
        ),
        _agent("approved"),
    ])

    async def fake_review(**_: Any) -> cr.AgentReview:
        return next(statuses)

    monkeypatch.setattr(cr, "_review_with_agent", fake_review)

    result = await cr.run_content_review_cycle(pool, summary_id="summary-1")

    assert result.status == "approved"
    assert result.round == 2
    repair_updates = [
        params for sql, params in pool.connection_value.updates
        if '"originalMarkdown" = %s' in sql
    ]
    assert repair_updates
    assert "\\emph" not in repair_updates[0][0]
    assert result.details["rounds"][0]["status"] == "repaired"
    assert result.details["rounds"][1]["status"] == "approved"


@pytest.mark.asyncio
async def test_cycle_marks_manual_after_two_unresolved_rounds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool = _Pool("A \\emph{readable} paragraph.")
    finding = cr.ContentFinding(
        code="latex_text_command",
        severity="blocking",
        message="latex remains",
        repairable=True,
    )

    async def fake_review(**_: Any) -> cr.AgentReview:
        return _agent("needs_repair", findings=(finding,))

    monkeypatch.setattr(cr, "_review_with_agent", fake_review)

    result = await cr.run_content_review_cycle(pool, summary_id="summary-1")

    assert result.status == "needs_manual_review"
    assert result.round == 2
    assert result.details["rounds"][1]["repair"]["blockedBy"] == "max_rounds"


@pytest.mark.asyncio
async def test_cycle_does_not_approve_when_agent_is_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool = _Pool("A clean article.")

    async def unavailable(**_: Any) -> cr.AgentReview:
        return cr.AgentReview(
            available=False,
            status="unavailable",
            summary="offline",
            error="provider unavailable",
        )

    monkeypatch.setattr(cr, "_review_with_agent", unavailable)

    result = await cr.run_content_review_cycle(pool, summary_id="summary-1")

    assert result.status == "needs_manual_review"
    assert result.round == 1
    assert result.details["rounds"][0]["agent"]["available"] is False


@pytest.mark.asyncio
async def test_quality_gate_can_be_reclaimed_after_reader_quality_recovers() -> None:
    pool = _Pool("A clean article.")

    await cr.claim_content_review(pool, summary_id="summary-1")

    sql, _ = pool.connection_value.updates[0]
    assert '"contentReviewDetails"->>\'reason\' = \'reader_quality_gate\'' in sql
    assert '"readerQualityStatus" = \'ready\'' in sql


@pytest.mark.asyncio
async def test_content_review_claim_returns_token_and_requires_v2_snapshot() -> None:
    pool = _Pool("A clean article.")
    pool.connection_value = _ClaimConnection(pool.connection_value.row)

    claim_id = await cr.claim_content_review(pool, summary_id="summary-1")

    assert claim_id == "22222222-2222-4222-8222-222222222222"
    sql, _ = pool.connection_value.updates[0]
    assert '"contentReviewClaimId" = gen_random_uuid()' in sql
    assert 'COALESCE("originalMeta"->>\'enrichmentVersion\', \'\') = \'2.0\'' in sql


@pytest.mark.asyncio
async def test_old_content_review_claim_cannot_persist_terminal_state() -> None:
    pool = _Pool("A clean article.")
    pool.connection_value = _ConflictConnection(pool.connection_value.row)

    with pytest.raises(cr.ContentReviewConflict):
        await cr._persist_review_state(
            pool,
            summary_id="summary-1",
            expected_sha256=None,
            claim_id="22222222-2222-4222-8222-222222222222",
            status="approved",
            round_number=1,
            summary={"status": "approved"},
            details={},
        )

    sql, params = pool.connection_value.updates[0]
    assert '"contentReviewClaimId" IS NOT DISTINCT FROM %s::uuid' in sql
    assert params[-1] == "22222222-2222-4222-8222-222222222222"


@pytest.mark.asyncio
async def test_agent_parser_accepts_json_only_review(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_generate_text(**_: Any) -> Any:
        return SimpleNamespace(text=(
            '```json\n{"status":"needs_repair","summary":"有展示残留",'
            '"findings":[{"code":"extracted_footnote","severity":"blocking",'
            '"repairable":true,"message":"脚注残留"}]}\n```'
        ))

    monkeypatch.setattr(cr, "generate_text", fake_generate_text)
    result = await cr._review_with_agent(
        title="Paper",
        kind="arxiv",
        markdown="text",
        deterministic=(),
    )

    assert result.available is True
    assert result.status == "needs_repair"
    assert result.findings[0].code == "extracted_footnote"
    assert result.findings[0].repairable is True


@pytest.mark.asyncio
async def test_agent_retries_when_first_response_is_not_json(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    responses = iter([
        SimpleNamespace(text="I reviewed the article and found no issues."),
        SimpleNamespace(text='{"status":"approved","summary":"ok","findings":[]}'),
    ])

    async def fake_generate_text(**_: Any) -> Any:
        return next(responses)

    monkeypatch.setattr(cr, "generate_text", fake_generate_text)

    result = await cr._review_with_agent(
        title="Paper",
        kind="arxiv",
        markdown="text",
        deterministic=(),
    )

    assert result.available is True
    assert result.status == "approved"


@pytest.mark.asyncio
async def test_agent_retries_when_valid_response_has_no_findings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    responses = iter([
        SimpleNamespace(text='{"status":"needs_repair","summary":"unclear","findings":[]}'),
        SimpleNamespace(text='{"status":"approved","summary":"ok","findings":[]}'),
    ])
    calls: list[dict[str, Any]] = []

    async def fake_generate_text(**kwargs: Any) -> Any:
        calls.append(kwargs)
        return next(responses)

    monkeypatch.setattr(cr, "generate_text", fake_generate_text)

    result = await cr._review_with_agent(
        title="Paper",
        kind="arxiv",
        markdown="start\n" + ("body " * 5_000) + "\nactual final sentence",
        deterministic=(),
    )

    assert result.available is True
    assert result.status == "approved"
    assert len(calls) == 2
    assert "BEGINNING OF FINAL EXCERPT" in calls[1]["user_prompt"]


def test_agent_preserves_unmapped_findings_as_manual_review() -> None:
    result = cr._parse_agent_review({
        "status": "needs_repair",
        "summary": "有风险",
        "findings": [{
            "code": "new_renderer_issue",
            "severity": "blocking",
            "repairable": True,
            "message": "未知问题",
        }],
    })

    assert result.status == "needs_repair"
    assert len(result.findings) == 1
    assert result.findings[0].code == "agent_unclassified_issue"
    assert result.findings[0].repairable is False


def test_agent_maps_truncation_description_to_manual_finding() -> None:
    result = cr._parse_agent_review({
        "status": "needs_repair",
        "summary": "末尾截断",
        "findings": [{
            "code": "content_quality",
            "severity": "blocking",
            "repairable": True,
            "message": "The content is truncated and cut off mid-sentence.",
        }],
    })

    assert result.findings[0].code == "truncated_content"
    assert result.findings[0].repairable is False
