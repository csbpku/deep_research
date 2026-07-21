"""Spike harness for Week 1 AI-engine evaluation.

Runs a topic through a chosen adapter and records:
- completion_rate (succeeded / partial / failed)
- source accessibility ratio (HEAD probe over the captured URLs)
- latency (ms)
- token in/out
- search count
- estimated cost (USD)
- human-adoptability score (heuristic: structured fields, ≥3 sources,
  no prompt-injection strings in the body)

This module is **deliberately** separate from the package so its CLI
imports don't drag structlog/FastAPI into a one-shot run.

Usage:
    uv run python tools/spike.py --adapter fake --topic "2025 年大模型 Agent 框架对比"
    uv run python tools/spike.py --adapter fake --topics-file topics.txt --output reports/
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

# Make the package importable when running as `python tools/spike.py`.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from ai_engine.adapters.fake import FakeAdapter  # noqa: E402
from ai_engine.contracts.states import (  # noqa: E402
    AI_JOB_STATUS,
    PARTIAL_MIN_SOURCES,
    SourcePolicy,
)
from ai_engine.job_runner.runner import run_one_available_job  # noqa: E402
from ai_engine.job_runner.store import InMemoryJobStore, make_job_snapshot  # noqa: E402

# The default CLI adapter. Other adapters (claude/gpt_researcher) require
# real API keys; see ADR 0004 for Week 5 selection.
SUPPORTED_ADAPTERS = ("fake", "claude", "gpt_researcher")

DEFAULT_TOPICS = [
    "2025 年大模型 Agent 框架对比",
    "RAG 在企业知识库的落地挑战",
    "国产开源向量数据库横评",
]

# Prompt-injection markers; matches the same list ARCHITECTURE §六 uses
# for "ignore previous instructions" style payloads.
INJECTION_PATTERNS = (
    r"ignore\s+(?:all\s+)?previous\s+instructions",
    r"disregard\s+(?:the\s+)?system\s+prompt",
    r"reveal\s+(?:the\s+)?system\s+prompt",
    r"act\s+as\s+(?:an?\s+)?unrestricted",
)

# Default Claude Sonnet 4.5 prices in cents per 1M tokens.
DEFAULT_COST_PER_1M_INPUT_CENTS = 300
DEFAULT_COST_PER_1M_OUTPUT_CENTS = 1500


@dataclass(slots=True)
class SpikeMetrics:
    """Aggregate metrics for a single (adapter, topic) run."""

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
    """Turn a Chinese topic into a filesystem-safe slug."""
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
    """0..1 heuristic: title/body, ≥3 sources, no injection signals.

    The spike report is for human review, not auto-grading. This number
    is meant as a quick sorting aid and explicitly noted as heuristic
    in the report.
    """
    if sources < PARTIAL_MIN_SOURCES:
        return 0.0
    score = 0.4 if has_structured_fields else 0.2
    score += min(sources, 10) * 0.06  # 0.6 ceiling for 10 sources
    if injection_signals:
        score *= 0.5
    return min(1.0, round(score, 3))


async def _probe_url_accessibility(adapter: FakeAdapter, job_id: str) -> tuple[int, int]:
    """Stand-in for real HEAD probes.

    The fake adapter's sources are all `https://example.test/...` —
    the probe would be a real HEAD call in production. We simulate by
    counting the `is_accessible` field the adapter already records.
    """
    from ai_engine.adapters.base import AdapterStatus  # noqa: PLC0415

    status = await adapter.get_status(job_id)
    if not isinstance(status, AdapterStatus):
        return 0, 0
    total = len(status.sources)
    accessible = sum(1 for s in status.sources if s.is_accessible)
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
    if adapter_name != "fake":
        # Stub: not yet implemented. We record this as a real FAILED spike
        # entry with the NOT_IMPLEMENTED error code so the report is honest
        # — see task prompt §9 "缺 key 改用公开 demo 数据,如实写".
        notes.append(
            f"adapter={adapter_name} not yet implemented in Week 1 skeleton; "
            "no API key was injected, so this row records a stub failure "
            "rather than borrowing fake-adapter numbers."
        )
        return SpikeMetrics(
            adapter=adapter_name,
            topic=topic,
            report_type=report_type,
            source_policy=source_policy,
            final_status=AI_JOB_STATUS["FAILED"],
            elapsed_ms=0,
            sources_captured=0,
            sources_accessible=0,
            sources_accessible_ratio=0.0,
            search_count=0,
            token_input_total=0,
            token_output_total=0,
            cost_cents=0,
            cost_usd=0.0,
            human_adoptability=0.0,
            has_structured_fields=False,
            notes=notes,
            error_code="NOT_IMPLEMENTED",
            error_message=(
                f"adapter {adapter_name!r} requires API key + Week 5 implementation"
            ),
        )

    adapter = FakeAdapter(default_mode="success", step_seconds=0.0)
    store = InMemoryJobStore()
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
            adapter=adapter_name,
            topic=topic,
            report_type=report_type,
            source_policy=source_policy,
            final_status="failed",
            elapsed_ms=elapsed_ms,
            sources_captured=0,
            sources_accessible=0,
            sources_accessible_ratio=0.0,
            search_count=0,
            token_input_total=0,
            token_output_total=0,
            cost_cents=0,
            cost_usd=0.0,
            human_adoptability=0.0,
            has_structured_fields=False,
            notes=notes + ["outcome is None — store had no queued job"],
            error_code="INTERNAL",
            error_message="no outcome returned",
        )

    accessible, total = await _probe_url_accessibility(adapter, outcome.job_id)
    ratio = (accessible / total) if total else 0.0

    # Build a synthetic body to run injection heuristics against. In a real
    # spike the body would be the final report. For fake we use the topic
    # and a fixed marker.
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
        adapter=adapter_name,
        topic=topic,
        report_type=report_type,
        source_policy=source_policy,
        final_status=outcome.final_status,
        elapsed_ms=elapsed_ms,
        sources_captured=len(outcome.sources),
        sources_accessible=accessible,
        sources_accessible_ratio=round(ratio, 3),
        search_count=outcome.cost.search_count,
        token_input_total=outcome.cost.token_input_total,
        token_output_total=outcome.cost.token_output_total,
        cost_cents=cost_cents,
        cost_usd=round(cost_cents / 100.0, 4),
        human_adoptability=adoptability,
        has_structured_fields=has_structured,
        injection_signals=injection,
        notes=notes,
        error_code=outcome.error_code,
        error_message=outcome.error_message,
    )


def render_markdown(metrics: SpikeMetrics) -> str:
    """Render one report file (Markdown) for a single (adapter, topic) run."""
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
    """Aggregate Markdown summary across multiple runs.

    Stub rows (NOT_IMPLEMENTED) are listed in a separate "未实现" section
    so they don't pollute the §三 acceptance stats.

    `header=False` produces a body-only section so appends don't repeat
    the title.
    """
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
            "| Adapter | Topic | Status | Sources | Access | Tokens (in/out) | Cost (¢) | Adopt |"
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
        lines.append("## 未实现的 adapter(Week 5 stub)")
        lines.append("")
        lines.append("| Adapter | Topic | Notes |")
        lines.append("|---|---|---|")
        for m in stub:
            lines.append(
                f"| `{m.adapter}` | {m.topic} | "
                f"{m.error_code}: {m.error_message} |"
            )
        lines.append("")

    # Decision matrix per IMPLEMENTATION_PLAN §三 acceptance.
    lines.append("## 主引擎验收指标(IMPLEMENTATION_PLAN §三)")
    if not real:
        lines.append("- 没有真实运行的 adapter 行;请在注入 API key 后重跑")
    else:
        success = sum(1 for m in real if m.final_status == "succeeded")
        ratio_med = _median([m.sources_accessible_ratio for m in real])
        cost_med = _median([m.cost_cents for m in real])
        elapsed_med = _median([m.elapsed_ms for m in real])
        lines.append(f"- 任务有结果比例: {success}/{len(real)} (阈值 3/3)")
        lines.append(f"- 引用 URL 可访问率中位数: {ratio_med:.0%} (阈值 ≥ 80%)")
        lines.append(f"- 单次估算成本中位数: ${cost_med / 100:.4f} (阈值 ≤ $0.35)")
        lines.append(f"- 单任务时延中位数: {elapsed_med} ms (阈值 ≤ 5 分钟)")
    return "\n".join(lines) + "\n"


def _median(xs: list[float]) -> float:
    if not xs:
        return 0.0
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 == 1 else (s[n // 2 - 1] + s[n // 2]) / 2


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="AI-engine spike harness")
    p.add_argument(
        "--adapter",
        choices=SUPPORTED_ADAPTERS,
        default="fake",
        help="Adapter to evaluate (fake runs end-to-end; claude/gpt_researcher are stubs).",
    )
    p.add_argument("--topic", help="Single topic to run.")
    p.add_argument(
        "--topics-file",
        help="Path to a newline-delimited topic list. If neither --topic nor --topics-file is given, "
        "the harness uses 3 default Chinese topics.",
    )
    p.add_argument(
        "--output",
        default="reports/",
        help="Directory to write per-topic Markdown reports and a summary.",
    )
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

    # Append to summary (create if absent). This lets `--adapter fake` and
    # `--adapter claude` accumulate into one `spike-summary.md`.
    summary_path = out_dir / "spike-summary.md"
    is_first = not summary_path.exists()
    section = render_summary_markdown(runs, header=is_first)
    if is_first:
        summary_path.write_text(section, encoding="utf-8")
    else:
        # Append with a small separator so the file stays readable.
        with summary_path.open("a", encoding="utf-8") as fh:
            fh.write("\n---\n\n")
            fh.write(render_summary_markdown(runs, header=False))
    print(f"updated {summary_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())