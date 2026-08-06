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
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any, Literal, Protocol, cast
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
ClaimRisk = Literal["high", "medium", "low", "opinion"]
ClaimVerdictStatus = Literal[
    "verified", "correctable", "contradicted", "unsupported",
    "unverified", "not_applicable",
]

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


@dataclass(slots=True, frozen=True)
class Claim:
    id: str
    text: str
    risk: ClaimRisk
    location: tuple[int, int] | None = None
    fact_type: str = "generic"
    value: str | None = None


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


@dataclass(slots=True, frozen=True)
class ReviewResult:
    status: ReviewStatus
    claims: tuple[ClaimVerdict, ...] = ()
    revision_instructions: tuple[str, ...] = ()
    reviewed_report: str | None = None
    error: str | None = None
    attempts: int = 1

    @property
    def corrected_count(self) -> int:
        return sum(item.verdict == "correctable" for item in self.claims)

    @property
    def unverified_count(self) -> int:
        return sum(item.verdict in {"unverified", "unsupported"} for item in self.claims)

    @property
    def contradicted_count(self) -> int:
        return sum(item.verdict == "contradicted" for item in self.claims)

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["corrected_count"] = self.corrected_count
        value["unverified_count"] = self.unverified_count
        value["contradicted_count"] = self.contradicted_count
        return value


class ResearchReviewer(Protocol):
    async def review(
        self,
        report: str,
        sources: tuple[AdapterSource, ...],
        topic: str,
        *,
        report_type: str = "research_report",
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


def _source_urls(sources: tuple[AdapterSource, ...]) -> set[str]:
    urls: set[str] = set()
    for source in sources:
        if source.canonical_key.startswith(("http://", "https://")):
            urls.add(source.canonical_key)
        value = source.source_ref.get("value")
        if isinstance(value, str) and value.startswith(("http://", "https://")):
            urls.add(value)
    return urls


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


_REVIEW_SYSTEM = """你是独立的事实审核 Agent，不负责重写报告。
只审核报告中的可验证事实，不审核观点、建议和推测。
必须严格区分 verified、unsupported、unverified 和 contradicted。
引用 URL 存在不代表引用内容支持声明；无法确认时必须使用 unverified。
只输出合法 JSON，不要 Markdown，不要补充 JSON 之外的文字。
JSON 格式：{"status":"passed|needs_revision|blocked","claims":[{"claim_id":"...","claim":"...","risk":"high|medium|low|opinion","verdict":"verified|correctable|contradicted|unsupported|unverified|not_applicable","evidence":{"source_url":null,"excerpt":null,"observed_at":null,"resolver":null},"correction":null,"reason":null}],"revision_instructions":[]}
"""


class DefaultResearchReviewer:
    """Hybrid reviewer: deterministic GitHub checks plus LLM citation audit."""

    def __init__(self, *, llm_spec: str | None = None) -> None:
        self._llm_spec = llm_spec

    async def review(
        self,
        report: str,
        sources: tuple[AdapterSource, ...],
        topic: str,
        *,
        report_type: str = "research_report",
    ) -> ReviewResult:
        deterministic, instructions, has_dynamic_claim = await _review_github_claims(
            report, sources
        )
        for resolver_review in (_review_github_metadata_claims, _review_package_and_paper_claims):
            extra_claims, extra_instructions, extra_dynamic = await resolver_review(report, sources)
            deterministic.extend(extra_claims)
            instructions.extend(extra_instructions)
            has_dynamic_claim = has_dynamic_claim or extra_dynamic
        if has_dynamic_claim and any(item.verdict == "unverified" for item in deterministic):
            return ReviewResult("needs_revision", tuple(deterministic), tuple(instructions))

        source_text = "\n".join(
            f"- {source.title or source.canonical_key}: {source.snippet or '(无正文摘要)'}"
            for source in sources
        )[:12000]
        prompt = (
            f"主题：{topic}\n报告类型：{report_type}\n报告：\n{report[:24000]}\n"
            f"来源证据：\n{source_text}\n"
            "请提取并审核高风险和中风险事实。普通观点标记 not_applicable。"
        )
        try:
            generated = await generate_text(
                user_prompt=prompt,
                system_prompt=_REVIEW_SYSTEM,
                llm_spec=self._llm_spec,
                tier="light",
                max_tokens=2400,
                timeout=60.0,
                disable_thinking=True,
            )
            payload = _extract_json_object(generated.text)
            llm_result = _parse_review_payload(payload)
        except Exception as exc:
            # 记录 LLM 原始输出前 500 字符,便于诊断不遵循 JSON 指令的模型(如 DeepSeek)。
            _raw = generated.text[:500] if "generated" in locals() and generated.text else "<no output>"
            _review_logger.warning(
                "review LLM output not parseable: err=%s output=%r", type(exc).__name__, _raw
            )
            # LLM 可能忽略 JSON 指令返回纯文本/空响应。此时用 deterministic 检查
            # 作为降级:有确定性发现 → needs_revision;无 → 视作通过(没有可核验矛盾)。
            # 避免把"模型输出不合规"误报成"审核服务不可用"。
            if deterministic:
                return ReviewResult("needs_revision", tuple(deterministic), tuple(instructions), error=type(exc).__name__)
            if not has_dynamic_claim:
                return ReviewResult("passed", tuple(deterministic), tuple(instructions), error=type(exc).__name__)
            return ReviewResult("review_unavailable", error=f"{type(exc).__name__}: reviewer unavailable")

        merged = list(deterministic)
        dynamic_ids = {item.claim_id for item in merged}
        merged.extend(item for item in llm_result.claims if item.claim_id not in dynamic_ids)
        merged_instructions = tuple(dict.fromkeys((*instructions, *llm_result.revision_instructions)))
        status = _status_for_claims(merged)
        return ReviewResult(status, tuple(merged), merged_instructions)


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

    # 3) 平衡括号截取首个 JSON 对象
    for idx, ch in enumerate(stripped):
        if ch == "{":
            segment = _balanced(stripped, idx)
            obj = json.loads(segment)
            if isinstance(obj, dict):
                return obj

    raise ValueError("no JSON object found in reviewer output")


def _parse_review_payload(payload: Any) -> ReviewResult:
    if not isinstance(payload, dict):
        raise ValueError("reviewer output must be an object")
    claims: list[ClaimVerdict] = []
    for index, raw in enumerate(payload.get("claims", []), start=1):
        if not isinstance(raw, dict):
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
        claims.append(ClaimVerdict(
            str(raw.get("claim_id") or f"llm-claim-{index}"),
            str(raw.get("claim") or ""),
            cast(ClaimRisk, risk),
            cast(ClaimVerdictStatus, verdict),
            evidence=evidence,
            correction=str(raw["correction"]) if raw.get("correction") is not None else None,
            reason=str(raw["reason"]) if raw.get("reason") is not None else None,
        ))
    instructions = tuple(str(item) for item in payload.get("revision_instructions", []) if isinstance(item, str))
    return ReviewResult(_status_for_claims(claims), tuple(claims), instructions)


def _status_for_claims(claims: list[ClaimVerdict]) -> ReviewStatus:
    if any(item.verdict == "contradicted" for item in claims):
        return "blocked"
    if any(item.verdict in {"correctable", "unsupported", "unverified"} for item in claims):
        return "needs_revision"
    return "passed"


__all__ = [
    "Claim", "ClaimEvidence", "ClaimVerdict", "DefaultResearchReviewer",
    "ResearchReviewer", "ReviewResult", "ReviewStatus",
]
