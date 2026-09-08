"""Post-enrichment content quality review for radar reading surfaces.

This reviewer is deliberately narrower than the research report fact reviewer.
It checks whether extracted content is safe and readable in the browser:
footnote/LaTeX leakage, MathML duplication, broken Markdown images, malformed
tables, and known renderer artifacts. It must never rewrite paper facts or
research conclusions.

The cycle is bounded:

    inspect -> review -> safe repair -> review

Only the first two review rounds are persisted. If the second round still has
unresolved findings, or the utility reviewer is unavailable, the row is marked
``needs_manual_review`` instead of being presented as approved.
"""

from __future__ import annotations

import hashlib
import html
import json
import logging
import os
import re
import uuid
from dataclasses import asdict, dataclass
from collections.abc import Mapping
from typing import Any, Literal, cast

from ai_engine.llm.client import generate_text
from ai_engine.llm.config import resolve_spec
from ai_engine.radar.distilled_scorer import _parse_llm_response

logger = logging.getLogger("ai_engine.radar.content_reviewer")

ReviewStatus = Literal["approved", "needs_manual_review", "reviewing"]
AgentStatus = Literal[
    "approved", "needs_repair", "needs_manual_review", "unavailable",
]
Severity = Literal["blocking", "warning", "info"]

MAX_REVIEW_ROUNDS = 2
MAX_PROMPT_CHARS = 20_000
CONTENT_REVIEW_STALE_MINUTES = max(
    5,
    int(os.environ.get("RADAR_CONTENT_REVIEW_STALE_MINUTES", "30")),
)
_SAFE_REPAIR_CODES = frozenset({
    "extracted_footnote",
    "latex_text_command",
    "mathml_annotation_duplicate",
    "html_nbsp_entity",
    "table_math_duplicate",
})
_KNOWN_CODES = _SAFE_REPAIR_CODES | frozenset({
    "broken_image",
    "malformed_table",
    "mermaid_render_error",
    "html_extraction_artifact",
    "unclosed_image_markdown",
    "truncated_content",
})


@dataclass(frozen=True, slots=True)
class ContentFinding:
    code: str
    severity: Severity
    message: str
    repairable: bool = False
    evidence: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class AgentReview:
    available: bool
    status: AgentStatus
    summary: str
    findings: tuple[ContentFinding, ...] = ()
    error: str | None = None


@dataclass(frozen=True, slots=True)
class ReviewCycleResult:
    status: ReviewStatus
    round: int
    cycle_id: str
    details: dict[str, Any]


class ContentReviewConflict(RuntimeError):
    """The source snapshot changed while a content review was running."""


def _finding(
    code: str,
    severity: Severity,
    message: str,
    *,
    repairable: bool = False,
    evidence: str | None = None,
) -> ContentFinding:
    return ContentFinding(
        code=code,
        severity=severity,
        message=message,
        repairable=repairable and code in _SAFE_REPAIR_CODES,
        evidence=evidence[:300] if evidence else None,
    )


def _split_table_row(line: str) -> list[str] | None:
    stripped = line.strip()
    if not (stripped.startswith("|") and stripped.endswith("|")):
        return None
    cells: list[str] = []
    current: list[str] = []
    body = stripped[1:-1]
    for index, char in enumerate(body):
        if char == "|" and (index == 0 or body[index - 1] != "\\"):
            cells.append("".join(current).strip())
            current = []
        else:
            current.append(char)
    cells.append("".join(current).strip())
    return cells


def _is_table_separator(line: str) -> bool:
    cells = _split_table_row(line)
    return bool(cells and all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells))


def inspect_content(markdown: str) -> tuple[ContentFinding, ...]:
    """Run deterministic checks over the full extracted Markdown."""
    findings: list[ContentFinding] = []

    footnote_match = re.search(
        r"(?im)(?:^|[\n ])[*_~`†‡⁎✝0-9\s]{0,24}footnotetext\s*:",
        markdown,
    )
    if footnote_match:
        findings.append(_finding(
            "extracted_footnote",
            "blocking",
            "抽取内容仍包含 footnotetext/作者脚注残留。",
            repairable=True,
            evidence=footnote_match.group(0).strip(),
        ))
    if re.search(r"(?i)footnotemark\s*:", markdown):
        findings.append(_finding(
            "extracted_footnote",
            "blocking",
            "抽取内容仍包含 footnotemark 残留。",
            repairable=True,
            evidence="footnotemark",
        ))

    latex_match = re.search(
        r"\\(?:emph|textbf|textit|texttt|textrm|textsf|textsc|"
        r"textnormal|underline|href|url)\b",
        markdown,
    )
    if latex_match:
        findings.append(_finding(
            "latex_text_command",
            "blocking",
            "正文中仍有应被转换为可读文本的 LaTeX 文本命令。",
            repairable=True,
            evidence=latex_match.group(0),
        ))

    if re.search(r"(?is)<math\b[^>]*>.*?<annotation\b.*?</math>", markdown):
        findings.append(_finding(
            "mathml_annotation_duplicate",
            "blocking",
            "MathML 与 annotation 同时存在，可能造成公式文本重复显示。",
            repairable=True,
            evidence="<math>...<annotation>...</math>",
        ))

    if "&nbsp;" in markdown or "&#160;" in markdown:
        findings.append(_finding(
            "html_nbsp_entity",
            "warning",
            "正文仍包含未解码的空格 HTML entity。",
            repairable=True,
            evidence="&nbsp;",
        ))

    if re.search(r"(?i)Syntax error in text", markdown):
        findings.append(_finding(
            "mermaid_render_error",
            "blocking",
            "正文包含 Mermaid 渲染错误文本，需要人工检查原始图表。",
            evidence="Syntax error in text",
        ))

    if re.search(r"(?is)<(?:foreignObject|object)\b|ltx_transformed_inner|"
                 r"<ltx_[^>]+>", markdown):
        findings.append(_finding(
            "html_extraction_artifact",
            "blocking",
            "正文包含浏览器不可直接阅读的 HTML 抽取器残留。",
            evidence="HTML extraction artifact",
        ))

    if re.search(r"!\[[^\]]*\]\(\s*\)", markdown):
        findings.append(_finding(
            "broken_image",
            "blocking",
            "Markdown 图片没有有效地址，图片无法渲染。",
            evidence="![]( )",
        ))
    image_open = markdown.count("![")
    image_closed = len(re.findall(r"!\[[^\]]*\]\([^)\n]+\)", markdown))
    if image_open > image_closed:
        findings.append(_finding(
            "unclosed_image_markdown",
            "blocking",
            "正文包含未闭合的 Markdown 图片语法。",
            evidence="![",
        ))

    lines = markdown.splitlines()
    for index, line in enumerate(lines[:-1]):
        if _split_table_row(line) is None or not _is_table_separator(lines[index + 1]):
            continue
        header = _split_table_row(line) or []
        expected = len(header)
        cursor = index + 2
        while cursor < len(lines):
            row = _split_table_row(lines[cursor])
            if row is None:
                break
            if len(row) != expected:
                findings.append(_finding(
                    "malformed_table",
                    "blocking",
                    "表格行列数不一致，可能导致桌面或移动端错位。",
                    evidence=f"expected={expected}, actual={len(row)}",
                ))
                break
            for cell in row:
                duplicate = re.search(r"(\$[^$\n]+\$)\s+\1", cell)
                if duplicate:
                    findings.append(_finding(
                        "table_math_duplicate",
                        "blocking",
                        "表格单元格包含重复的公式文本。",
                        repairable=True,
                        evidence=duplicate.group(0),
                    ))
                    break
            cursor += 1

    unique: dict[str, ContentFinding] = {}
    for item in findings:
        unique.setdefault(item.code, item)
    return tuple(unique.values())


def _strip_footnotes(value: str) -> str:
    value = re.sub(
        r"(?:^|[\n ])[*_~`†‡⁎✝0-9\s]{0,24}footnotetext\s*:\s*.*?"
        r"(?=\s+(?:#{1,6}\s|!\[|[*_~`†‡⁎✝0-9\s]{0,24}footnotetext\s*:)|$)",
        "\n",
        value,
        flags=re.IGNORECASE | re.MULTILINE | re.DOTALL,
    )
    return re.sub(r"footnotemark\s*:\s*", "", value, flags=re.IGNORECASE)


def _strip_latex_text_commands(value: str) -> str:
    for _ in range(4):
        cleaned = value
        cleaned = re.sub(
            r"\\(?:textbf|textit|emph|texttt|textrm|textsf|textsc|"
            r"textnormal|underline)\s*\{([^{}\n]*)\}",
            r"\1",
            cleaned,
        )
        cleaned = re.sub(r"\\href\{[^{}\n]+\}\{([^{}\n]*)\}", r"\1", cleaned)
        cleaned = re.sub(r"\\url\{([^{}\n]+)\}", r"\1", cleaned)
        if cleaned == value:
            return cleaned
        value = cleaned
    return value


def _replace_mathml(match: re.Match[str]) -> str:
    annotation = re.search(
        r"(?is)<annotation\b[^>]*>(.*?)</annotation>",
        match.group(0),
    )
    if not annotation:
        return match.group(0)
    text = re.sub(r"<[^>]+>", "", annotation.group(1))
    text = html.unescape(text).strip()
    return f" ${text}$ " if text else match.group(0)


def repair_content(markdown: str, findings: tuple[ContentFinding, ...]) -> str:
    """Apply only the explicitly allow-listed, presentation-safe repairs."""
    codes = {item.code for item in findings if item.repairable}
    value = markdown
    if "extracted_footnote" in codes:
        value = _strip_footnotes(value)
    if "latex_text_command" in codes:
        value = _strip_latex_text_commands(value)
    if "mathml_annotation_duplicate" in codes:
        value = re.sub(
            r"(?is)<math\b[^>]*>.*?</math>",
            _replace_mathml,
            value,
        )
    if "html_nbsp_entity" in codes:
        value = value.replace("&nbsp;", " ").replace("&#160;", " ")
    if "table_math_duplicate" in codes:
        value = re.sub(r"(\$[^$\n]+\$)\s+\1", r"\1", value)
    value = re.sub(r"\n{3,}", "\n\n", value).strip()
    return value


def _prompt_content(markdown: str) -> str:
    if len(markdown) <= MAX_PROMPT_CHARS:
        return "[BEGIN FULL DOCUMENT]\n" + markdown + "\n[END FULL DOCUMENT]"
    return (
        "[BEGINNING EXCERPT — this is not the end of the document]\n"
        + markdown[:16_000]
        + "\n[END BEGINNING EXCERPT]\n\n"
        "[MIDDLE CONTENT OMITTED — deterministic checks scanned the full document]\n\n"
        "[BEGINNING OF FINAL EXCERPT — this is the actual document ending]\n"
        + markdown[-3_500:]
        + "\n[END OF FINAL EXCERPT]"
    )


def _parse_json_object(text: str) -> dict[str, Any]:
    stripped = text.strip()
    try:
        parsed = json.loads(stripped)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", stripped, re.DOTALL)
    if fenced:
        parsed = json.loads(fenced.group(1))
        if isinstance(parsed, dict):
            return parsed
    decoder = json.JSONDecoder()
    for index, char in enumerate(stripped):
        if char != "{":
            continue
        try:
            parsed, _ = decoder.raw_decode(stripped[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    raise ValueError("no JSON object in content review response")


def _parse_review_response(text: str) -> dict[str, Any]:
    """Reuse the scorer's reasoning/fence-tolerant parser before local fallback."""
    try:
        return _parse_llm_response(text)
    except (TypeError, ValueError, json.JSONDecodeError):
        return _parse_json_object(text)


def _parse_agent_review(payload: dict[str, Any]) -> AgentReview:
    raw_status = payload.get("status")
    status: AgentStatus = (
        raw_status
        if raw_status in {"approved", "needs_repair", "needs_manual_review"}
        else "needs_manual_review"
    )
    findings: list[ContentFinding] = []
    unknown_codes: list[str] = []
    raw_findings = payload.get("findings")
    if isinstance(raw_findings, list):
        for raw in raw_findings:
            if not isinstance(raw, dict):
                continue
            code = str(raw.get("code") or "").strip()
            message = str(raw.get("message") or "审核 Agent 发现展示风险。")[:500]
            if (
                code not in _KNOWN_CODES
                and re.search(
                    r"(?i)truncat|cut off|incomplete|截断|不完整|未结束",
                    f"{code} {message}",
                )
            ):
                code = "truncated_content"
            if code not in _KNOWN_CODES:
                if code:
                    unknown_codes.append(code[:120])
                continue
            severity = raw.get("severity")
            if severity not in {"blocking", "warning", "info"}:
                severity = "warning"
            findings.append(_finding(
                code,
                cast(Severity, severity),
                message,
                repairable=bool(raw.get("repairable")),
                evidence=str(raw.get("evidence")) if raw.get("evidence") else None,
            ))
    if unknown_codes:
        findings.append(_finding(
            "agent_unclassified_issue",
            "blocking",
            "审核 Agent 报告了未映射的展示问题，需要人工确认后再扩展安全修复白名单。",
            evidence=", ".join(dict.fromkeys(unknown_codes)),
        ))
    return AgentReview(
        available=True,
        status=status,
        summary=str(payload.get("summary") or "")[:500],
        findings=tuple(findings),
    )


def _ensure_actionable_agent_review(review: AgentReview) -> AgentReview:
    if review.status not in {"needs_repair", "needs_manual_review"} or review.findings:
        return review
    return AgentReview(
        available=review.available,
        status=review.status,
        summary=review.summary,
        findings=(
            _finding(
                "agent_unclassified_issue",
                "blocking",
                "审核 Agent 判定内容存在展示风险，但没有返回可识别的具体问题。",
            ),
        ),
        error=review.error,
    )


async def _review_with_agent(
    *,
    title: str,
    kind: str,
    markdown: str,
    deterministic: tuple[ContentFinding, ...],
) -> AgentReview:
    prompt = {
        "title": title,
        "originalKind": kind,
        "deterministicFindings": [item.to_dict() for item in deterministic],
        "content": _prompt_content(markdown),
    }
    system_prompt = (
        "你是研究内容前端呈现审核 Agent。只审核抽取内容是否能在浏览器中稳定、"
        "清晰地展示，不审核论文事实，不改写摘要语义，不改变研究结论。重点检查 "
        "footnotetext、LaTeX 文本命令、MathML 重复、图片 Markdown、表格列数、"
        "Mermaid 错误和 HTML 抽取残留。只能返回 JSON，不要 markdown 代码块。"
        '格式：{"status":"approved|needs_repair|needs_manual_review",'
        '"summary":"...", "findings":[{"code":"...", "severity":"blocking|warning|info",'
        '"repairable":true, "message":"...", "evidence":"..."}]}。'
        "repairable 只能用于确定不会改变原文事实的展示清洗。"
        "审核输入可能是带有明确边界标记的摘录；不要把摘录边界、"
        "MIDDLE CONTENT OMITTED 或 BEGINNING EXCERPT 的句子中断误判为原文截断。"
        "只有 FINAL EXCERPT 的真实文档末尾不完整，或确定性检查明确指出截断时，"
        "才报告 truncated_content。若没有可识别的 finding，必须返回 approved，"
        "不要返回没有证据的 needs_manual_review。"
    )
    user_prompt = (
        "请审核下面这条 enrichment 内容。已知的确定性检查结果也附在 JSON 中，"
        "请确认或补充，不要因为内容学术观点本身而判失败。\n"
        + json.dumps(prompt, ensure_ascii=False)
    )
    try:
        result = await generate_text(
            llm_spec=resolve_spec("utility"),
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            max_tokens=4096,
            timeout=45.0,
            disable_thinking=True,
            operation="radar.content_review",
        )
        try:
            parsed = _parse_agent_review(_parse_review_response(result.text))
            if parsed.status == "approved" or parsed.findings:
                return parsed
            # A valid but empty needs_repair/manual response is not actionable.
            # Ask once with an explicit contract before putting the row in a
            # manual queue; this also recovers from models that mistake an
            # excerpt boundary for source truncation.
            retry_result = await generate_text(
                llm_spec=resolve_spec("utility"),
                system_prompt=(
                    "只输出一个合法 JSON 对象，不要解释、不要 markdown、不要 <think>。"
                    "摘录边界不是原文问题；没有明确展示风险就必须 approved。"
                    '格式：{"status":"approved|needs_repair|needs_manual_review",'
                    '"summary":"...", "findings":[]}'
                ),
                user_prompt=(
                    "上一次审核没有给出可识别的 finding。请重新判断；"
                    "如果没有明确的前端展示问题，返回 approved 和空 findings。\n"
                    + json.dumps({
                        "title": title,
                        "originalKind": kind,
                        "deterministicFindings": [item.to_dict() for item in deterministic],
                        "content": _prompt_content(markdown),
                    }, ensure_ascii=False)
                ),
                max_tokens=4096,
                timeout=30.0,
                disable_thinking=True,
                operation="radar.content_review.ambiguous_retry",
            )
            return _ensure_actionable_agent_review(
                _parse_agent_review(_parse_review_response(retry_result.text))
            )
        except (TypeError, ValueError, json.JSONDecodeError) as first_error:
            # Reasoning-capable OpenAI-compatible providers occasionally
            # ignore the JSON-only instruction. Retry with a smaller prompt
            # before degrading to manual review; never treat parse failure as
            # approval.
            retry_result = await generate_text(
                llm_spec=resolve_spec("utility"),
                system_prompt=(
                    "只输出一个合法 JSON 对象，不要解释、不要 markdown、不要 <think>。"
                    '格式：{"status":"approved|needs_repair|needs_manual_review",'
                    '"summary":"...", "findings":[]}'
                ),
                user_prompt=(
                    "请只判断下面内容是否存在前端展示/抽取问题。"
                    "如果没有问题返回 approved，findings 必须是空数组。\n"
                    + json.dumps({
                        "title": title,
                        "originalKind": kind,
                        "deterministicFindings": [item.to_dict() for item in deterministic],
                        "content": _prompt_content(markdown),
                    }, ensure_ascii=False)
                ),
                max_tokens=4096,
                timeout=30.0,
                disable_thinking=True,
                operation="radar.content_review.retry",
            )
            try:
                return _ensure_actionable_agent_review(
                    _parse_agent_review(_parse_review_response(retry_result.text))
                )
            except (TypeError, ValueError, json.JSONDecodeError) as retry_error:
                raise ValueError(
                    f"review response was not parseable after retry: "
                    f"{type(first_error).__name__}; {type(retry_error).__name__}"
                ) from retry_error
    except Exception as exc:
        logger.warning(
            "ai-engine.radar.content_review_agent_unavailable",
            extra={"error": type(exc).__name__},
        )
        return AgentReview(
            available=False,
            status="unavailable",
            summary="审核 Agent 不可用，未自动批准内容。",
            error=f"{type(exc).__name__}: {str(exc)[:200]}",
        )


def _merge_findings(
    deterministic: tuple[ContentFinding, ...],
    agent: AgentReview,
) -> tuple[ContentFinding, ...]:
    merged: dict[str, ContentFinding] = {}
    for item in (*deterministic, *agent.findings):
        existing = merged.get(item.code)
        if existing is None or (item.repairable and not existing.repairable):
            merged[item.code] = item
    return tuple(merged.values())


async def _load_review_row(pool: Any, summary_id: str) -> dict[str, Any]:
    async with pool.connection() as conn:
        row = await (
            await conn.execute(
                'SELECT "id", "title", "originalKind", "originalMarkdown", '
                '"originalMeta", "originalSha256" '
                'FROM "summaries" WHERE "id" = %s',
                (summary_id,),
            )
        ).fetchone()
    if row is None:
        return {}
    try:
        return dict(row)
    except (TypeError, ValueError):
        return dict(zip((
            "id",
            "title",
            "originalKind",
            "originalMarkdown",
            "originalMeta",
            "originalSha256",
        ), row))


def _source_truncation_findings(
    *,
    kind: str,
    original_meta: Any,
    original_markdown: str = "",
) -> tuple[ContentFinding, ...]:
    """Turn source completeness metadata into deterministic findings.

    The LLM only sees excerpts, so source-side completeness must be checked
    from metadata rather than inferred from a prompt boundary.
    """
    if kind not in {"github_repo", "arxiv"}:
        return ()
    # Before 2026-09-04 the enrichment worker clipped large GitHub/arXiv
    # bodies without recording whether the reader copy was complete. Treat
    # historical large rows as unsafe until the new marker is persisted.
    if (
        isinstance(original_meta, dict)
        and original_meta.get("readerMarkdownComplete") is not True
        and len(original_markdown) >= 500_000
    ):
        return (
            _finding(
                "truncated_content",
                "blocking",
                "正文命中了历史大内容存储边界，可能在页面末尾被静默截断。",
                evidence="legacy_reader_completeness_marker_missing",
            ),
        )
    if kind != "github_repo" or not isinstance(original_meta, dict):
        return ()
    zread = original_meta.get("zread")
    if not isinstance(zread, dict):
        return ()
    try:
        page_count = int(zread.get("pageCount") or 0)
        expected_page_count = int(zread.get("expectedPageCount") or 0)
    except (TypeError, ValueError):
        page_count = expected_page_count = 0
    truncated = zread.get("truncated") is True
    if not truncated and not (
        expected_page_count > 0 and page_count < expected_page_count
    ):
        return ()
    return (
        _finding(
            "truncated_content",
            "blocking",
            "GitHub 项目文档页数不足或被截断，不能自动批准。",
            evidence=f"pages={page_count}/{expected_page_count or '?'}",
        ),
    )


async def _persist_review_state(
    pool: Any,
    *,
    summary_id: str,
    expected_sha256: str | None,
    claim_id: str | None,
    status: ReviewStatus,
    round_number: int,
    summary: dict[str, Any],
    details: dict[str, Any],
) -> None:
    async with pool.connection() as conn:
        cursor = await conn.execute(
            'UPDATE "summaries" SET '
            '"contentReviewStatus" = %s, '
            '"contentReviewRound" = %s, '
            '"contentReviewSummary" = %s::jsonb, '
            '"contentReviewDetails" = %s::jsonb, '
            '"contentReviewStartedAt" = CASE WHEN %s = \'reviewing\' '
            'THEN now() ELSE NULL END, '
            '"contentReviewClaimId" = CASE WHEN %s = \'reviewing\' '
            'THEN "contentReviewClaimId" ELSE NULL END, '
            '"contentReviewedAt" = CASE WHEN %s IN (\'approved\', \'needs_manual_review\') '
            'THEN now() ELSE "contentReviewedAt" END, '
            '"updatedAt" = now() WHERE "id" = %s '
            'AND "originalSha256" IS NOT DISTINCT FROM %s '
            'AND "contentReviewClaimId" IS NOT DISTINCT FROM %s::uuid',
            (
                status,
                round_number,
                json.dumps(summary, ensure_ascii=False),
                json.dumps(details, ensure_ascii=False),
                status,
                status,
                status,
                summary_id,
                expected_sha256,
                claim_id,
            ),
        )
        if getattr(cursor, "rowcount", 1) == 0:
            raise ContentReviewConflict(
                f"summary {summary_id} changed during content review",
            )


async def claim_content_review(
    pool: Any,
    *,
    summary_id: str,
    force: bool = False,
) -> str | None:
    """Claim one content review with a recoverable database lease.

    ``force`` is used immediately after a fresh enrichment write.  Normal
    reconciliation only claims rows that have never been reviewed or whose
    content hash changed, so a healthy row is not sent to the LLM repeatedly.
    """
    if force:
        eligibility = "TRUE"
    else:
        eligibility = (
            '("contentReviewStatus" IS NULL OR '
            '("contentReviewStatus" = \'reviewing\' AND '
            '"contentReviewStartedAt" < now() - '
            f'make_interval(secs => {CONTENT_REVIEW_STALE_MINUTES * 60})) OR '
            '("contentReviewStatus" = \'needs_manual_review\' AND '
            '"contentReviewDetails"->>\'reason\' = \'reader_quality_gate\' '
            'AND "readerQualityStatus" = \'ready\') OR '
            '("contentReviewStatus" IN (\'approved\', \'needs_manual_review\') '
            'AND "originalSha256" IS NOT NULL '
            'AND "contentReviewSummary"->>\'contentSha256\' IS DISTINCT FROM '
            '"originalSha256"))'
        )
    async with pool.connection() as conn:
        row = await (
            await conn.execute(
                'UPDATE "summaries" SET '
                '"contentReviewStatus" = \'reviewing\', '
                '"contentReviewStartedAt" = now(), '
                '"contentReviewClaimId" = gen_random_uuid(), '
                '"updatedAt" = now() '
                'WHERE "id" = %s '
                'AND "distilledTier" IN (\'collection\', \'deep_read\') '
                'AND COALESCE("originalMeta"->>\'enrichmentVersion\', \'\') = \'2.0\' '
                f'AND {eligibility} '
                'RETURNING "contentReviewClaimId"',
                (summary_id,),
            )
        ).fetchone()
    if not row:
        return None
    claim_id = row.get("contentReviewClaimId") if isinstance(row, Mapping) else row[0]
    return str(claim_id) if claim_id else None


async def persist_quality_manual_review(
    pool: Any,
    *,
    summary_id: str,
    quality: Mapping[str, Any],
    claim_id: str | None = None,
) -> None:
    """Persist a deterministic reader-quality failure without using an LLM."""
    details = {
        "reason": "reader_quality_gate",
        "quality": dict(quality),
        "rounds": [{
            "round": 1,
            "status": "needs_manual_review",
            "findings": [{
                "code": str(quality.get("reason") or "reader_quality_failed"),
                "severity": "blocking",
                "message": str(quality.get("message") or "正文未满足可阅读契约。"),
                "repairable": False,
            }],
        }],
        "maxRounds": MAX_REVIEW_ROUNDS,
    }
    async with pool.connection() as conn:
        claim_guard = ""
        claim_params: tuple[Any, ...] = ()
        if claim_id:
            claim_guard = (
                ' AND "contentReviewStatus" = \'reviewing\' '
                'AND "contentReviewClaimId" = %s::uuid'
            )
            claim_params = (claim_id,)
        expected_sha256 = str(quality.get("contentSha256") or "")
        snapshot_guard = ""
        snapshot_params: tuple[Any, ...] = ()
        if expected_sha256:
            snapshot_guard = (
                ' AND "originalSha256" IS NOT DISTINCT FROM %s'
            )
            snapshot_params = (expected_sha256,)
        cursor = await conn.execute(
            'UPDATE "summaries" SET '
            '"contentReviewStatus" = \'needs_manual_review\', '
            '"contentReviewRound" = 1, '
            '"contentReviewSummary" = %s::jsonb, '
            '"contentReviewDetails" = %s::jsonb, '
            '"contentReviewStartedAt" = NULL, '
            '"contentReviewClaimId" = NULL, '
            '"contentReviewedAt" = now(), '
            '"updatedAt" = now() WHERE "id" = %s'
            f'{snapshot_guard}'
            f'{claim_guard}',
            (
                json.dumps({
                    "status": "needs_manual_review",
                    "reason": "reader_quality_gate",
                    "quality": dict(quality),
                }, ensure_ascii=False),
                json.dumps(details, ensure_ascii=False),
                summary_id,
                *snapshot_params,
                *claim_params,
            ),
        )
        if getattr(cursor, "rowcount", 1) == 0:
            raise ContentReviewConflict(
                f"summary {summary_id} changed before quality review persisted",
            )


async def _persist_repaired_markdown(
    pool: Any,
    *,
    summary_id: str,
    expected_sha256: str | None,
    expected_markdown: str,
    markdown: str,
    claim_id: str | None,
) -> None:
    encoded = markdown.encode("utf-8")
    if expected_sha256 is None:
        snapshot_guard = (
            'AND "originalSha256" IS NULL '
            'AND "originalMarkdown" IS NOT DISTINCT FROM %s'
        )
        snapshot_params: tuple[Any, ...] = (expected_markdown,)
    else:
        snapshot_guard = 'AND "originalSha256" IS NOT DISTINCT FROM %s'
        snapshot_params = (expected_sha256,)
    async with pool.connection() as conn:
        cursor = await conn.execute(
            'UPDATE "summaries" SET '
            '"originalMarkdown" = %s, '
            '"originalSha256" = %s, '
            '"originalBytes" = %s, '
            '"updatedAt" = now() WHERE "id" = %s '
            f'{snapshot_guard} '
            'AND "contentReviewClaimId" IS NOT DISTINCT FROM %s::uuid',
            (
                markdown,
                hashlib.sha256(encoded).hexdigest(),
                len(encoded),
                summary_id,
                *snapshot_params,
                claim_id,
            ),
        )
        if getattr(cursor, "rowcount", 1) == 0:
            raise ContentReviewConflict(
                f"summary {summary_id} changed before safe repair",
            )


async def run_content_review_cycle(
    pool: Any,
    *,
    summary_id: str,
    claim_id: str | None = None,
) -> ReviewCycleResult:
    """Review one enriched Summary with a bounded two-round cycle."""
    cycle_id = uuid.uuid4().hex
    row = await _load_review_row(pool, summary_id)
    markdown = str(row.get("originalMarkdown") or "")
    title = str(row.get("title") or "")
    kind = str(row.get("originalKind") or "")
    snapshot_sha256 = (
        str(row.get("originalSha256"))
        if row.get("originalSha256") is not None
        else None
    )
    source_findings = _source_truncation_findings(
        kind=kind,
        original_meta=row.get("originalMeta"),
        original_markdown=markdown,
    )
    if not markdown.strip():
        empty_details: dict[str, Any] = {
            "cycleId": cycle_id,
            "rounds": [{
                "round": 1,
                "status": "needs_manual_review",
                "findings": [{
                    "code": "empty_content",
                    "severity": "blocking",
                    "message": "enrichment 没有可供阅读的正文。",
                    "repairable": False,
                }],
            }],
            "reason": "empty_content",
        }
        await _persist_review_state(
            pool,
            summary_id=summary_id,
            expected_sha256=snapshot_sha256,
            claim_id=claim_id,
            status="needs_manual_review",
            round_number=1,
            summary={"status": "needs_manual_review", "reason": "empty_content"},
            details=empty_details,
        )
        return ReviewCycleResult("needs_manual_review", 1, cycle_id, empty_details)

    rounds: list[dict[str, Any]] = []
    final_status: ReviewStatus = "needs_manual_review"
    final_round = 1
    for round_number in range(1, MAX_REVIEW_ROUNDS + 1):
        before_hash = hashlib.sha256(markdown.encode("utf-8")).hexdigest()
        deterministic = (*inspect_content(markdown), *source_findings)
        agent = await _review_with_agent(
            title=title,
            kind=kind,
            markdown=markdown,
            deterministic=deterministic,
        )
        merged = _merge_findings(deterministic, agent)
        round_record: dict[str, Any] = {
            "round": round_number,
            "beforeSha256": before_hash,
            "agent": {
                "available": agent.available,
                "status": agent.status,
                "summary": agent.summary,
                "error": agent.error,
            },
            "findings": [item.to_dict() for item in merged],
        }

        if not agent.available:
            round_record["status"] = "needs_manual_review"
            rounds.append(round_record)
            final_status = "needs_manual_review"
            final_round = round_number
            break
        if not merged and agent.status == "approved":
            round_record["status"] = "approved"
            rounds.append(round_record)
            final_status = "approved"
            final_round = round_number
            break

        repairable = tuple(item for item in merged if item.repairable)
        repaired = repair_content(markdown, repairable) if repairable else markdown
        if repaired != markdown and round_number < MAX_REVIEW_ROUNDS:
            await _persist_repaired_markdown(
                pool,
                summary_id=summary_id,
                expected_sha256=snapshot_sha256,
                expected_markdown=markdown,
                markdown=repaired,
                claim_id=claim_id,
            )
            round_record["status"] = "repaired"
            round_record["repair"] = {
                "codes": [item.code for item in repairable],
                "changed": True,
                "afterSha256": hashlib.sha256(repaired.encode("utf-8")).hexdigest(),
            }
            rounds.append(round_record)
            markdown = repaired
            snapshot_sha256 = hashlib.sha256(
                repaired.encode("utf-8")
            ).hexdigest()
            final_status = "reviewing"
            final_round = round_number
            reviewing_details: dict[str, Any] = {
                "cycleId": cycle_id,
                "rounds": rounds,
                "maxRounds": MAX_REVIEW_ROUNDS,
            }
            await _persist_review_state(
                pool,
                summary_id=summary_id,
                expected_sha256=snapshot_sha256,
                claim_id=claim_id,
                status="reviewing",
                round_number=round_number,
                summary={
                    "status": "reviewing",
                    "findingCount": len(merged),
                    "repairCount": len(repairable),
                },
                details=reviewing_details,
            )
            continue

        round_record["status"] = "needs_manual_review"
        round_record["repair"] = {
            "codes": [item.code for item in repairable],
            "changed": repaired != markdown,
            "blockedBy": (
                "max_rounds"
                if round_number >= MAX_REVIEW_ROUNDS
                else "no_safe_repair"
            ),
        }
        rounds.append(round_record)
        final_status = "needs_manual_review"
        final_round = round_number
        break

    details: dict[str, Any] = {
        "cycleId": cycle_id,
        "rounds": rounds,
        "maxRounds": MAX_REVIEW_ROUNDS,
    }
    final_findings = rounds[-1].get("findings", []) if rounds else []
    await _persist_review_state(
        pool,
        summary_id=summary_id,
        expected_sha256=snapshot_sha256,
        claim_id=claim_id,
        status=final_status,
        round_number=final_round,
        summary={
            "status": final_status,
            "findingCount": len(final_findings),
            "rounds": len(rounds),
            "contentSha256": hashlib.sha256(markdown.encode("utf-8")).hexdigest(),
        },
        details=details,
    )
    return ReviewCycleResult(final_status, final_round, cycle_id, details)


__all__ = [
    "ContentReviewConflict",
    "ContentFinding",
    "ReviewCycleResult",
    "claim_content_review",
    "inspect_content",
    "persist_quality_manual_review",
    "repair_content",
    "run_content_review_cycle",
]
