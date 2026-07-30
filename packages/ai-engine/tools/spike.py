"""Spike harness for Week 2 AI-engine evaluation.

Runs a topic through a chosen adapter and records 7 metrics:
- completion_rate (succeeded / partial / failed)
- source accessibility ratio
- latency (ms)
- token in/out
- search count
- estimated cost (USD)
- human-adoptability score

The harness delegates
to `build_adapter()` (same factory the server uses), so it Just Works when
`AI_ENGINE_ADAPTER=gpt_researcher` is set in the environment.

Usage:
    AI_ENGINE_ADAPTER=gpt_researcher uv run python tools/spike.py --adapter gpt_researcher
    uv run python tools/spike.py --adapter fake
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterable

import httpx

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from ai_engine.adapters.base import ResearchEngineAdapter, build_adapter  # noqa: E402
from ai_engine.contracts.states import (  # noqa: E402
    AI_JOB_STATUS,
    PARTIAL_MIN_SOURCES,
    SourcePolicy,
)
from ai_engine.job_runner.runner import run_one_available_job  # noqa: E402
from ai_engine.job_runner.store import InMemoryJobStore, make_job_snapshot  # noqa: E402

SUPPORTED_ADAPTERS = ("fake", "gpt_researcher")

DEFAULT_TOPICS = [
    "2025 年大模型 Agent 框架对比",
    "RAG 在企业知识库的落地挑战",
    "国产开源向量数据库横评",
]

INJECTION_PATTERNS = (
    r"ignore\s+(?:all\s+)?previous\s+instructions",
    r"disregard\s+(?:the\s+)?system\s+prompt",
    r"reveal\s+(?:the\s+)?system\s+prompt",
    r"act\s+as\s+(?:an?\s+)?unrestricted",
)

DEFAULT_COST_PER_1M_INPUT_CENTS = 300
DEFAULT_COST_PER_1M_OUTPUT_CENTS = 1500


@dataclass(slots=True)
class SpikeMetrics:
    adapter: str
    topic: str
    report_type: str
    source_policy: SourcePolicy
    final_status: str
    elapsed_ms: int
    sources_captured: int
    sources_accessible: int
    sources_accessible_ratio: float
    search_count: int
    token_input_total: int
    token_output_total: int
    cost_cents: int
    cost_usd: float
    human_adoptability: float
    has_structured_fields: bool
    injection_signals: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    error_code: str | None = None
    error_message: str | None = None


def _slugify(text: str) -> str:
    out = re.sub(r"\s+", "-", text.strip())
    out = re.sub(r"[^\w一-鿿-]+", "", out)
    return out[:60] or "topic"


def _check_injection_signals(text: str) -> list[str]:
    return [pat for pat in INJECTION_PATTERNS if re.search(pat, text, re.IGNORECASE)]


def _human_adoptability(
    *,
    sources: int,
    has_structured_fields: bool,
    injection_signals: list[str],
) -> float:
    if sources < PARTIAL_MIN_SOURCES:
        return 0.0
    score = 0.4 if has_structured_fields else 0.2
    score += min(sources, 10) * 0.06
    if injection_signals:
        score *= 0.5
    return min(1.0, round(score, 3))


async def _probe_url_accessibility(adapter: ResearchEngineAdapter, job_id: str) -> tuple[int, int]:
    status = await adapter.get_status(job_id)
    urls = [
        str(source.source_ref["value"])
        for source in status.sources
        if source.source_ref.get("type") == "url" and source.source_ref.get("value")
    ]

    async def probe(client: httpx.AsyncClient, url: str) -> bool:
        try:
            response = await client.head(url)
            if response.status_code in {405, 501}:
                response = await client.get(url, headers={"Range": "bytes=0-0"})
            return response.status_code < 400
        except httpx.HTTPError:
            return False

    async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
        checks = await asyncio.gather(*(probe(client, url) for url in urls))
    total = len(urls)
    accessible = sum(checks)
    return accessible, total


async def run_one(
    *,
    adapter_name: str,
    topic: str,
    report_type: str = "research_report",
    source_policy: SourcePolicy = "prefer_user_sources",
    fast: bool = True,
) -> SpikeMetrics:
    """Run a single (adapter, topic) spike and return its metrics."""
    notes: list[str] = []
    try:
        adapter = build_adapter(name=adapter_name)
    except Exception as exc:
        notes.append(f"build_adapter({adapter_name!r}) failed: {exc}")
        return SpikeMetrics(
            adapter=adapter_name, topic=topic, report_type=report_type,
            source_policy=source_policy, final_status=AI_JOB_STATUS["FAILED"],
            elapsed_ms=0, sources_captured=0, sources_accessible=0,
            sources_accessible_ratio=0.0, search_count=0, token_input_total=0,
            token_output_total=0, cost_cents=0, cost_usd=0.0,
            human_adoptability=0.0, has_structured_fields=False,
            notes=notes, error_code="INTERNAL",
            error_message=str(exc)[:500],
        )

    # Extended lease for real LLM adapters; 60s default is too short.
    lease = int(os.environ.get("SPIKE_LEASE_SECONDS", "300"))
    store = InMemoryJobStore(lease_seconds=lease, heartbeat_seconds=max(15, lease // 4))
    snapshot = make_job_snapshot(
        topic=topic, report_type=report_type, source_policy=source_policy  # type: ignore[arg-type]
    )
    await store.enqueue(snapshot)

    started = time.perf_counter()
    if fast:
        os.environ["AI_ENGINE_TEST_FAST_POLL"] = "1"
    outcome = await run_one_available_job(store=store, adapter=adapter)
    elapsed_ms = int((time.perf_counter() - started) * 1000)

    if outcome is None:
        return SpikeMetrics(
            adapter=adapter_name, topic=topic, report_type=report_type,
            source_policy=source_policy, final_status="failed",
            elapsed_ms=elapsed_ms, sources_captured=0, sources_accessible=0,
            sources_accessible_ratio=0.0, search_count=0, token_input_total=0,
            token_output_total=0, cost_cents=0, cost_usd=0.0,
            human_adoptability=0.0, has_structured_fields=False,
            notes=notes + ["outcome is None — store had no queued job"],
            error_code="INTERNAL", error_message="no outcome returned",
        )

    accessible, total = await _probe_url_accessibility(adapter, outcome.job_id)
    ratio = (accessible / total) if total else 0.0

    body = f"{topic}\n\n{outcome.current_step or ''}\n"
    injection = _check_injection_signals(body)
    has_structured = bool(outcome.field_metadata)
    adoptability = _human_adoptability(
        sources=len(outcome.sources),
        has_structured_fields=has_structured,
        injection_signals=injection,
    )

    cost_cents = outcome.cost.cost_cents
    return SpikeMetrics(
        adapter=adapter_name, topic=topic, report_type=report_type,
        source_policy=source_policy, final_status=outcome.final_status,
        elapsed_ms=elapsed_ms, sources_captured=len(outcome.sources),
        sources_accessible=accessible,
        sources_accessible_ratio=round(ratio, 3),
        search_count=outcome.cost.search_count,
        token_input_total=outcome.cost.token_input_total,
        token_output_total=outcome.cost.token_output_total,
        cost_cents=cost_cents, cost_usd=round(cost_cents / 100.0, 4),
        human_adoptability=adoptability,
        has_structured_fields=has_structured,
        injection_signals=injection, notes=notes,
        error_code=outcome.error_code,
        error_message=outcome.error_message,
    )


def render_markdown(metrics: SpikeMetrics) -> str:
    lines = [
        f"# Spike · `{metrics.adapter}` · {metrics.topic}",
        "",
        f"- **final_status**: `{metrics.final_status}`",
        f"- **elapsed_ms**: {metrics.elapsed_ms}",
        f"- **sources_captured**: {metrics.sources_captured}",
        f"- **sources_accessible_ratio**: {metrics.sources_accessible_ratio:.0%} "
        f"({metrics.sources_accessible}/{metrics.sources_captured})",
        f"- **search_count**: {metrics.search_count}",
        f"- **token_input_total / token_output_total**: "
        f"{metrics.token_input_total} / {metrics.token_output_total}",
        f"- **cost_cents**: {metrics.cost_cents} (≈ ${metrics.cost_usd:.4f})",
        f"- **human_adoptability** (heuristic 0..1): {metrics.human_adoptability}",
        f"- **has_structured_fields**: {metrics.has_structured_fields}",
        f"- **injection_signals**: {metrics.injection_signals or 'none'}",
    ]
    if metrics.error_code:
        lines.append(f"- **error_code**: `{metrics.error_code}`")
        lines.append(f"- **error_message**: {metrics.error_message}")
    if metrics.notes:
        lines.append("")
        lines.append("## Notes")
        for note in metrics.notes:
            lines.append(f"- {note}")
    lines.append("")
    return "\n".join(lines)


def render_summary_markdown(
    runs: list[SpikeMetrics], *, header: bool = True
) -> str:
    real = [m for m in runs if m.error_code != "NOT_IMPLEMENTED"]
    stub = [m for m in runs if m.error_code == "NOT_IMPLEMENTED"]

    lines: list[str] = []
    if header:
        lines.append("# AI 引擎 Spike 汇总")
        lines.append("")
    if real:
        lines.append("## 已跑通的 adapter")
        lines.append("")
        lines.append(
            "| Adapter | Topic | Status | Sources | Access | Tokens (in/out) | Cost (cents) | Adopt |"
        )
        lines.append("|---|---|---|---:|---:|---|---:|---:|")
        for m in real:
            lines.append(
                f"| `{m.adapter}` | {m.topic} | `{m.final_status}` | "
                f"{m.sources_captured} | {m.sources_accessible_ratio:.0%} | "
                f"{m.token_input_total}/{m.token_output_total} | "
                f"{m.cost_cents} | {m.human_adoptability} |"
            )
        lines.append("")

    if stub:
        lines.append("## 未实现的 adapter")
        lines.append("")
        lines.append("| Adapter | Topic | Notes |")
        lines.append("|---|---|---|")
        for m in stub:
            lines.append(
                f"| `{m.adapter}` | {m.topic} | "
                f"{m.error_code}: {m.error_message} |"
            )
        lines.append("")

    lines.append("## 主引擎验收指标(IMPLEMENTATION_PLAN §三)")
    if not real:
        lines.append("- 没有真实运行的 adapter 行;请在注入 API key 后重跑")
    else:
        success = sum(1 for m in real if m.final_status == "succeeded")
        ratio_med = _median([m.sources_accessible_ratio for m in real])
        cost_med = _median([m.cost_cents for m in real])
        elapsed_med = _median([m.elapsed_ms for m in real])
        lines.append(f"- 任务有结果比例: {success}/{len(real)} (阈值 3/3)")
        lines.append(f"- 引用 URL 可访问率中位数: {ratio_med:.0%} (阈值 >= 80%)")
        lines.append(f"- 单次估算成本中位数: ${cost_med / 100:.4f} (阈值 <= $0.35)")
        lines.append(f"- 单任务时延中位数: {elapsed_med} ms (阈值 <= 5 min)")
    return "\n".join(lines) + "\n"


def _median(xs: list[float]) -> float:
    if not xs:
        return 0.0
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 == 1 else (s[n // 2 - 1] + s[n // 2]) / 2


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="AI-engine spike harness")
    p.add_argument("--adapter", choices=SUPPORTED_ADAPTERS, default="fake")
    p.add_argument("--topic")
    p.add_argument("--topics-file")
    p.add_argument("--output", default="reports/")
    p.add_argument(
        "--source-policy",
        choices=["prefer_user_sources", "only_user_sources"],
        default="prefer_user_sources",
    )
    return p.parse_args(list(argv) if argv is not None else None)


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv)
    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.topics_file:
        topics = [t.strip() for t in Path(args.topics_file).read_text().splitlines() if t.strip()]
    elif args.topic:
        topics = [args.topic]
    else:
        topics = DEFAULT_TOPICS

    runs: list[SpikeMetrics] = []
    for topic in topics:
        metrics = asyncio.run(
            run_one(
                adapter_name=args.adapter,
                topic=topic,
                source_policy=args.source_policy,
            )
        )
        runs.append(metrics)
        slug = _slugify(topic)
        report_path = out_dir / f"spike-{args.adapter}-{slug}.md"
        report_path.write_text(render_markdown(metrics), encoding="utf-8")
        (out_dir / f"spike-{args.adapter}-{slug}.json").write_text(
            json.dumps(asdict(metrics), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"wrote {report_path}")

    summary_path = out_dir / "spike-summary.md"
    is_first = not summary_path.exists()
    section = render_summary_markdown(runs, header=is_first)
    if is_first:
        summary_path.write_text(section, encoding="utf-8")
    else:
        with summary_path.open("a", encoding="utf-8") as fh:
            fh.write("\n---\n\n")
            fh.write(render_summary_markdown(runs, header=False))
    print(f"updated {summary_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
