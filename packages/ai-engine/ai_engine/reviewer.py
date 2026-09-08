"""Independent report review agent and deterministic fact resolvers.

The generator produces prose; this module reviews claims against captured
evidence and authoritative APIs.  The reviewer never silently promotes an
unverified claim to ``verified``.
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
from difflib import SequenceMatcher
from typing import Any, Awaitable, Callable, Literal, Protocol, cast
from urllib.parse import urlsplit

import httpx

from ai_engine.adapters.base import AdapterSource
from ai_engine.fact_resolvers import (
    arxiv_identifier_from_url,
    github_repo_from_url,
    npm_package_from_url,
    pypi_package_from_url,
    resolve_arxiv_paper,
    resolve_github_repository,
    resolve_npm_package,
    resolve_pypi_package,
)
from ai_engine.llm.client import generate_text

ReviewStatus = Literal["passed", "needs_revision", "blocked", "review_unavailable"]
ReviewProgressCallback = Callable[[str, dict[str, object]], Awaitable[None]]
ReviewErrorCode = Literal[
    "timeout",
    "invalid_output",
    "provider_unavailable",
    "no_captured_evidence",
]
ClaimRisk = Literal["high", "medium", "low", "opinion"]
ClaimType = Literal[
    "external_fact",
    "research_process",
    "interpretation",
    "citation_relationship",
]
ClaimVerdictStatus = Literal[
    "verified", "correctable", "contradicted", "unsupported",
    "unverified", "not_applicable",
]
ClaimJudgmentStatus = Literal[
    "settled", "not_judged", "execution_failed", "disputed",
]

_EVIDENCE_GAP_VERDICTS = frozenset({"unsupported", "unverified", "contradicted"})
_EVIDENCE_GAP_INSTRUCTION_LIMIT = 8
_RISK_ORDER: dict[ClaimRisk, int] = {
    "high": 0,
    "medium": 1,
    "low": 2,
    "opinion": 3,
}

_STAR_RE = re.compile(
    r"(?P<prefix>(?:GitHub\s*)?(?:stars?|stargazers?|star\s*数|星标数)\s*[:：]?\s*)"
    r"(?P<number>\d[\d,.]*\s*[kKm万]?)"
    r"|(?P<number_before>\d[\d,.]*\s*[kKm万]?)"
    r"(?P<suffix>\s*(?:个?\s*)?(?:GitHub\s*)?(?:stars?|stargazers?|star\s*数|星标数))",
    re.IGNORECASE,
)
_REPO_RE = re.compile(r"^/([^/]+)/([^/]+)/?$")
_FORK_RE = re.compile(
    r"(?P<number>\d[\d,.]*\s*[kKm万]?)\s*(?:个?\s*)?(?:GitHub\s*)?forks?",
    re.IGNORECASE,
)
_LICENSE_RE = re.compile(
    r"(?:许可证|license|licence)\s*[:：]?\s*(?P<license>Apache-2\.0|MIT|GPL-?\d(?:\.\d)?|BSD-\d-Clause)",
    re.IGNORECASE,
)
_VERSION_RE = re.compile(
    r"(?:版本|version|release)\s*[:：]?\s*[vV]?(?P<version>\d+\.\d+(?:\.\d+)?)",
    re.IGNORECASE,
)
_DATE_RE = re.compile(
    r"(?P<label>最近一次提交|最后更新|published|released|发布于|updated)\s*[:：]?\s*"
    r"(?P<date>20\d{2}[-年/.]\d{1,2}(?:[-月/.]\d{1,2}日?)?)",
    re.IGNORECASE,
)
_CITATION_RE = re.compile(
    # Accept the citation shapes emitted by different report writers:
    # ``Autonoma, 2026``, ``Autonoma，2026`` and ``Autonoma 2026``.
    # The source matcher below still has to map the label to a captured URL,
    # so this wider separator does not turn every year in the report into a
    # claim.
    r"(?P<author>[A-Za-z][A-Za-z0-9 .&'/-]{1,60}?)(?:\s*[,，]\s*|\s+)(?P<year>20\d{2})",
)


@dataclass(slots=True, frozen=True)
class Claim:
    id: str
    text: str
    risk: ClaimRisk
    location: tuple[int, int] | None = None
    fact_type: str = "generic"
    value: str | None = None


@dataclass(slots=True, frozen=True)
class ClaimInventoryItem:
    """A report statement before any evidence judgment is made.

    Claim extraction and evidence adjudication are intentionally separate
    contracts.  A missing quote must not make the extractor silently drop a
    statement, and a model must not be allowed to invent a new statement
    while judging evidence for another one.
    """

    claim_id: str
    claim: str
    risk: ClaimRisk
    claim_type: ClaimType
    # Compatibility only: old one-shot providers may echo a verdict in the
    # inventory response. The new extraction contract ignores this field.
    legacy_verdict: ClaimVerdictStatus | None = None


@dataclass(slots=True, frozen=True)
class ClaimEvidence:
    claim_id: str
    source_url: str | None
    excerpt: str | None
    observed_at: str | None
    resolver: str | None


@dataclass(slots=True, frozen=True)
class ClaimVerdict:
    claim_id: str
    claim: str
    risk: ClaimRisk
    verdict: ClaimVerdictStatus
    evidence: ClaimEvidence | None = None
    correction: str | None = None
    reason: str | None = None
    # A verdict is epistemic; this field records whether the adjudication
    # actually completed.  In particular, a timeout must not look like an
    # ordinary ``unverified`` evidence gap.
    judgment_status: ClaimJudgmentStatus = "settled"
    execution_error_code: str | None = None
    # Character offsets in the reviewed report.  This is navigation metadata,
    # not evidence: it lets the UI take the reader to the exact sentence that
    # needs attention without pretending that a model verdict is a text edit.
    location: tuple[int, int] | None = None
    # The review strategy depends on what kind of statement this is.  A
    # report can contain observations about this run (for example, which
    # pages were actually captured) and recommendations alongside external
    # facts.  Treating all three as external facts creates false review work.
    claim_type: ClaimType = "external_fact"


@dataclass(slots=True, frozen=True)
class ReviewResult:
    status: ReviewStatus
    claims: tuple[ClaimVerdict, ...] = ()
    revision_instructions: tuple[str, ...] = ()
    reviewed_report: str | None = None
    error: str | None = None
    # A stable, user-safe reason for an unavailable review.  ``error`` stays
    # as a diagnostic detail for compatibility, but callers must not expose
    # raw provider/exception text as if it were a factual verdict.
    error_code: ReviewErrorCode | None = None
    attempts: int = 1
    # ``complete`` means the reviewer returned a usable verdict for the
    # factual statements it was asked to inspect.  ``insufficient`` is a
    # coverage failure, not a factual failure: the report is substantial but
    # the reviewer did not produce a claim inventory.  ``not_applicable`` is
    # reserved for genuinely non-factual, short output.
    coverage_status: Literal["complete", "insufficient", "not_applicable"] = "complete"
    # Evidence adjudication is resumable at the batch boundary. These are
    # operational facts, not quality scores: a failed batch remains
    # uncovered instead of being counted as a factual contradiction.
    batch_count: int = 0
    completed_batch_count: int = 0
    failed_batch_count: int = 0
    judged_claim_count: int = 0
    total_claim_count: int = 0

    @staticmethod
    def _is_citation_relationship(item: ClaimVerdict) -> bool:
        return bool(
            item.claim_type == "citation_relationship"
            or (
                item.evidence
                and item.evidence.resolver == "captured-source-citation"
            )
        )

    @classmethod
    def _is_factual_claim(cls, item: ClaimVerdict) -> bool:
        # ``not_applicable`` is an intentional disposition for opinions,
        # recommendations, and other non-factual prose. It is part of the
        # audit record, but not a fact-review work item or a pending gap.
        return (
            item.claim_type == "external_fact"
            and
            item.risk != "opinion"
            and item.verdict != "not_applicable"
            and not cls._is_citation_relationship(item)
        )

    @property
    def corrected_count(self) -> int:
        return sum(
            self._is_factual_claim(item) and item.verdict == "correctable"
            for item in self.claims
        )

    @property
    def unverified_count(self) -> int:
        # A citation relationship only says that the report pointed to a
        # captured source.  It is intentionally not counted as an
        # unsupported factual statement; otherwise a reviewer timeout turns
        # every citation into a false "fact failure".
        return sum(
            self._is_factual_claim(item)
            and item.judgment_status == "settled"
            and item.verdict in {"unverified", "unsupported"}
            for item in self.claims
        )

    @property
    def not_judged_count(self) -> int:
        return sum(
            self._is_factual_claim(item)
            and item.judgment_status == "not_judged"
            for item in self.claims
        )

    @property
    def execution_failed_claim_count(self) -> int:
        return sum(
            self._is_factual_claim(item)
            and item.judgment_status == "execution_failed"
            for item in self.claims
        )

    @property
    def disputed_count(self) -> int:
        return sum(
            self._is_factual_claim(item)
            and item.judgment_status == "disputed"
            for item in self.claims
        )

    @property
    def contradicted_count(self) -> int:
        return sum(
            self._is_factual_claim(item) and item.verdict == "contradicted"
            for item in self.claims
        )

    @property
    def factual_claim_count(self) -> int:
        return sum(self._is_factual_claim(item) for item in self.claims)

    @property
    def citation_count(self) -> int:
        return sum(self._is_citation_relationship(item) for item in self.claims)

    @property
    def citation_pending_count(self) -> int:
        return sum(
            self._is_citation_relationship(item)
            and item.verdict in {"unverified", "unsupported"}
            for item in self.claims
        )

    @property
    def evidence_binding_repaired_count(self) -> int:
        """Number of claim/source links repaired from the captured ledger.

        This is deliberately not a verified-count.  The reconciliation pass
        only proves that a claim can be taken back to a saved excerpt; it does
        not decide that the excerpt semantically supports the claim.
        """
        return sum(
            item.evidence is not None
            and item.evidence.resolver == "captured-source-reconciler"
            for item in self.claims
        )

    @property
    def evidence_gap_count(self) -> int:
        """Number of factual claims that still lack a clean evidence link.

        Opinions are intentionally excluded from this counter.  A reviewer
        may still return an opinion as ``unsupported`` for compatibility with
        older prompts, but that is not a reason to present a recommendation
        as a missing fact.
        """
        return sum(
            self._is_factual_claim(item)
            and item.judgment_status == "settled"
            and item.verdict in _EVIDENCE_GAP_VERDICTS
            for item in self.claims
        )

    @property
    def evidence_gap_instruction_count(self) -> int:
        return min(self.evidence_gap_count, _EVIDENCE_GAP_INSTRUCTION_LIMIT)

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["corrected_count"] = self.corrected_count
        value["unverified_count"] = self.unverified_count
        value["not_judged_count"] = self.not_judged_count
        value["execution_failed_claim_count"] = self.execution_failed_claim_count
        value["disputed_count"] = self.disputed_count
        value["contradicted_count"] = self.contradicted_count
        value["evidence_gap_count"] = self.evidence_gap_count
        value["evidence_gap_instruction_count"] = self.evidence_gap_instruction_count
        value["factual_claim_count"] = self.factual_claim_count
        value["citation_count"] = self.citation_count
        value["citation_pending_count"] = self.citation_pending_count
        value["evidence_binding_repaired_count"] = self.evidence_binding_repaired_count
        value["coverage_status"] = self.coverage_status
        value["batch_count"] = self.batch_count
        value["completed_batch_count"] = self.completed_batch_count
        value["failed_batch_count"] = self.failed_batch_count
        value["judged_claim_count"] = self.judged_claim_count
        value["total_claim_count"] = self.total_claim_count
        value["review_outcome"] = _review_outcome(self)
        return value


class ResearchReviewer(Protocol):
    async def review(
        self,
        report: str,
        sources: tuple[AdapterSource, ...],
        topic: str,
        *,
        report_type: str = "research_report",
        phase_callback: ReviewProgressCallback | None = None,
    ) -> ReviewResult:
        ...


def _repo_from_url(value: str) -> str | None:
    parsed = urlsplit(value.strip())
    if parsed.netloc.lower() not in {"github.com", "www.github.com"}:
        return None
    match = _REPO_RE.match(parsed.path)
    return f"{match.group(1)}/{match.group(2)}" if match else None


def _parse_count(value: str) -> float | None:
    compact = value.replace(",", "").replace(" ", "").lower()
    multiplier = 1
    if compact.endswith("k"):
        multiplier, compact = 1_000, compact[:-1]
    elif compact.endswith("万"):
        multiplier, compact = 10_000, compact[:-1]
    try:
        return float(compact) * multiplier
    except ValueError:
        return None


def _github_headers() -> dict[str, str]:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "deep-research-reviewer/0.1",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    token = os.environ.get("GH_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _captured_sources(sources: tuple[AdapterSource, ...]) -> tuple[AdapterSource, ...]:
    """Only expose sources whose body was actually captured to the reviewer."""
    return tuple(
        source
        for source in sources
        if source.evidence_status == "fetched" and (source.snippet or "").strip()
    )


def _source_urls(sources: tuple[AdapterSource, ...]) -> set[str]:
    urls: set[str] = set()
    for source in _captured_sources(sources):
        if source.canonical_key.startswith(("http://", "https://")):
            urls.add(source.canonical_key)
        value = source.source_ref.get("value")
        if isinstance(value, str) and value.startswith(("http://", "https://")):
            urls.add(value)
    return urls


def _report_body_without_references(report: str) -> str:
    """Return report prose without the generated bibliography.

    The bibliography contains URLs by design, but it is not a claim-to-
    evidence relationship.  Citation fallback must only inspect prose.
    """
    match = re.search(r"(?im)^#{1,6}\s*(?:参考文献|参考资料|参考来源|References?|Sources?)\s*[:：]?\s*$", report)
    return report[: match.start()] if match else report


def _source_descriptor(source: AdapterSource) -> str:
    values = [source.title or "", source.canonical_key]
    ref_value = source.source_ref.get("value") if isinstance(source.source_ref, dict) else None
    if isinstance(ref_value, str):
        values.append(ref_value)
    return " ".join(values).lower()


def _citation_matches_source(author: str, source: AdapterSource) -> bool:
    """Match a report's author-year citation to a captured source conservatively."""
    descriptor = _source_descriptor(source)
    normalized_author = re.sub(r"[^a-z0-9]+", "", author.lower())
    if not normalized_author:
        return False
    normalized_descriptor = re.sub(r"[^a-z0-9]+", "", descriptor)
    if normalized_author in normalized_descriptor:
        return True
    # A surname or publisher token can be enough (e.g. ``Seidl`` in
    # ``richard-seidl.com``), but never match short generic words.
    tokens = [re.sub(r"[^a-z0-9]+", "", token.lower()) for token in author.split()]
    return any(len(token) >= 5 and token in normalized_descriptor for token in tokens)


def _citation_url_matches_source(url: str, source: AdapterSource) -> bool:
    values = [source.canonical_key]
    if isinstance(source.source_ref, dict):
        ref_value = source.source_ref.get("value")
        if isinstance(ref_value, str):
            values.append(ref_value)
    normalized_url = _evidence_url_key(url)
    if not normalized_url:
        return False
    return any(
        value.startswith(("http://", "https://"))
        and _evidence_url_key(value) == normalized_url
        for value in values
    )


def _evidence_url_key(value: str) -> str:
    """Normalize an evidence URL without widening its origin or path.

    Evidence is a publication boundary.  We may ignore a harmless fragment
    and trailing slash difference, but must keep host, path and query exact so
    a model cannot attach a claim to a merely similar page.
    """
    parsed = urlsplit(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    # www/non-www is a presentation variant of the same public page for the
    # evidence ledger. Keep path and query strict, but do not downgrade a
    # valid citation merely because the writer copied the browser-facing host.
    host = (parsed.hostname or "").lower().removeprefix("www.")
    if not host:
        return ""
    port = parsed.port
    default_port = (parsed.scheme == "http" and port == 80) or (
        parsed.scheme == "https" and port == 443
    )
    authority = host if not port or default_port else f"{host}:{port}"
    path = parsed.path.rstrip("/") or "/"
    return f"{parsed.scheme.lower()}://{authority}{path}" + (
        f"?{parsed.query}" if parsed.query else ""
    )


def _captured_source_for_evidence_url(
    source_url: str | None,
    sources: tuple[AdapterSource, ...],
) -> AdapterSource | None:
    if not isinstance(source_url, str):
        return None
    evidence_key = _evidence_url_key(source_url)
    if not evidence_key:
        return None
    for source in sources:
        candidates = [source.canonical_key]
        if isinstance(source.source_ref, dict):
            ref_value = source.source_ref.get("value")
            if isinstance(ref_value, str):
                candidates.append(ref_value)
        if any(_evidence_url_key(candidate) == evidence_key for candidate in candidates):
            return source
    return None


def _evidence_excerpt_matches_source(excerpt: str | None, source: AdapterSource) -> bool:
    """Require the model's excerpt to be present in the captured source text."""
    if not isinstance(excerpt, str) or not excerpt.strip():
        return False
    source_text = " ".join((source.snippet or "").split()).strip()
    evidence_text = " ".join(excerpt.split()).strip().strip("\"'“”‘’「」『』")
    if not source_text or not evidence_text:
        return False
    # Very short matches are not inspectable evidence: words such as "API"
    # or "是" occur in unrelated paragraphs and make false support easy.
    if len(evidence_text) < 12:
        return False
    return evidence_text.casefold() in source_text.casefold()


def _validate_llm_evidence(
    result: ReviewResult,
    sources: tuple[AdapterSource, ...],
) -> ReviewResult:
    """Fail closed when an LLM verdict is not bound to captured text.

    The reviewer prompt asks for source URL + verbatim excerpt, but prompts
    are not a security boundary.  Only factual verified/correctable/
    contradicted claims are normalized here; opinions can legitimately be
    marked ``not_applicable`` without evidence.  Deterministic resolver
    findings (GitHub/package/paper APIs) bypass this function and carry their
    own authoritative evidence contract.
    """
    changed = False
    claims: list[ClaimVerdict] = []
    for claim in result.claims:
        if claim.claim_type != "external_fact" or claim.risk == "opinion" or claim.verdict not in {
            "verified", "correctable", "contradicted"
        }:
            claims.append(claim)
            continue

        evidence = claim.evidence
        captured = _captured_source_for_evidence_url(
            evidence.source_url if evidence else None,
            sources,
        )
        valid = captured is not None and _evidence_excerpt_matches_source(
            evidence.excerpt if evidence else None,
            captured,
        )
        if valid:
            claims.append(claim)
            continue

        changed = True
        if evidence is None or not evidence.source_url or not evidence.excerpt:
            reason = "审核结果没有提供可核对的来源地址和原文摘录"
        elif captured is None:
            reason = "审核结果引用的地址不属于本轮已抓取来源"
        else:
            reason = "审核结果的摘录无法在本轮保存的来源正文中找到"
        claims.append(
            ClaimVerdict(
                claim_id=claim.claim_id,
                claim=claim.claim,
                risk=claim.risk,
                verdict="unverified",
                evidence=None,
                correction=claim.correction,
                reason=reason,
                judgment_status=claim.judgment_status,
                execution_error_code=claim.execution_error_code,
                location=claim.location,
                claim_type=claim.claim_type,
            )
        )

    if not changed:
        return result
    return ReviewResult(
        status=_status_for_claims(claims),
        claims=tuple(claims),
        revision_instructions=result.revision_instructions,
        reviewed_report=result.reviewed_report,
        error=result.error,
        error_code=result.error_code,
        attempts=result.attempts,
        coverage_status=result.coverage_status,
        batch_count=result.batch_count,
        completed_batch_count=result.completed_batch_count,
        failed_batch_count=result.failed_batch_count,
        judged_claim_count=result.judged_claim_count,
        total_claim_count=result.total_claim_count,
    )


_BINDING_STOP_WORDS = frozenset({
    "这条", "该条", "声明", "报告", "内容", "表示", "说明", "提到", "提及",
    "支持", "认为", "可以", "能够", "具有", "属于", "相关", "项目", "系统",
    "the", "this", "that", "claim", "report", "says", "shows", "supports",
})


def _binding_terms(value: str) -> tuple[str, ...]:
    """Extract conservative anchors for matching against saved source text.

    This is intentionally lexical rather than semantic.  A lexical hit can
    repair a lost source binding, but it must never upgrade an unverified
    claim to verified: the latter remains the reviewer's job.
    """
    terms: list[str] = []
    for token in re.findall(r"[A-Za-z][A-Za-z0-9+#._-]{2,}|[\u4e00-\u9fff]{2,}", value.casefold()):
        compact = re.sub(r"\s+", "", token)
        if compact in _BINDING_STOP_WORDS:
            continue
        if re.fullmatch(r"[\u4e00-\u9fff]+", compact):
            # Chinese words are not whitespace-delimited. Keep the longer
            # run, plus its bigrams, so a source with a small wording change
            # can still be found without matching on a single generic noun.
            if len(compact) >= 2:
                terms.append(compact)
            if len(compact) >= 4:
                terms.extend(compact[index:index + 2] for index in range(len(compact) - 1))
        else:
            terms.append(compact)
    return tuple(dict.fromkeys(terms))


def _source_evidence_url(source: AdapterSource) -> str | None:
    values = (
        source.source_ref.get("value") if isinstance(source.source_ref, dict) else None,
        source.canonical_key,
    )
    return next(
        (value for value in values if isinstance(value, str) and value.startswith(("http://", "https://"))),
        None,
    )


def _source_excerpt_for_binding(source: AdapterSource, claim: str) -> str | None:
    """Return the most claim-relevant bounded excerpt from one source."""
    raw = " ".join((source.snippet or "").split()).strip()
    if not raw:
        return None
    terms = _binding_terms(claim)
    if not terms:
        return None

    segments = [segment.strip() for segment in re.split(r"(?<=[。！？!?；;])|\n+", raw) if segment.strip()]
    if not segments:
        segments = [raw]
    best: tuple[float, str] | None = None
    for segment in segments:
        normalized = segment.casefold()
        hits = sum(1 for term in terms if term in normalized)
        ascii_terms = [term for term in terms if re.fullmatch(r"[a-z0-9+#._-]+", term)]
        ascii_hits = sum(1 for term in ascii_terms if term in normalized)
        coverage = hits / max(1, len(terms))
        # A complete/near-complete phrase is the strongest repair signal. For
        # paraphrased Chinese prose require several anchors; for ASCII-heavy
        # technical claims require at least two non-generic anchors.
        phrase = re.sub(r"[^\w]+", "", claim.casefold(), flags=re.UNICODE)
        normalized_segment = re.sub(r"[^\w]+", "", normalized, flags=re.UNICODE)
        phrase_match = len(phrase) >= 16 and phrase in normalized_segment
        ascii_coverage = ascii_hits / max(1, len(ascii_terms))
        # Technical claims often mix a short Chinese lead-in with a list of
        # product/API names (for example, “目录中提及 Playwright MCP、CLI、
        # API、Test、Agents、Annotations”).  Requiring the English anchors
        # to cover the Chinese connective words makes a real saved excerpt
        # look absent.  For binding repair, a high coverage of distinctive
        # ASCII anchors is sufficient; this still only creates a candidate
        # evidence link and never changes the semantic verdict.
        strong = (
            phrase_match
            or (ascii_hits >= 2 and ascii_coverage >= 0.8)
            or (ascii_hits >= 1 and hits >= 4 and coverage >= 0.55)
        )
        if not strong:
            continue
        score = coverage + (0.35 if phrase_match else 0.0) + min(ascii_hits, 4) * 0.04
        candidate = (score, segment[:900])
        if best is None or candidate[0] > best[0]:
            best = candidate
    return best[1] if best else None


def _reconcile_unbound_evidence(
    result: ReviewResult,
    sources: tuple[AdapterSource, ...],
) -> ReviewResult:
    """Repair lost claim/source bindings before creating user work.

    There are two different situations:

    * the captured ledger contains a relevant excerpt but the reviewer did
      not bind it to the claim; and
    * no captured excerpt is relevant, so new evidence may really be needed.

    Only the first situation is repaired here.  The claim remains
    ``unverified`` and the next action remains "reverify current sources".
    This prevents an implementation detail of the reviewer from becoming an
    unnecessary external research task while keeping the publication gate
    conservative.
    """
    captured = _captured_sources(sources)
    if not captured:
        return result

    changed = False
    reconciled: list[ClaimVerdict] = []
    for claim in result.claims:
        evidence_is_bound = (
            claim.evidence is not None
            and (
                captured_source := _captured_source_for_evidence_url(
                    claim.evidence.source_url,
                    captured,
                )
            ) is not None
            and _evidence_excerpt_matches_source(claim.evidence.excerpt, captured_source)
        )
        if (
            claim.claim_type != "external_fact"
            or claim.risk == "opinion"
            or claim.verdict not in {"unsupported", "unverified"}
            or evidence_is_bound
        ):
            reconciled.append(claim)
            continue

        matches: list[tuple[float, AdapterSource, str]] = []
        for source in captured:
            excerpt = _source_excerpt_for_binding(source, claim.claim)
            if not excerpt:
                continue
            # Score the same excerpt with the full source to prefer the most
            # specific source when several pages share a common vocabulary.
            terms = _binding_terms(claim.claim)
            source_text = " ".join((source.title or "", source.snippet or "")).casefold()
            hits = sum(1 for term in terms if term in source_text)
            ascii_terms = [term for term in terms if re.fullmatch(r"[a-z0-9+#._-]+", term)]
            ascii_hits = sum(1 for term in ascii_terms if term in source_text)
            # Keep the score aligned with _source_excerpt_for_binding: a
            # mixed-language technical list is strong when its distinctive
            # product/API anchors are present even if Chinese connective
            # words are absent from the captured page.
            lexical_coverage = hits / max(1, len(terms))
            ascii_coverage = ascii_hits / max(1, len(ascii_terms))
            score = max(lexical_coverage, ascii_coverage if ascii_hits >= 2 else 0.0)
            matches.append((score, source, excerpt))

        if not matches:
            reconciled.append(claim)
            continue
        matches.sort(key=lambda item: item[0], reverse=True)
        best = matches[0]
        # Do not bind an ambiguous weak match. A user should be asked for new
        # evidence rather than being shown a plausible but wrong source.
        if best[0] < 0.55 or (len(matches) > 1 and best[0] - matches[1][0] < 0.08):
            reconciled.append(claim)
            continue

        changed = True
        reconciled.append(replace(
            claim,
            evidence=ClaimEvidence(
                claim_id=claim.claim_id,
                source_url=_source_evidence_url(best[1]),
                excerpt=best[2],
                observed_at=datetime.now(timezone.utc).isoformat(),
                resolver="captured-source-reconciler",
            ),
            reason=(
                "系统已从本轮保存的资料中补全可核对摘录；"
                "这只修复了声明与来源的绑定，尚未据此判定声明成立。"
            ),
        ))

    if not changed:
        return result
    return ReviewResult(
        status=_status_for_claims(reconciled),
        claims=tuple(reconciled),
        revision_instructions=result.revision_instructions,
        reviewed_report=result.reviewed_report,
        error=result.error,
        error_code=result.error_code,
        attempts=result.attempts,
        coverage_status=result.coverage_status,
        batch_count=result.batch_count,
        completed_batch_count=result.completed_batch_count,
        failed_batch_count=result.failed_batch_count,
        judged_claim_count=result.judged_claim_count,
        total_claim_count=result.total_claim_count,
    )


def _review_error_code(exc: BaseException) -> ReviewErrorCode:
    """Map provider/parser failures to a small stable UI vocabulary."""
    message = str(exc).lower()
    if isinstance(exc, (TimeoutError, httpx.TimeoutException)) or any(
        token in message for token in ("timeout", "timed out", "time out", "超时")
    ):
        return "timeout"
    if isinstance(exc, ValueError) or any(
        token in message
        for token in ("json", "parse", "解析", "not an object", "no json")
    ):
        return "invalid_output"
    return "provider_unavailable"


def _citation_ledger(
    report: str,
    sources: tuple[AdapterSource, ...],
) -> list[ClaimVerdict]:
    """Represent explicit report citations without claiming they are proven.

    This is intentionally a conservative fallback for malformed/empty LLM
    reviewer output.  A citation proves only that the report pointed at a
    source; it does not prove that the source supports the sentence.
    """
    sources = _captured_sources(sources)
    verdicts: list[ClaimVerdict] = []
    seen: set[tuple[str, str]] = set()
    observed_at = datetime.now(timezone.utc).isoformat()

    def append_citation(sentence: str, source: AdapterSource) -> None:
        source_url = next(
            (
                value
                for value in (
                    source.source_ref.get("value") if isinstance(source.source_ref, dict) else None,
                    source.canonical_key,
                )
                if isinstance(value, str) and value.startswith(("http://", "https://"))
            ),
            None,
        )
        if not source_url or (sentence, source_url) in seen:
            return
        seen.add((sentence, source_url))
        claim_id = f"citation-{len(verdicts) + 1}"
        verdicts.append(
            ClaimVerdict(
                claim_id=claim_id,
                claim=sentence,
                risk="medium",
                verdict="unverified",
                evidence=ClaimEvidence(
                    claim_id=claim_id,
                    source_url=source_url,
                    excerpt=source.snippet,
                    observed_at=observed_at,
                    resolver="captured-source-citation",
                ),
                reason=(
                    "报告引用了该来源，但本轮自动审核没有确认原文直接支持这句话；"
                    "请打开来源核对。"
                ),
                claim_type="citation_relationship",
            )
        )

    for line in _report_body_without_references(report).splitlines():
        sentence = re.sub(r"[*_`]+", "", line).strip()
        if not sentence:
            continue

        before_line = len(verdicts)

        # A direct Markdown link is the least ambiguous citation form.  It
        # is ledgered only when its URL is one of the URLs captured this run.
        for link in re.finditer(r"\[[^\]]+\]\((https?://[^)\s]+)\)", sentence, re.IGNORECASE):
            source = next(
                (item for item in sources if _citation_url_matches_source(link.group(1), item)),
                None,
            )
            if source is not None:
                append_citation(sentence, source)

        for match in _CITATION_RE.finditer(sentence):
            author = match.group("author").strip()
            source = next((item for item in sources if _citation_matches_source(author, item)), None)
            if source is None:
                continue
            append_citation(sentence, source)
            if len(verdicts) >= 24:
                return verdicts

        # The report cleaner deliberately keeps a visible marker when the
        # writer cited a URL that was not captured in this run. If no captured
        # source could be mapped above, preserve that relationship as an
        # explicit unverified claim instead of silently dropping it from the
        # audit ledger. A visible marker without a source excerpt is a gap,
        # not evidence.
        if len(verdicts) == before_line and "链接未被本次来源验证" in sentence:
            claim_id = f"citation-unverified-{len(verdicts) + 1}"
            verdicts.append(
                ClaimVerdict(
                    claim_id=claim_id,
                    claim=sentence,
                    risk="medium",
                    verdict="unverified",
                    reason=(
                        "报告明确引用了本次未抓取或未保存的来源；"
                        "不能据此确认该句结论。"
                    ),
                )
            )
            if len(verdicts) >= 24:
                return verdicts
    return verdicts


def _review_source_text(
    report: str,
    sources: tuple[AdapterSource, ...],
    *,
    max_chars: int = 24_000,
) -> str:
    """Render the complete bounded evidence set for the review prompt.

    The previous fixed ``[:12000]`` slice silently excluded most sources on
    deep runs (30 sources commonly means 30 * 1,600-character excerpts).
    That made the reviewer judge a long report against only the first few
    pages. Keep every captured URL in the prompt and use a compact excerpt so
    coverage, rather than source ordering, determines what can be audited.
    """
    lines: list[str] = []
    remaining = max(0, max_chars)
    for index, source in enumerate(sources, start=1):
        title = " ".join((source.title or source.canonical_key or "来源").split())[:120]
        url = source.canonical_key[:240]
        excerpt = " ".join((source.snippet or "").split())[:420]
        line = f"- source_id={index}; title={title}; url={url}\n  摘录：{excerpt or '(本轮没有保存原文摘录，不能据此标记 verified)'}"
        if len(line) <= remaining:
            lines.append(line)
            remaining -= len(line)
            continue

        # Do not drop the tail of the source set just because an earlier
        # title or URL was unusually long. Preserve its identity even when
        # the excerpt has to be shortened.
        compact = f"- source_id={index}; title={title[:80]}; url={url[:180]}"
        if len(compact) <= remaining:
            lines.append(compact)
            remaining -= len(compact)
        else:
            break
    return "\n".join(lines)


def _evidence(claim_id: str, resolved: Any) -> ClaimEvidence:
    return ClaimEvidence(
        claim_id=claim_id,
        source_url=resolved.source_url,
        excerpt=resolved.excerpt,
        observed_at=resolved.observed_at,
        resolver=resolved.resolver,
    )


def _normalized_date(value: str) -> str:
    match = re.search(r"(20\d{2})\D+(\d{1,2})(?:\D+(\d{1,2}))?", value)
    if not match:
        return ""
    year, month, day = match.groups()
    return f"{year}-{int(month):02d}" + (f"-{int(day):02d}" if day else "")


def _extract_github_claims(report: str) -> list[Claim]:
    claims: list[Claim] = []
    for index, match in enumerate(_STAR_RE.finditer(report), start=1):
        start = report.rfind("\n", 0, match.start()) + 1
        end = report.find("\n", match.end())
        if end < 0:
            end = len(report)
        sentence = report[start:end].strip()
        raw_number = match.group("number") or match.group("number_before")
        claims.append(Claim(f"github-stars-{index}", sentence, "high", (start, end), "github_stars", raw_number))
    return claims


def _extract_pattern_claims(report: str) -> list[Claim]:
    """Extract only structured, high-signal claims; prose opinions are excluded."""
    claims = _extract_github_claims(report)
    patterns = (
        ("github_forks", "high", _FORK_RE),
        ("license", "medium", _LICENSE_RE),
        ("version", "high", _VERSION_RE),
        ("date", "high", _DATE_RE),
    )
    next_id = len(claims) + 1
    for fact_type, risk, pattern in patterns:
        for match in pattern.finditer(report):
            start = report.rfind("\n", 0, match.start()) + 1
            end = report.find("\n", match.end())
            if end < 0:
                end = len(report)
            sentence = report[start:end].strip()
            value = match.groupdict().get("number") or match.groupdict().get("license") or match.groupdict().get("version") or match.groupdict().get("date")
            claims.append(Claim(f"fact-{next_id}", sentence, cast(ClaimRisk, risk), (start, end), fact_type, value))
            next_id += 1
    return claims


async def _fetch_github_stars(
    repo: str,
    *,
    client: httpx.AsyncClient | None = None,
) -> tuple[int, str, str] | None:
    owns_client = client is None
    http_client = client or httpx.AsyncClient(timeout=10.0)
    try:
        response = await http_client.get(
            f"https://api.github.com/repos/{repo}",
            headers=_github_headers(),
        )
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError):
        return None
    finally:
        if owns_client:
            await http_client.aclose()
    stars = payload.get("stargazers_count") if isinstance(payload, dict) else None
    if not isinstance(stars, int):
        return None
    observed_at = datetime.now(timezone.utc).isoformat()
    url = f"https://api.github.com/repos/{repo}"
    return stars, url, observed_at


async def _review_github_claims(
    report: str,
    sources: tuple[AdapterSource, ...],
    *,
    client: httpx.AsyncClient | None = None,
) -> tuple[list[ClaimVerdict], list[str], bool]:
    claims = _extract_github_claims(report)
    if not claims:
        return [], [], False
    repos = {
        repo
        for url in _source_urls(sources)
        for repo in (_repo_from_url(url),)
        if repo is not None
    }
    if len(repos) != 1:
        return [
            ClaimVerdict(
                claim_id=claim.id,
                claim=claim.text,
                risk=claim.risk,
                verdict="unverified",
                reason="无法将 Star 声明唯一映射到一个 GitHub 仓库",
            )
            for claim in claims
        ], ["无法唯一确定 GitHub 仓库，Star 数暂不能核验"], True
    repo = next(iter(repos))
    metadata = await _fetch_github_stars(repo, client=client)
    if metadata is None:
        return [
            ClaimVerdict(
                claim_id=claim.id,
                claim=claim.text,
                risk=claim.risk,
                verdict="unverified",
                reason="GitHub API 不可用或未返回 stargazers_count",
            )
            for claim in claims
        ], ["GitHub API 不可用，Star 数需要人工核验"], True
    stars, api_url, observed_at = metadata
    verdicts: list[ClaimVerdict] = []
    instructions: list[str] = []
    for claim in claims:
        match = _STAR_RE.search(claim.text)
        raw_number = match.group("number") or match.group("number_before") if match else None
        parsed = _parse_count(raw_number) if raw_number else None
        evidence = ClaimEvidence(
            claim_id=claim.id,
            source_url=api_url,
            excerpt=json.dumps({"stargazers_count": stars}, ensure_ascii=False),
            observed_at=observed_at,
            resolver="github",
        )
        if parsed is not None and round(parsed) == stars:
            verdicts.append(ClaimVerdict(claim.id, claim.text, claim.risk, "verified", evidence=evidence))
            continue
        correction = f"{stars:,}"
        verdicts.append(
            ClaimVerdict(
                claim.id,
                claim.text,
                claim.risk,
                "correctable",
                evidence=evidence,
                correction=correction,
                reason="报告中的 Star 数与 GitHub API 不一致",
            )
        )
        instructions.append(f"将以下声明的 Star 数修正为 {correction}，并标注抓取时间：{claim.text}")
    return verdicts, instructions, True


async def _review_github_metadata_claims(
    report: str,
    sources: tuple[AdapterSource, ...],
) -> tuple[list[ClaimVerdict], list[str], bool]:
    claims = [claim for claim in _extract_pattern_claims(report) if claim.fact_type in {"github_forks", "license", "date"}]
    if not claims:
        return [], [], False
    repos = {repo for url in _source_urls(sources) if (repo := github_repo_from_url(url))}
    if len(repos) != 1:
        return [
            ClaimVerdict(claim.id, claim.text, claim.risk, "unverified", reason="无法将声明唯一映射到一个 GitHub 仓库")
            for claim in claims
        ], ["无法唯一确定 GitHub 仓库，仓库元数据暂不能核验"], True
    resolved = await resolve_github_repository(next(iter(repos)))
    if resolved is None:
        return [
            ClaimVerdict(claim.id, claim.text, claim.risk, "unverified", reason="GitHub API 不可用或未返回所需字段")
            for claim in claims
        ], ["GitHub API 不可用，仓库元数据需要人工核验"], True
    verdicts: list[ClaimVerdict] = []
    instructions: list[str] = []
    for claim in claims:
        actual: Any
        if claim.fact_type == "github_forks":
            expected = resolved.fields.get("forks_count")
            actual = _parse_count(claim.value or "")
            expected_value: Any = expected
        elif claim.fact_type == "license":
            expected = resolved.fields.get("license")
            actual = (claim.value or "").lower()
            expected_value = str(expected or "").lower()
        else:
            expected = resolved.fields.get("pushed_at" if "提交" in claim.text else "updated_at")
            actual = _normalized_date(claim.value or "")
            expected_value = _normalized_date(str(expected or ""))
        evidence = _evidence(claim.id, resolved)
        if expected is not None and actual == expected_value:
            verdicts.append(ClaimVerdict(claim.id, claim.text, claim.risk, "verified", evidence=evidence))
            continue
        correction = f"{expected:,}" if claim.fact_type == "github_forks" and isinstance(expected, int) else str(expected or "未知")[:10]
        verdicts.append(
            ClaimVerdict(
                claim.id, claim.text, claim.risk, "correctable", evidence=evidence,
                correction=correction, reason="报告中的仓库元数据与 GitHub API 不一致",
            )
        )
        instructions.append(f"将以下声明修正为 {correction}，并标注抓取时间：{claim.text}")
    return verdicts, instructions, True


async def _review_package_and_paper_claims(
    report: str,
    sources: tuple[AdapterSource, ...],
) -> tuple[list[ClaimVerdict], list[str], bool]:
    github_sources = {url for url in _source_urls(sources) if github_repo_from_url(url)}
    claims = [
        claim for claim in _extract_pattern_claims(report)
        if claim.fact_type == "version" or (claim.fact_type == "date" and not github_sources)
    ]
    if not claims:
        return [], [], False
    urls = _source_urls(sources)
    resolvers: list[Any] = []
    for url in urls:
        if (package := npm_package_from_url(url)):
            resolvers.append(("npm", package, resolve_npm_package))
        elif (package := pypi_package_from_url(url)):
            resolvers.append(("pypi", package, resolve_pypi_package))
        elif (paper := arxiv_identifier_from_url(url)):
            resolvers.append(("arxiv", paper, resolve_arxiv_paper))
    if len(resolvers) != 1:
        return [
            ClaimVerdict(claim.id, claim.text, claim.risk, "unverified", reason="无法将版本或日期声明唯一映射到 npm、PyPI 或 arXiv 来源")
            for claim in claims
        ], ["无法唯一确定版本或日期声明的权威来源"], True
    _, identifier, resolver = resolvers[0]
    resolved = await resolver(identifier)
    if resolved is None:
        return [
            ClaimVerdict(claim.id, claim.text, claim.risk, "unverified", reason="权威来源 API 不可用或未返回所需字段")
            for claim in claims
        ], ["权威来源 API 不可用，版本或日期需要人工核验"], True
    verdicts: list[ClaimVerdict] = []
    instructions: list[str] = []
    for claim in claims:
        if claim.fact_type == "version":
            expected = str(resolved.fields.get("version") or "")
            matches = claim.value == expected
        else:
            expected = str(resolved.fields.get("published_at") or resolved.fields.get("uploaded_at") or resolved.fields.get("updated") or "")
            claim_value = claim.value or ""
            matches = bool(expected) and bool(claim_value) and claim_value.replace("年", "-").replace("月", "-").replace("日", "").replace("/", "-").startswith(expected[:7])
        evidence = _evidence(claim.id, resolved)
        if matches:
            verdicts.append(ClaimVerdict(claim.id, claim.text, claim.risk, "verified", evidence=evidence))
        else:
            correction = expected[:10] if claim.fact_type == "date" else expected
            verdicts.append(ClaimVerdict(
                claim.id, claim.text, claim.risk, "correctable", evidence=evidence,
                correction=correction or None, reason="报告声明与权威来源元数据不一致",
            ))
            if correction:
                instructions.append(f"将以下声明修正为 {correction}，并标注抓取时间：{claim.text}")
    return verdicts, instructions, True


_review_logger = logging.getLogger("ai_engine.reviewer")


_CLAIM_INVENTORY_SYSTEM = """你是研究报告的声明抽取器，不负责判断事实是否正确。
请完整扫描报告正文，逐条列出需要区分的声明，不要因为暂时没有证据而删除声明。
每条声明只能表达一个可判断单元；保留原文中的数字、时间、产品名、限定条件和否定关系。
必须把声明分类为：
- external_fact：关于报告主题或外部世界、需要来源支持的事实；
- research_process：本轮研究实际抓取、保存、检索到或未抓取到什么；
- interpretation：观点、推断、建议或行动判断；
- citation_relationship：仅表示报告引用了某个来源。
research_process、interpretation、citation_relationship 不需要事实判断，但不能从清单中省略。
只输出合法 JSON，不要 Markdown 或解释：
{"coverage_status":"complete|insufficient","claims":[{"claim_id":"C1","claim":"...","claim_type":"external_fact|research_process|interpretation|citation_relationship","risk":"high|medium|low|opinion"}]}
"""


_CLAIM_ADJUDICATION_SYSTEM = """你是研究报告的证据裁判，只能判断给定声明与给定来源摘录之间的关系。
不要新增声明，不要重写报告，不要把来源 URL 的存在当作证据。
逐条使用输入中的 claim_id 返回结果。判定含义：
- verified：来源摘录直接支持声明的全部关键范围；
- contradicted：来源摘录或权威解析结果与声明冲突；
- correctable：权威来源给出了可替换的确定值；
- unsupported：来源有相关内容，但不能支持声明；
- unverified：当前证据不足以判断；
- not_applicable：该声明不是 external_fact。
verified、contradicted、correctable 必须绑定给定来源中的逐字 excerpt、source_url 和 observed_at；
没有直接摘录时只能返回 unsupported 或 unverified。只输出合法 JSON：
{"claims":[{"claim_id":"C1","claim":"原声明","verdict":"verified|correctable|contradicted|unsupported|unverified|not_applicable","evidence":{"source_url":null,"excerpt":null,"observed_at":null,"resolver":null},"correction":null,"reason":null}],"revision_instructions":[]}
"""

_FACT_CHALLENGE_SYSTEM = """你是独立的第二位事实核验员。
你只判断给定的一条外部事实声明与给定来源摘录的关系，不参考其他审核员的判断，也不重写报告。
必须从来源摘录本身出发：来源 URL 存在不等于证据成立；摘录不能直接覆盖声明的全部范围时使用 unsupported 或 unverified。
如果声明与来源明确冲突，使用 contradicted；如果来源直接支持声明的全部关键范围，使用 verified。
只输出合法 JSON，不要 Markdown 或解释：
{"claims":[{"claim_id":"C1","claim":"原声明","verdict":"verified|correctable|contradicted|unsupported|unverified","evidence":{"source_url":null,"excerpt":null,"observed_at":null,"resolver":null},"correction":null,"reason":null}],"revision_instructions":[]}
"""


_REVIEW_SYSTEM = """你是独立的事实审核 Agent，不负责重写报告。
只审核报告中的外部可验证事实，不审核观点、建议、推测，也不把“本轮检索/抓取/保存了什么、没有抓到什么”当成外部事实。
必须严格区分 verified、unsupported、unverified 和 contradicted。
引用 URL 存在不代表引用内容支持声明；无法确认时必须使用 unverified。
每条 high/medium 声明都必须给出报告中对应的原文短句，以及来源证据中的直接摘录；
如果提供的来源摘录不足以核对，仍保留声明并使用 unverified，不能返回空 claims。
每条声明都必须带 claim_type：external_fact（外部事实）、research_process（本轮研究过程观察）、interpretation（观点/推断/建议）或 citation_relationship（仅表示报告引用了来源）。后 3 类必须使用 not_applicable，不需要外部摘录，也不进入事实发布门禁。
只输出合法 JSON，不要 Markdown，不要补充 JSON 之外的文字。
JSON 格式：{"status":"passed|needs_revision|blocked","claims":[{"claim_id":"...","claim":"...","claim_type":"external_fact|research_process|interpretation|citation_relationship","risk":"high|medium|low|opinion","verdict":"verified|correctable|contradicted|unsupported|unverified|not_applicable","evidence":{"source_url":null,"excerpt":null,"observed_at":null,"resolver":null},"correction":null,"reason":null}],"revision_instructions":[]}
"""

_REVIEW_RETRY_SYSTEM = """你是事实审核器。上一次输出无法解析。
现在只返回一个紧凑、合法的 JSON 对象，不要输出 <think>、Markdown、解释或代码围栏。
最多返回 12 条最重要的 high/medium 声明；没有直接证据时 verdict 必须是 unverified，不能省略该声明。
JSON 格式：{"status":"passed|needs_revision|blocked","claims":[],"revision_instructions":[]}
"""


def _claim_gap_instructions(
    claims: list[ClaimVerdict] | tuple[ClaimVerdict, ...],
    *,
    limit: int = _EVIDENCE_GAP_INSTRUCTION_LIMIT,
) -> tuple[str, ...]:
    """Turn a bounded set of factual gaps into actionable repair instructions.

    The reviewer is deliberately not allowed to turn a source URL into proof.
    When an LLM returns ``unverified`` without its own rewrite guidance, the
    old pipeline stopped with a report that still read like a set of facts.
    These instructions close that hole while keeping the repair pass bounded:
    high-risk claims are handled first, and the rest remain visible in the
    evidence ledger rather than creating an unbounded second research tree.
    """
    candidates = [
        claim
        for claim in claims
        if claim.claim_type == "external_fact"
        and claim.risk != "opinion"
        and claim.verdict != "not_applicable"
        and not _is_citation_relationship(claim)
        and claim.verdict in _EVIDENCE_GAP_VERDICTS
        and claim.claim.strip()
    ]
    candidates.sort(key=lambda claim: (_RISK_ORDER.get(claim.risk, 9), claim.claim))
    instructions: list[str] = []
    seen: set[str] = set()
    for claim in candidates:
        text = " ".join(claim.claim.split()).strip()
        if not text or text in seen:
            continue
        seen.add(text)
        if claim.verdict == "contradicted":
            action = "删除该声明，或明确改写为存在冲突的判断；不能继续把它写成确定事实"
        elif claim.evidence and claim.evidence.excerpt:
            action = "只保留原文摘录能够直接支持的范围；如果不能直接支持，删除或标记为‘待核验’"
        else:
            action = "删除，或在原位置明确标记为‘待核验’，不能用常识或模型记忆补全"
        reason = claim.reason or "本轮事实审核没有找到足够的直接证据"
        instructions.append(
            f"声明级证据缺口：{text[:360]}。{action}。原因：{reason[:240]}。"
        )
        if len(instructions) >= max(0, limit):
            break
    return tuple(instructions)


def _is_citation_relationship(claim: ClaimVerdict) -> bool:
    """Return whether a row only records a report-to-source link.

    Citation links are useful evidence navigation, but they are not a
    semantic verdict.  Keeping this distinction here prevents the review
    state machine from treating a timeout with 17 citations as 17 factual
    failures.
    """
    return bool(
        claim.claim_type == "citation_relationship"
        or (
            claim.evidence
            and claim.evidence.resolver == "captured-source-citation"
        )
    )


_RESEARCH_PROCESS_CLAIM_RE = re.compile(
    r"(?:本轮|本次|当前)(?:研究|检索|搜索|抓取|资料|来源|证据|审核)"
    r"|(?:没有|未|仅|只)(?:抓取|检索|保存|获取).{0,48}(?:正文|来源|资料|证据|页面)"
    r"|(?:本轮|本次|当前).{0,16}(?:仅|只|没有|未)(?:抓取|检索|保存|获取)"
    r"|抓取到的.{0,120}(?:页面|正文).{0,80}(?:未|没有|并未).{0,48}(?:正文|安装|说明|内容)"
    r"|(?:来源|证据)(?:包|清单|账本).{0,24}(?:本轮|当前)",
    re.IGNORECASE,
)


def _looks_like_research_process_claim(value: str) -> bool:
    """Recognize claims whose truth is established by this run's ledger.

    This is intentionally narrow.  It is a safety net for older or weaker
    model outputs that omit ``claim_type``; it must not turn an ordinary
    product or technology fact into a process observation.
    """
    return bool(_RESEARCH_PROCESS_CLAIM_RE.search(" ".join(value.split())))


def _claim_type_for_payload(
    raw: dict[str, Any],
    claim_text: str,
    risk: ClaimRisk,
    verdict: ClaimVerdictStatus,
    evidence: ClaimEvidence | None,
) -> ClaimType:
    if evidence and evidence.resolver == "captured-source-citation":
        return "citation_relationship"
    if _looks_like_research_process_claim(claim_text):
        return "research_process"
    raw_type = raw.get("claim_type")
    if raw_type in {"external_fact", "research_process", "interpretation", "citation_relationship"}:
        return cast(ClaimType, raw_type)
    if risk == "opinion" or verdict == "not_applicable":
        return "interpretation"
    return "external_fact"


def _report_requires_claim_review(report: str) -> bool:
    """Conservatively detect substantial output that needs claim coverage.

    We cannot prove from Markdown alone that a short sentence is factual.  A
    substantial report, however, must not receive a clean verdict merely
    because the reviewer returned an empty/only-opinion payload.  This is a
    coverage guard, not a claim extractor, and intentionally errs toward
    ``needs_revision`` for long material.
    """
    body = _report_body_without_references(report)
    plain = re.sub(r"https?://\S+|[`*_>#\[\]()\-]", " ", body)
    plain = re.sub(r"\s+", " ", plain).strip()
    if len(plain) >= 800:
        return True
    if len(plain) >= 320 and (
        re.search(r"\d", plain)
        or re.search(r"(?im)^\s*[-*+]\s+", body)
        or re.search(r"(?im)^\s*#{1,3}\s+", body)
    ):
        return True
    return False


def _deterministic_claim_floor(report: str) -> int:
    """Estimate a conservative *minimum* factual inventory size.

    The inventory model may say ``complete`` even when it silently returns
    only the easiest claims. This floor is intentionally lower than a full
    extractor: it only counts sentence-shaped units with durable fact
    markers (numbers, dates, versions, URLs or well-known package/repository
    identifiers). It is a safety lower bound, never a replacement for the
    model inventory.
    """
    body = _report_body_without_references(report)
    candidates: set[str] = set()
    for raw in re.split(r"(?<=[。！？.!?])\s+|\n+", body):
        sentence = re.sub(r"\s+", " ", raw).strip(" -*•\t")
        if len(sentence) < 24:
            continue
        has_fact_marker = bool(
            re.search(r"\d", sentence)
            or re.search(r"\b(?:v?\d+(?:\.\d+){1,3}|\d+%|20\d{2})\b", sentence, re.IGNORECASE)
            or re.search(r"(?:github\.com|npmjs\.com|pypi\.org|arxiv\.org|doi\.org)", sentence, re.IGNORECASE)
            or re.search(r"\b(?:Claude|Gemini|ChatGPT|OpenAI|Google|Anthropic|GitHub|npm|PyPI|arXiv)\b", sentence)
        )
        if has_fact_marker:
            candidates.add(sentence.casefold())
    if candidates:
        return min(len(candidates), 24)
    # Long, structured prose still needs at least one inventory row even if
    # it happens not to contain a numeric or named-entity marker.
    return 1 if _report_requires_claim_review(report) else 0


def _review_outcome(result: ReviewResult) -> Literal["clear", "attention", "blocked", "unavailable"]:
    """Map operational review state and claim findings to a product outcome."""
    if result.status == "review_unavailable":
        return "unavailable"
    if result.status == "blocked":
        return "blocked"
    if result.status == "needs_revision" or result.coverage_status == "insufficient" or result.evidence_gap_count > 0:
        return "attention"
    return "clear"


def _claim_merge_key(value: str) -> str:
    """Normalize claim text for conservative cross-check deduplication.

    The inventory model and deterministic resolvers use different IDs.  IDs
    are therefore not an identity boundary by themselves.  This key is only
    used to detect an exact/near-exact duplicate; it must never be used to
    infer that two semantically different claims are the same.
    """
    return re.sub(r"[^\w]+", "", " ".join(value.casefold().split()), flags=re.UNICODE)


def _claims_can_merge(left: ClaimVerdict, right: ClaimVerdict) -> bool:
    """Return whether two verdict rows are clearly the same statement.

    Deterministic resolvers are authoritative for the structured fact they
    recognize, while the inventory/adjudication path is authoritative for
    coverage and claim identity.  Merge only when the text is exact or nearly
    identical, and only when there is a single unambiguous candidate.
    """
    if left.claim_type != right.claim_type:
        return False
    left_key = _claim_merge_key(left.claim)
    right_key = _claim_merge_key(right.claim)
    if not left_key or not right_key:
        return False
    if left_key == right_key:
        return True
    shorter, longer = sorted((left_key, right_key), key=len)
    if len(shorter) < 18 or shorter not in longer:
        return False
    return SequenceMatcher(None, left_key, right_key).ratio() >= 0.88


def _merge_claim_verdicts(
    authoritative: list[ClaimVerdict],
    inventory_results: tuple[ClaimVerdict, ...],
) -> list[ClaimVerdict]:
    """Merge resolver findings with inventory-bound verdicts without dupes.

    A deterministic resolver wins the verdict for the structured field it
    actually resolved.  The inventory row supplies the stable claim id so
    user decisions remain bound to the current review snapshot.  Ambiguous
    matches are intentionally left as separate rows rather than guessed.
    """
    merged = list(authoritative)
    for candidate in inventory_results:
        matches = [
            index
            for index, existing in enumerate(merged)
            if _claims_can_merge(existing, candidate)
        ]
        if len(matches) != 1:
            merged.append(candidate)
            continue
        index = matches[0]
        existing = merged[index]
        evidence = existing.evidence
        if evidence is not None and evidence.claim_id != candidate.claim_id:
            evidence = replace(evidence, claim_id=candidate.claim_id)
        merged[index] = replace(
            existing,
            claim_id=candidate.claim_id,
            evidence=evidence,
            location=candidate.location or existing.location,
        )
    return merged


def _fact_review_batch_size() -> int:
    """Return a bounded number of claims per evidence-judgement call.

    The inventory is the immutable work list.  Batching only changes the
    failure boundary of the slower evidence call; it must not make the
    caller tune an unbounded model context by hand.
    """
    try:
        value = int(os.environ.get("FACT_REVIEW_BATCH_SIZE", "6"))
    except (TypeError, ValueError):
        value = 6
    return min(max(value, 2), 12)


def _fact_review_batch_timeout_seconds() -> int:
    """Keep one batch bounded so later batches can still make progress."""
    try:
        value = int(os.environ.get("FACT_REVIEW_BATCH_TIMEOUT_SECONDS", "45"))
    except (TypeError, ValueError):
        value = 45
    return min(max(value, 15), 120)


def _ordered_fact_batches(
    inventory: tuple[ClaimInventoryItem, ...],
) -> tuple[tuple[ClaimInventoryItem, ...], ...]:
    """Prioritize high-risk claims while preserving stable inventory order."""
    factual = [
        (index, item)
        for index, item in enumerate(inventory)
        if item.claim_type == "external_fact" and item.risk != "opinion"
    ]
    factual.sort(key=lambda value: (_RISK_ORDER.get(value[1].risk, 9), value[0]))
    ordered = [item for _, item in factual]
    size = _fact_review_batch_size()
    return tuple(
        tuple(ordered[offset:offset + size])
        for offset in range(0, len(ordered), size)
    )


def _unverified_batch_claims(
    batch: tuple[ClaimInventoryItem, ...],
    *,
    reason: str,
) -> tuple[ClaimVerdict, ...]:
    """Materialize a failed batch without inventing a factual verdict."""
    return tuple(
        ClaimVerdict(
            claim_id=item.claim_id,
            claim=item.claim,
            risk=item.risk,
            verdict="unverified",
            reason=reason,
            judgment_status="execution_failed",
            execution_error_code="batch_unavailable",
            claim_type="external_fact",
        )
        for item in batch
    )


async def _adjudicate_fact_batches(
    *,
    inventory: tuple[ClaimInventoryItem, ...],
    source_text: str,
    topic: str,
    report_type: str,
    llm_spec: str | None,
    inventory_coverage: Literal["complete", "insufficient", "not_applicable"],
    emit_phase: ReviewProgressCallback,
) -> ReviewResult:
    """Judge factual claims in independently retryable batches.

    The key invariant is that a provider/parser failure affects only its
    batch. Successful batches remain valid evidence decisions, while the
    failed batch is represented as ``unverified`` and the overall coverage is
    marked insufficient. A missing verdict is never rewritten as
    ``contradicted``.
    """
    batches = _ordered_fact_batches(inventory)
    total_factual_claims = sum(len(batch) for batch in batches)
    non_fact_claims = [
        _non_fact_inventory_verdict(item)
        for item in inventory
        if item.claim_type != "external_fact" or item.risk == "opinion"
    ]
    if not batches:
        return ReviewResult(
            status="passed",
            claims=tuple(non_fact_claims),
            coverage_status=inventory_coverage,
            total_claim_count=0,
        )

    inventory_snapshot = [asdict(item) for item in inventory]
    judged_claims: list[ClaimVerdict] = []
    instructions: list[str] = []
    completed_batches = 0
    failed_batches = 0
    judged_count = 0
    last_error: BaseException | None = None

    for batch_index, batch in enumerate(batches, start=1):
        claim_ids = [item.claim_id for item in batch]
        await emit_phase("adjudicating", {
            "inventory": inventory_snapshot,
            "coverage_status": inventory_coverage,
            "batch_index": batch_index,
            "batch_count": len(batches),
            "active_batch_claim_ids": claim_ids,
            "completed_batch_count": completed_batches,
            "failed_batch_count": failed_batches,
            "judged_claim_count": judged_count,
            "total_claim_count": total_factual_claims,
            "batch_status": "running",
            "settled_claims": [asdict(claim) for claim in judged_claims],
        })

        batch_result: ReviewResult | None = None
        batch_error: BaseException | None = None
        for attempt in range(1, 3):
            try:
                adjudication_prompt = (
                    f"主题：{topic}\n报告类型：{report_type}\n"
                    f"当前批次（第 {batch_index}/{len(batches)} 批）：\n"
                    f"{json.dumps([asdict(item) for item in batch], ensure_ascii=False)}\n"
                    f"来源证据：\n{source_text}\n"
                    "只判断当前批次中的声明与来源摘录的关系。"
                    f"这是第 {attempt} 次尝试；不得返回当前批次以外的 claim_id。"
                )
                generated = await generate_text(
                    user_prompt=adjudication_prompt,
                    system_prompt=_CLAIM_ADJUDICATION_SYSTEM,
                    llm_spec=llm_spec,
                    tier="light",
                    max_tokens=5000,
                    timeout=_fact_review_batch_timeout_seconds(),
                    disable_thinking=True,
                    operation="research.fact_review.adjudication",
                )
                batch_result = _parse_adjudication_payload(
                    _extract_json_object(generated.text),
                    batch,
                )
                batch_error = None
                break
            except Exception as exc:  # provider, timeout, or malformed JSON
                batch_error = exc
                last_error = exc

        if batch_result is None:
            failed_batches += 1
            reason = (
                f"第 {batch_index} 批声明的证据判断未完成；这不是事实冲突，"
                "请重试审核后再决定是否发布。"
            )
            judged_claims.extend(_unverified_batch_claims(batch, reason=reason))
            await emit_phase("adjudicating", {
                "inventory": inventory_snapshot,
                "coverage_status": "insufficient",
                "batch_index": batch_index,
                "batch_count": len(batches),
                "active_batch_claim_ids": claim_ids,
                "completed_batch_count": completed_batches,
                "failed_batch_count": failed_batches,
                "judged_claim_count": judged_count,
                "total_claim_count": total_factual_claims,
                "batch_status": "failed",
                "batch_error_code": _review_error_code(batch_error or RuntimeError("batch failed")),
                "settled_claims": [asdict(claim) for claim in judged_claims],
            })
            continue

        batch_claims = list(batch_result.claims)
        missing_count = sum(
            1 for claim in batch_claims
            if "没有返回这条声明的结果" in (claim.reason or "")
        )
        if batch_result.coverage_status == "insufficient" or missing_count:
            failed_batches += 1
        else:
            completed_batches += 1
        judged_count += max(0, len(batch) - missing_count)
        judged_claims.extend(batch_claims)
        instructions.extend(batch_result.revision_instructions)
        await emit_phase("adjudicating", {
            "inventory": inventory_snapshot,
            "coverage_status": "insufficient" if failed_batches else inventory_coverage,
            "batch_index": batch_index,
            "batch_count": len(batches),
            "active_batch_claim_ids": claim_ids,
            "completed_batch_count": completed_batches,
            "failed_batch_count": failed_batches,
            "judged_claim_count": judged_count,
            "total_claim_count": total_factual_claims,
            "batch_status": "partial" if missing_count else "completed",
            "settled_claims": [asdict(claim) for claim in judged_claims],
        })

    claims = tuple((*non_fact_claims, *judged_claims))
    coverage_status: Literal["complete", "insufficient", "not_applicable"] = (
        "insufficient"
        if inventory_coverage == "insufficient" or failed_batches > 0
        else "complete"
    )
    status: ReviewStatus = _status_for_claims(list(claims))
    if failed_batches and completed_batches == 0:
        status = "review_unavailable"
    elif failed_batches:
        status = "needs_revision"
    return ReviewResult(
        status=status,
        claims=claims,
        revision_instructions=tuple(dict.fromkeys(instructions)),
        error=(
            f"事实审核有 {failed_batches}/{len(batches)} 个批次未完成"
            if failed_batches else None
        ),
        error_code=_review_error_code(last_error) if last_error else None,
        coverage_status=coverage_status,
        batch_count=len(batches),
        completed_batch_count=completed_batches,
        failed_batch_count=failed_batches,
        judged_claim_count=judged_count,
        total_claim_count=total_factual_claims,
    )


class DefaultResearchReviewer:
    """Hybrid reviewer: deterministic GitHub checks plus LLM citation audit."""

    def __init__(self, *, llm_spec: str | None = None) -> None:
        self._llm_spec = llm_spec

    async def challenge_support(
        self,
        report: str,
        sources: tuple[AdapterSource, ...],
        topic: str,
        *,
        report_type: str = "research_report",
        claim_id: str,
        claim: str,
        risk: ClaimRisk,
        phase_callback: ReviewProgressCallback | None = None,
    ) -> ReviewResult:
        """Run a claim-scoped, independent second opinion.

        ``challenge_support`` is intentionally separate from ``review``. It
        receives only the challenged statement and the current source ledger,
        and uses a dedicated prompt/model slot. The caller compares this
        result with the original run; disagreement becomes ``disputed``
        instead of being silently overwritten by the latest answer.
        """
        async def emit_phase(phase: str, payload: dict[str, object]) -> None:
            if phase_callback is not None:
                await phase_callback(phase, payload)

        captured_sources = _captured_sources(sources)
        item = ClaimInventoryItem(
            claim_id=claim_id,
            claim=claim,
            risk=risk,
            claim_type="external_fact",
        )
        if not captured_sources:
            return ReviewResult(
                "review_unavailable",
                claims=(ClaimVerdict(
                    claim_id=claim_id,
                    claim=claim,
                    risk=risk,
                    verdict="unverified",
                    reason="没有可供独立复核的已保存正文。",
                    judgment_status="execution_failed",
                    execution_error_code="no_captured_evidence",
                    claim_type="external_fact",
                ),),
                error="本轮没有可供独立复核的已抓取证据",
                error_code="no_captured_evidence",
                coverage_status="insufficient",
                total_claim_count=1,
            )

        await emit_phase("inventorying", {
            "mode": "evidence_challenge",
            "target_claim_id": claim_id,
            "source_count": len(captured_sources),
        })
        source_text = _review_source_text(report, captured_sources)
        prompt = (
            f"主题：{topic}\n报告类型：{report_type}\n"
            "这是一次独立的第二意见，只检查下面这一条声明。\n"
            f"声明：{json.dumps(asdict(item), ensure_ascii=False)}\n"
            f"来源证据：\n{source_text}\n"
            "不要参考任何先前判断；只返回这一个 claim_id。"
        )
        try:
            generated = await generate_text(
                user_prompt=prompt,
                system_prompt=_FACT_CHALLENGE_SYSTEM,
                llm_spec=self._llm_spec,
                tier="light",
                max_tokens=1800,
                timeout=_fact_review_batch_timeout_seconds(),
                disable_thinking=True,
                operation="research.fact_review.challenge",
            )
            result = _parse_adjudication_payload(
                _extract_json_object(generated.text),
                (item,),
            )
            result = _validate_llm_evidence(result, captured_sources)
            result = _reconcile_unbound_evidence(result, captured_sources)
            await emit_phase("adjudicating", {
                "mode": "evidence_challenge",
                "target_claim_id": claim_id,
                "judged_claim_count": 1,
                "total_claim_count": 1,
            })
            return _attach_claim_locations(report, result)
        except Exception as exc:
            await emit_phase("adjudicating", {
                "mode": "evidence_challenge",
                "target_claim_id": claim_id,
                "judged_claim_count": 0,
                "total_claim_count": 1,
                "batch_status": "failed",
                "error_code": _review_error_code(exc),
            })
            return ReviewResult(
                "review_unavailable",
                claims=(ClaimVerdict(
                    claim_id=claim_id,
                    claim=claim,
                    risk=risk,
                    verdict="unverified",
                    reason="独立复核没有完成；这不是事实冲突。",
                    judgment_status="execution_failed",
                    execution_error_code=_review_error_code(exc),
                    claim_type="external_fact",
                ),),
                error=f"{type(exc).__name__}: challenge unavailable",
                error_code=_review_error_code(exc),
                coverage_status="insufficient",
                total_claim_count=1,
            )

    async def review(
        self,
        report: str,
        sources: tuple[AdapterSource, ...],
        topic: str,
        *,
        report_type: str = "research_report",
        phase_callback: ReviewProgressCallback | None = None,
    ) -> ReviewResult:
        async def emit_phase(phase: str, payload: dict[str, object]) -> None:
            if phase_callback is not None:
                await phase_callback(phase, payload)

        def finalize(result: ReviewResult) -> ReviewResult:
            return _attach_claim_locations(report, result)

        captured_sources = _captured_sources(sources)
        await emit_phase("inventorying", {
            "report_chars": len(report),
            "source_count": len(sources),
            "captured_source_count": len(captured_sources),
        })
        if not captured_sources:
            return finalize(ReviewResult(
                "review_unavailable",
                error="本轮没有可供审核的已抓取证据",
                error_code="no_captured_evidence",
                coverage_status="insufficient",
            ))
        deterministic, instructions, has_dynamic_claim = await _review_github_claims(
            report, captured_sources
        )
        for resolver_review in (_review_github_metadata_claims, _review_package_and_paper_claims):
            extra_claims, extra_instructions, extra_dynamic = await resolver_review(report, captured_sources)
            deterministic.extend(extra_claims)
            instructions.extend(extra_instructions)
            has_dynamic_claim = has_dynamic_claim or extra_dynamic
        source_text = _review_source_text(report, captured_sources)
        citation_ledger = _citation_ledger(report, captured_sources)
        inventory_prompt = (
            f"主题：{topic}\n报告类型：{report_type}\n"
            f"报告正文：\n{_report_body_without_references(report)[:24000]}\n"
            "请先完成声明清单，不要判断声明是否正确。"
        )
        try:
            # Phase 1: inventory only.  This prevents the evidence judge from
            # silently dropping a claim merely because it cannot find a quote.
            generated = await generate_text(
                user_prompt=inventory_prompt,
                system_prompt=_CLAIM_INVENTORY_SYSTEM,
                llm_spec=self._llm_spec,
                tier="light",
                max_tokens=5000,
                timeout=60.0,
                disable_thinking=True,
                operation="research.fact_review.inventory",
            )
            inventory_payload = _extract_json_object(generated.text)
            inventory = _parse_claim_inventory_payload(inventory_payload)

            factual_inventory = tuple(
                item for item in inventory
                if item.claim_type == "external_fact" and item.risk != "opinion"
            )
            inventory_coverage = inventory_payload.get("coverage_status")
            if inventory_coverage not in {"complete", "insufficient"}:
                # The inventory contract must explicitly say whether the
                # scan was complete. Missing metadata is an execution-quality
                # failure, not evidence that the report has no more claims.
                inventory_coverage = (
                    "insufficient"
                    if factual_inventory or _report_requires_claim_review(report)
                    else "not_applicable"
                )
            deterministic_floor = _deterministic_claim_floor(report)
            if len(factual_inventory) < deterministic_floor:
                # Never let the model certify its own incomplete scan. The
                # lower bound is deliberately conservative, but a report
                # with several concrete fact markers cannot be "complete"
                # when the inventory contains fewer rows than that bound.
                inventory_coverage = "insufficient"
            await emit_phase("adjudicating", {
                "inventory_count": len(inventory),
                "factual_claim_count": len(factual_inventory),
                "deterministic_claim_floor": deterministic_floor,
                # Persist the claim inventory before the potentially slower
                # evidence-judgement call. If that call times out, the
                # worker can still tell the reader which statements were
                # identified but never judged. Losing this boundary made a
                # reviewer outage look like a report with no facts.
                "inventory": [asdict(item) for item in inventory],
                "coverage_status": inventory_coverage,
            })

            if not inventory:
                # Keep a bounded compatibility path for older providers that
                # only understand the original one-shot review contract. An
                # empty inventory is never treated as a clean fact review.
                legacy_prompt = (
                    f"主题：{topic}\n报告类型：{report_type}\n报告：\n{report[:24000]}\n"
                    f"来源证据：\n{source_text}\n"
                    "请提取并审核高风险和中风险事实。普通观点标记 not_applicable。"
                )
                legacy_generated = await generate_text(
                    user_prompt=legacy_prompt,
                    system_prompt=_REVIEW_SYSTEM,
                    llm_spec=self._llm_spec,
                    tier="light",
                    max_tokens=6000,
                    timeout=60.0,
                    disable_thinking=True,
                    operation="research.fact_review.legacy",
                )
                llm_result = _parse_review_payload(_extract_json_object(legacy_generated.text))
                if _report_requires_claim_review(report):
                    llm_result = replace(llm_result, coverage_status="insufficient")
            else:
                # Phase 2: adjudicate only the external-fact subset against
                # the captured ledger. Each bounded batch has its own retry
                # boundary; process observations and interpretations remain
                # visible in the audit record but never enter a model call.
                llm_result = await _adjudicate_fact_batches(
                    inventory=inventory,
                    source_text=source_text,
                    topic=topic,
                    report_type=report_type,
                    llm_spec=self._llm_spec,
                    inventory_coverage=cast(
                        Literal["complete", "insufficient", "not_applicable"],
                        inventory_coverage,
                    ),
                    emit_phase=emit_phase,
                )

            await emit_phase("matching", {
                "claim_count": len(llm_result.claims),
            })
            llm_result = _validate_llm_evidence(llm_result, captured_sources)
            llm_result = _reconcile_unbound_evidence(llm_result, captured_sources)
        except Exception as exc:
            # Reasoning-capable OpenAI-compatible endpoints occasionally
            # consume the whole first output budget in a hidden <think>
            # block.  Retry once with a smaller, stricter prompt before
            # degrading to an explicit unavailable review.  This is a
            # recovery attempt, never a pass-through to "verified".
            first_error = exc
            first_raw = generated.text[:500] if "generated" in locals() and generated.text else "<no output>"
            retry_prompt = (
                f"主题：{topic}\n报告类型：{report_type}\n"
                "只审核报告中最重要的可验证事实；观点和建议使用 not_applicable。\n"
                f"报告：\n{report[:14000]}\n\n来源证据：\n{source_text[:14000]}"
            )
            try:
                retry_generated = await generate_text(
                    user_prompt=retry_prompt,
                    system_prompt=_REVIEW_RETRY_SYSTEM,
                    llm_spec=self._llm_spec,
                    tier="light",
                    max_tokens=4000,
                    timeout=45.0,
                    disable_thinking=True,
                    operation="research.fact_review.retry",
                )
                payload = _extract_json_object(retry_generated.text)
                llm_result = _parse_review_payload(payload)
                llm_result = _validate_llm_evidence(llm_result, captured_sources)
                llm_result = _reconcile_unbound_evidence(llm_result, captured_sources)
            except Exception as retry_exc:
                # 记录两次原始输出前缀，便于诊断，但不把模型杂讯写入用户报告。
                retry_raw = (
                    retry_generated.text[:500]
                    if "retry_generated" in locals() and retry_generated.text
                    else "<no output>"
                )
                _review_logger.warning(
                    "review LLM output not parseable after retry: first=%s/%r retry=%s/%r",
                    type(first_error).__name__,
                    first_raw,
                    type(retry_exc).__name__,
                    retry_raw,
                )
                exc = retry_exc
                fallback_claims = [*deterministic, *citation_ledger]
                # A malformed reviewer response is a reviewer failure, not
                # proof that the report passed. Keep deterministic findings
                # and explicit citation relationships visible, but label
                # them unverified.
                if fallback_claims:
                    return finalize(ReviewResult(
                        "review_unavailable" if not deterministic else "needs_revision",
                        tuple(fallback_claims),
                        tuple(dict.fromkeys((*instructions, *_claim_gap_instructions(fallback_claims)))),
                        error=type(exc).__name__,
                        error_code=_review_error_code(exc),
                        coverage_status=(
                            "insufficient"
                            if _report_requires_claim_review(report)
                            else "not_applicable"
                        ),
                    ))
                if not has_dynamic_claim:
                    return finalize(ReviewResult(
                        "review_unavailable",
                        error=f"{type(exc).__name__}: reviewer unavailable",
                        error_code=_review_error_code(exc),
                        coverage_status=(
                            "insufficient"
                            if _report_requires_claim_review(report)
                            else "not_applicable"
                        ),
                    ))
                return finalize(ReviewResult(
                    "review_unavailable",
                    error=f"{type(exc).__name__}: reviewer unavailable",
                    error_code=_review_error_code(exc),
                    coverage_status=(
                        "insufficient"
                        if _report_requires_claim_review(report)
                        else "not_applicable"
                    ),
                ))

        # Keep one ledger row per statement.  Resolver IDs (fact-1, github-1)
        # are implementation IDs and do not necessarily match the inventory
        # IDs (C1, C2).  Merge by conservative claim identity and retain the
        # inventory ID for the user-facing decision/audit boundary.
        merged = _merge_claim_verdicts(deterministic, llm_result.claims)
        merged = list(_reconcile_unbound_evidence(
            ReviewResult(
                status=_status_for_claims(merged),
                claims=tuple(merged),
                revision_instructions=llm_result.revision_instructions,
                coverage_status=llm_result.coverage_status,
                batch_count=llm_result.batch_count,
                completed_batch_count=llm_result.completed_batch_count,
                failed_batch_count=llm_result.failed_batch_count,
                judged_claim_count=llm_result.judged_claim_count,
                total_claim_count=llm_result.total_claim_count,
            ),
            captured_sources,
        ).claims)
        # A successful HTTP response with zero factual claims is still
        # incomplete when the report contains explicit author-year citations.
        # Surface those relationships as unverified instead of showing a clean
        # pass with an empty evidence ledger.
        has_factual_llm_claim = any(
            item.claim_type == "external_fact"
            and
            item.risk != "opinion"
            and item.verdict != "not_applicable"
            and not _is_citation_relationship(item)
            for item in llm_result.claims
        )
        if not has_factual_llm_claim:
            merged.extend(
                item for item in citation_ledger
                if not any(_claims_can_merge(existing, item) for existing in merged)
            )
        merged_instructions = tuple(
            dict.fromkeys(
                (
                    *instructions,
                    *llm_result.revision_instructions,
                    *_claim_gap_instructions(merged),
                )
            )
        )
        status = _status_for_claims(merged)
        if (
            llm_result.batch_count > 0
            and llm_result.failed_batch_count == llm_result.batch_count
        ):
            # A deterministic resolver may have returned a few independent
            # rows, but the semantic adjudication service did not complete
            # any batch. Do not downgrade that execution failure to a clean
            # or ordinary factual verdict.
            status = "review_unavailable"
        elif llm_result.failed_batch_count > 0:
            status = "needs_revision"
        coverage_status: Literal["complete", "insufficient", "not_applicable"] = llm_result.coverage_status
        if not has_factual_llm_claim and not deterministic:
            if citation_ledger:
                # We have navigable citations, but no semantic fact verdict.
                # This is a review availability problem, not a claim failure.
                status = "review_unavailable"
            elif _report_requires_claim_review(report):
                # Do not call a substantial report "passed" merely because
                # the reviewer returned no factual inventory.
                status = "needs_revision"
                coverage_status = "insufficient"
            else:
                coverage_status = "not_applicable"
        if not llm_result.claims and citation_ledger:
            status = "review_unavailable"
        if status == "review_unavailable" and coverage_status == "complete":
            coverage_status = "insufficient" if _report_requires_claim_review(report) else "not_applicable"
        await emit_phase("conflict_check", {
            "claim_count": len(merged),
            "factual_claim_count": sum(
                item.claim_type == "external_fact"
                and item.risk != "opinion"
                and item.verdict != "not_applicable"
                and not _is_citation_relationship(item)
                for item in merged
            ),
            "contradicted_count": sum(
                item.verdict in {"contradicted", "correctable"}
                and item.claim_type == "external_fact"
                for item in merged
            ),
        })
        return finalize(ReviewResult(
            status,
            tuple(merged),
            merged_instructions,
            coverage_status=coverage_status,
            error=llm_result.error,
            error_code=llm_result.error_code,
            batch_count=llm_result.batch_count,
            completed_batch_count=llm_result.completed_batch_count,
            failed_batch_count=llm_result.failed_batch_count,
            judged_claim_count=llm_result.judged_claim_count,
            total_claim_count=llm_result.total_claim_count,
        ))


def _extract_json_object(text: str) -> dict[str, Any]:
    """从 LLM 输出里提取 JSON 对象。

    DeepSeek 等模型偶发返回带 markdown code fence、前后杂讯或截断的 JSON。
    先直接解析,失败则按优先级:
      1. 剥离 ```json ... ``` fence
      2. 正则找首个 { ... } 平衡括号段
    """
    stripped = text.strip()
    if not stripped:
        raise ValueError("reviewer output is empty")

    # A few OpenAI-compatible endpoints return a reasoning block even when
    # the request disables thinking. Remove complete blocks before looking for
    # JSON. If the endpoint truncates before ``</think>``, start at the first
    # likely answer marker; otherwise the reasoning prose can contain example
    # braces and mask the real payload.
    stripped = re.sub(r"<think\b[^>]*>.*?</think\s*>", "", stripped, flags=re.IGNORECASE | re.DOTALL).strip()
    if "<think" in stripped.lower():
        answer_markers = [
            marker_index
            for marker in ("{\"status\"", "```json")
            if (marker_index := stripped.find(marker)) >= 0
        ]
        if answer_markers:
            stripped = stripped[min(answer_markers) :].strip()

    def _balanced(text: str, start: int) -> str:
        depth = 0
        in_str = False
        escape = False
        for i in range(start, len(text)):
            ch = text[i]
            if escape:
                escape = False
                continue
            if ch == "\\" and in_str:
                escape = True
                continue
            if ch == '"':
                in_str = not in_str
            elif not in_str:
                if ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        return text[start : i + 1]
        raise ValueError("unbalanced JSON object")

    # 1) 直接解析
    try:
        obj = json.loads(stripped)
        if not isinstance(obj, dict):
            raise ValueError("reviewer output is not an object")
        return obj
    except ValueError:
        pass

    # 2) 剥离 markdown fence
    fence_re = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)
    m = fence_re.search(stripped)
    if m:
        obj = json.loads(m.group(1).strip())
        if isinstance(obj, dict):
            return obj

    # 3) 平衡括号截取 JSON 对象。尝试所有候选，避免思维文本里的示例
    # 对象抢在真正的审核结果之前。
    for idx, ch in enumerate(stripped):
        if ch == "{":
            try:
                segment = _balanced(stripped, idx)
                obj = json.loads(segment)
            except (ValueError, json.JSONDecodeError):
                continue
            if isinstance(obj, dict) and any(key in obj for key in ("status", "claims", "revision_instructions")):
                return obj

    raise ValueError("no JSON object found in reviewer output")


def _parse_claim_inventory_payload(payload: Any) -> tuple[ClaimInventoryItem, ...]:
    """Parse the extraction-only contract without accepting model verdicts."""
    if not isinstance(payload, dict):
        raise ValueError("claim inventory must be an object")
    claims: list[ClaimInventoryItem] = []
    seen_ids: set[str] = set()
    for index, raw in enumerate(payload.get("claims", []), start=1):
        if not isinstance(raw, dict):
            continue
        claim_text = ""
        for key in ("claim", "statement", "text", "fact", "assertion"):
            value = raw.get(key)
            if isinstance(value, str) and value.strip():
                claim_text = value.strip()
                break
        if not claim_text:
            continue
        claim_id = str(raw.get("claim_id") or f"C{index}").strip() or f"C{index}"
        if claim_id in seen_ids:
            claim_id = f"{claim_id}-{index}"
        seen_ids.add(claim_id)
        risk = raw.get("risk") if raw.get("risk") in {"high", "medium", "low", "opinion"} else "medium"
        claim_type = _claim_type_for_payload(
            raw,
            claim_text,
            cast(ClaimRisk, risk),
            "unverified",
            None,
        )
        claims.append(ClaimInventoryItem(
            claim_id=claim_id,
            claim=claim_text,
            risk=cast(ClaimRisk, risk),
            claim_type=claim_type,
            legacy_verdict=(
                cast(ClaimVerdictStatus, raw.get("verdict"))
                if raw.get("verdict") in {
                    "verified", "correctable", "contradicted", "unsupported",
                    "unverified", "not_applicable",
                }
                else None
            ),
        ))
    return tuple(claims)


def _non_fact_inventory_verdict(item: ClaimInventoryItem) -> ClaimVerdict:
    return ClaimVerdict(
        claim_id=item.claim_id,
        claim=item.claim,
        risk=item.risk,
        verdict=item.legacy_verdict or "not_applicable",
        reason=(
            "这条内容描述研究过程、观点或引用关系；它不会作为外部事实进入发布门禁。"
        ),
        claim_type=item.claim_type,
    )


def _parse_adjudication_payload(
    payload: Any,
    inventory: tuple[ClaimInventoryItem, ...],
) -> ReviewResult:
    """Bind verdicts back to the immutable inventory; ignore new model claims."""
    parsed = _parse_review_payload(payload)
    by_id = {claim.claim_id: claim for claim in parsed.claims}
    by_text = {" ".join(claim.claim.split()): claim for claim in parsed.claims}
    claims: list[ClaimVerdict] = []
    missing = False
    for item in inventory:
        if item.claim_type != "external_fact" or item.risk == "opinion":
            # The new adjudication contract never receives these rows. Keep a
            # legacy provider's explicit disposition when it happens to echo
            # one back, while forcing the inventory type so it remains outside
            # the factual gate.
            echoed = by_id.get(item.claim_id) or by_text.get(" ".join(item.claim.split()))
            claims.append(
                replace(
                    echoed,
                    claim_id=item.claim_id,
                    claim=item.claim,
                    risk=item.risk,
                    claim_type=item.claim_type,
                )
                if echoed is not None
                else _non_fact_inventory_verdict(item)
            )
            continue
        adjudicated = by_id.get(item.claim_id) or by_text.get(" ".join(item.claim.split()))
        if adjudicated is None:
            missing = True
            claims.append(ClaimVerdict(
                claim_id=item.claim_id,
                claim=item.claim,
                risk=item.risk,
                verdict="unverified",
                reason="证据判断阶段没有返回这条声明的结果，审核覆盖不足。",
                judgment_status="execution_failed",
                execution_error_code="incomplete_batch_output",
                claim_type="external_fact",
            ))
            continue
        claims.append(replace(
            adjudicated,
            claim_id=item.claim_id,
            claim=item.claim,
            risk=item.risk,
            claim_type="external_fact",
        ))

    coverage_status: Literal["complete", "insufficient", "not_applicable"] = (
        "insufficient" if missing else "complete"
    )
    return ReviewResult(
        status=_status_for_claims(claims),
        claims=tuple(claims),
        revision_instructions=parsed.revision_instructions,
        coverage_status=coverage_status,
    )


def _parse_review_payload(payload: Any) -> ReviewResult:
    if not isinstance(payload, dict):
        raise ValueError("reviewer output must be an object")
    claims: list[ClaimVerdict] = []
    for index, raw in enumerate(payload.get("claims", []), start=1):
        if not isinstance(raw, dict):
            continue
        claim_text = ""
        for key in ("claim", "statement", "text", "fact", "assertion"):
            value = raw.get(key)
            if isinstance(value, str) and value.strip():
                claim_text = value.strip()
                break
        # A malformed JSON response sometimes contains verdict placeholders
        # without the statement being audited. An unnamed claim cannot be
        # repaired, displayed, or bound to evidence, so reject it instead of
        # presenting a list of misleading "未命名声明" items to the reader.
        if not claim_text:
            continue
        # DeepSeek 等模型字段名不稳定:verification / status / assessment / verdict。
        verdict = next(
            (raw[k] for k in ("verdict", "verification", "assessment", "status") if raw.get(k)),
            None,
        )
        if verdict not in {"verified", "correctable", "contradicted", "unsupported", "unverified", "not_applicable"}:
            continue
        risk = raw.get("risk") if raw.get("risk") in {"high", "medium", "low", "opinion"} else "medium"
        raw_evidence = raw.get("evidence")
        evidence = None
        if isinstance(raw_evidence, dict):
            evidence = ClaimEvidence(
                claim_id=str(raw.get("claim_id") or f"llm-claim-{index}"),
                source_url=str(raw_evidence["source_url"]) if isinstance(raw_evidence.get("source_url"), str) else None,
                excerpt=str(raw_evidence["excerpt"]) if isinstance(raw_evidence.get("excerpt"), str) else None,
                observed_at=str(raw_evidence["observed_at"]) if isinstance(raw_evidence.get("observed_at"), str) else None,
                resolver=str(raw_evidence["resolver"]) if isinstance(raw_evidence.get("resolver"), str) else None,
            )
        raw_judgment_status = raw.get("judgment_status")
        judgment_status: ClaimJudgmentStatus = (
            cast(ClaimJudgmentStatus, raw_judgment_status)
            if raw_judgment_status in {"settled", "not_judged", "execution_failed", "disputed"}
            else "settled"
        )
        execution_error_code = (
            str(raw["execution_error_code"])
            if isinstance(raw.get("execution_error_code"), str)
            else None
        )
        claim_type = _claim_type_for_payload(
            raw,
            claim_text,
            cast(ClaimRisk, risk),
            cast(ClaimVerdictStatus, verdict),
            evidence,
        )
        claims.append(ClaimVerdict(
            str(raw.get("claim_id") or f"llm-claim-{index}"),
            claim_text,
            cast(ClaimRisk, risk),
            cast(ClaimVerdictStatus, verdict),
            evidence=evidence,
            correction=str(raw["correction"]) if raw.get("correction") is not None else None,
            reason=str(raw["reason"]) if raw.get("reason") is not None else None,
            judgment_status=judgment_status,
            execution_error_code=execution_error_code,
            claim_type=claim_type,
        ))
    instructions = tuple(str(item) for item in payload.get("revision_instructions", []) if isinstance(item, str))
    return ReviewResult(_status_for_claims(claims), tuple(claims), instructions)


def _status_for_claims(claims: list[ClaimVerdict]) -> ReviewStatus:
    factual_claims = [
        item for item in claims
        if (
            item.claim_type == "external_fact"
            and
            item.risk != "opinion"
            and item.verdict != "not_applicable"
            and not _is_citation_relationship(item)
        )
    ]
    # A publication block is reserved for a high-risk fact explicitly
    # contradicted by evidence. Lower-risk conflicts still require repair,
    # but should not make the whole report unpublishable by default.
    if any(item.verdict == "contradicted" and item.risk == "high" for item in factual_claims):
        return "blocked"
    if any(item.verdict == "contradicted" for item in factual_claims):
        return "needs_revision"
    if any(item.verdict in {"correctable", "unsupported", "unverified"} for item in factual_claims):
        return "needs_revision"
    return "passed"


def _attach_claim_locations(report: str, result: ReviewResult) -> ReviewResult:
    """Attach best-effort report offsets to the immutable review ledger.

    Deterministic resolvers already know the source sentence and LLM claims
    often repeat it verbatim.  Keeping the offsets on the review result makes
    the user's next action concrete (locate/edit/challenge) while remaining
    safe for claims whose wording cannot be found: those simply keep a null
    location and remain actionable through the claim text.
    """
    if not report or not result.claims:
        return result
    cursor = 0

    def locate(claim_text: str, start_at: int) -> tuple[int, int] | None:
        """Locate a claim exactly, then fall back to a conservative sentence match.

        Reviewers often normalize a sentence while preserving its key terms. A
        strict substring lookup would make those claims un-navigable, while a
        loose keyword search could point at the wrong paragraph. The fallback
        therefore returns a whole report sentence only when it shares a long,
        contiguous phrase with the claim and the match is sufficiently strong.
        """
        exact = report.find(claim_text, start_at)
        if exact < 0:
            exact = report.find(claim_text)
        if exact >= 0:
            return exact, exact + len(claim_text)

        normalized_claim = re.sub(r"\s+", "", claim_text)
        if len(normalized_claim) < 12:
            return None
        best: tuple[float, int, int] | None = None
        segment_pattern = re.compile(r"[^。\n！？!?；;]+[。\n！？!?；;]?")
        for match in segment_pattern.finditer(report, start_at):
            raw_segment = match.group(0)
            normalized_segment = re.sub(r"\s+", "", raw_segment)
            if len(normalized_segment) < 12:
                continue
            common = SequenceMatcher(None, normalized_claim, normalized_segment).find_longest_match(
                0, len(normalized_claim), 0, len(normalized_segment)
            ).size
            ratio = SequenceMatcher(None, normalized_claim, normalized_segment).ratio()
            coverage = common / len(normalized_claim)
            if common < max(12, min(24, round(len(normalized_claim) * 0.3))) \
                or (ratio < 0.35 and coverage < 0.65):
                continue
            score = ratio + min(common, 80) / 1_000
            candidate = (score, match.start(), match.end())
            if best is None or candidate[0] > best[0]:
                best = candidate
        if best is None:
            return None
        start, end = best[1], best[2]
        while start < end and report[start].isspace():
            start += 1
        while end > start and report[end - 1].isspace():
            end -= 1
        return start, end

    enriched: list[ClaimVerdict] = []
    for item in result.claims:
        location = item.location
        if location is None and item.claim.strip():
            location = locate(item.claim.strip(), cursor)
            if location is not None:
                cursor = location[1]
        enriched.append(replace(item, location=location))
    return replace(result, claims=tuple(enriched))


__all__ = [
    "Claim", "ClaimEvidence", "ClaimVerdict", "DefaultResearchReviewer",
    "ResearchReviewer", "ReviewResult", "ReviewStatus",
]
