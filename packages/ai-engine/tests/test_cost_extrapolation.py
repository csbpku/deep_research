"""Week 9 收尾验收：月成本外推脚本的契约测试。

依据：docs/IMPLEMENTATION_PLAN.md §十一
  - "月成本按当前试用强度外推不超过 $200"
  - "超过则在试用前降低每日额度"

本测试不依赖 DB / LLM，纯算术。
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
COST_SCRIPT = REPO_ROOT / "scripts" / "cost_extrapolation.py"


def _run_cost_script() -> list[dict]:
    """运行 cost_extrapolation.py 并解析 JSON。"""
    result = subprocess.run(
        [sys.executable, str(COST_SCRIPT)],
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert result.returncode == 0, (
        f"cost_extrapolation.py failed: {result.stderr}"
    )
    # 脚本同时 print JSON + 人类可读说明；只取首个 JSON 段
    json_start = result.stdout.find("[")
    json_end = result.stdout.rfind("]") + 1
    return json.loads(result.stdout[json_start:json_end])


def test_cost_script_runs_and_returns_two_scenarios() -> None:
    """脚本应输出至少 2 个场景（单人 + 5 人上限）。"""
    results = _run_cost_script()
    assert len(results) >= 2
    labels = [item["label"] for item in results]
    assert any("single-user" in label for label in labels)
    assert any("5-user" in label or "5-user" in label for label in labels)


def test_all_scenarios_within_200_budget() -> None:
    """§十一 硬门槛：月成本 ≤ $200。"""
    results = _run_cost_script()
    for r in results:
        assert r["monthly_total_usd"] <= 200.0, (
            f"scenario {r['label']!r} over budget: "
            f"${r['monthly_total_usd']:.2f} > $200"
        )
        assert r["within_200_budget"] is True


def test_research_cost_dominates_budget() -> None:
    """AI 调研是大头；其他都是零头。合理性守门。"""
    results = _run_cost_script()
    for r in results:
        research = r["research_cost_usd"]
        aux = r["auxiliary_cost_usd"]
        # 调研至少占 60%（小规模下可能更高）
        assert research > aux * 1.5, (
            f"research should dominate; got research={research} aux={aux} "
            f"in {r['label']!r}"
        )


def test_search_cost_proportional_to_research_jobs() -> None:
    """搜索成本 = n_jobs × searches × tavily_per_search。"""
    results = _run_cost_script()
    for r in results:
        n_jobs = r["research_jobs"]
        # 单人：40 jobs × 3 searches × $0.01 = $1.2
        # 5 人：200 × 3 × $0.01 = $6.0
        expected = round(n_jobs * 3 * 0.01, 2)
        assert r["search_cost_usd"] == expected, (
            f"search cost math wrong: got {r['search_cost_usd']} "
            f"expected {expected} for {r['label']!r}"
        )


def test_scaling_is_linear() -> None:
    """5 人场景应约为单人场景的 5 倍（线性外推）。"""
    results = _run_cost_script()
    single = next(r for r in results if "single-user" in r["label"])
    five = next(r for r in results if "5-user" in r["label"])
    ratio = five["research_jobs"] / single["research_jobs"]
    assert ratio == pytest.approx(5.0, rel=0.01)
    # 成本比应接近 5×
    cost_ratio = five["monthly_total_usd"] / single["monthly_total_usd"]
    assert 4.5 <= cost_ratio <= 5.5
