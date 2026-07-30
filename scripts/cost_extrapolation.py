"""Week 9 收尾验收：月成本外推。

依据：docs/IMPLEMENTATION_PLAN.md §十一
  - "月成本按当前试用强度外推不超过 $200；超过则在试用前降低每日额度"
  - "用真实 token/search 数据重算月成本"（§十二 Week 12）

逻辑：
  1. 单次 AI 调研成本 = LLM 成本 + 搜索成本
     - LLM：gpt-researcher 在 A/B 对比中实测中位数 $0.21/任务（按 GPT-4o list 价格
       计费，与 `gpt_researcher.utils.costs` 硬编码的 $5/$15 per 1M 一致）。
     - 实际部署若切到 Claude Haiku 4.5 / DeepSeek V4 Flash via cc-switch proxy，
       真实账单由 cc-switch 决定；本脚本按"假如不打折"的最坏情况估。
  2. 试用强度假设：单人（团队=1）每周 5-10 个 AI 调研。
     - 10 个/周 × 4 周 = 40 个/月（与 §十一 验收的"10 个固定 AI 调研样本"对齐）
  3. 月成本 = 单次 × 次数 + 摘要/雷达/导入的零星增量

本脚本是 dry-run，不依赖 DB 或 LLM，可独立运行：
    python scripts/cost_extrapolation.py
"""
from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, asdict


# ---------------------------------------------------------------------------
# 模型公开价（2026-07 已知；脚本可被 env 覆盖）
# ---------------------------------------------------------------------------

# gpt-researcher 0.15.1 的 costs.py 硬编码 GPT-4o list 价格：
DEFAULT_MODEL_RATES = {
    "input_per_1m": 5.00,    # USD per 1M input tokens
    "output_per_1m": 15.00,  # USD per 1M output tokens
}
# Claude Haiku 4.5 / DeepSeek V4 Flash 公开价（保守估计）—— 用于切到非 GPT 主引擎时
ALT_MODEL_RATES = {
    "claude-haiku-4-5": {"input_per_1m": 1.00, "output_per_1m": 5.00},
    "deepseek-v4-flash": {"input_per_1m": 0.14, "output_per_1m": 0.28},
}
# Tavily 搜索（gpt_researcher 实际搜索次数 = visited_urls 长度）
# 公开价：basic 搜索 $0.005/次；advanced $0.01/次。保守用 advanced。
TAVILY_PER_SEARCH_USD = 0.01


# ---------------------------------------------------------------------------
# A/B 对比实测中位数（packages/ai-engine/reports/ab-comparison-...md）
# ---------------------------------------------------------------------------

# gpt-researcher 3 主题实测
GPT_RESEARCHER_OBSERVED = {
    "median_cost_usd": 0.21,        # 3 主题中位
    "min_cost_usd": 0.20,
    "max_cost_usd": 0.43,
    "median_searches": 3,           # 实际 2-3 次
    "min_searches": 2,
    "max_searches": 3,
    "median_tokens_input": 15_000,  # 粗估
    "median_tokens_output": 4_000,  # 粗估
}

# simple-claude-pipeline（已退役主引擎，留作对照）
CLAUDE_PIPELINE_OBSERVED = {
    "median_cost_usd": 0.05,
    "median_searches": 1,
}


# ---------------------------------------------------------------------------
# 试用强度假设
# ---------------------------------------------------------------------------

@dataclass
class TrialUsage:
    users: int
    research_jobs_per_user_per_week: int
    weeks_per_month: int
    chat_messages_per_user_per_day: int   # AI 追问（占 token 极少）
    summaries_per_user_per_day: int      # 每日摘要 LLM 轻量调用
    radar_candidates_per_day: int         # 雷达候选 LLM 蒸馏打分


# 与 §十一 / §十二 对齐的"单人试用"假设
SINGLE_USER_TRIAL = TrialUsage(
    users=1,
    research_jobs_per_user_per_week=10,   # 10 个固定样本 → 10/周
    weeks_per_month=4,
    chat_messages_per_user_per_day=20,
    summaries_per_user_per_day=4,        # 每日 4 条 brief
    radar_candidates_per_day=20,         # 每日 20 候选
)

# 上限假设：5 人 × 10 个/周（取自 §十一 "周有效使用 ≥30%" 的隐含规模）
FIVE_USER_TRIAL = TrialUsage(
    users=5,
    research_jobs_per_user_per_week=10,
    weeks_per_month=4,
    chat_messages_per_user_per_day=20,
    summaries_per_user_per_day=4,
    radar_candidates_per_day=20,
)


# ---------------------------------------------------------------------------
# 蒸馏打分 / 摘要的轻量调用成本估算
# ---------------------------------------------------------------------------

# distilled_scorer 用 deepseek-v4-flash（或同类 fast LLM）打 7 维分；
# 假设每候选 ~600 in + 200 out tokens → 4¢/1M input + 0.28¢/1M output
# （按 deepseek-v4-flash public 价）。
DISTILLED_COST_USD = (
    600 * 0.14 / 1_000_000 + 200 * 0.28 / 1_000_000
)  # ≈ 0.00014 USD

# summary_brief：4 个候选 × 每条 ~400 in + 200 out
SUMMARY_BRIEF_COST_USD = (
    400 * 0.14 / 1_000_000 + 200 * 0.28 / 1_000_000
) * 4  # ≈ 0.000448 USD

# chat 追问：单条 ~1000 in + 500 out（不含检索）
CHAT_MESSAGE_COST_USD = (
    1000 * 0.14 / 1_000_000 + 500 * 0.28 / 1_000_000
)  # ≈ 0.00028 USD


# ---------------------------------------------------------------------------
# 计算函数
# ---------------------------------------------------------------------------

def monthly_research_cost(
    *,
    jobs_per_user_per_week: int,
    users: int,
    weeks: int,
    median_research_usd: float,
) -> dict[str, float]:
    n_jobs = jobs_per_user_per_week * users * weeks
    return {
        "n_jobs": n_jobs,
        "total_usd": round(median_research_usd * n_jobs, 2),
    }


def monthly_auxiliary_cost(usage: TrialUsage) -> dict[str, float]:
    days = usage.weeks_per_month * 7
    chat = usage.users * usage.chat_messages_per_user_per_day * days
    summaries = usage.users * usage.summaries_per_user_per_day * days
    radar = usage.radar_candidates_per_day * days
    return {
        "chat_messages": chat,
        "summaries": summaries,
        "radar_candidates": radar,
        "chat_cost_usd": round(chat * CHAT_MESSAGE_COST_USD, 2),
        "summary_cost_usd": round(summaries * SUMMARY_BRIEF_COST_USD, 2),
        "radar_cost_usd": round(radar * DISTILLED_COST_USD, 2),
        "aux_total_usd": round(
            chat * CHAT_MESSAGE_COST_USD
            + summaries * SUMMARY_BRIEF_COST_USD
            + radar * DISTILLED_COST_USD,
            2,
        ),
    }


def monthly_search_cost(usage: TrialUsage, searches_per_research: int) -> float:
    n_jobs = (
        usage.research_jobs_per_user_per_week
        * usage.users
        * usage.weeks_per_month
    )
    return round(n_jobs * searches_per_research * TAVILY_PER_SEARCH_USD, 2)


def extrapolate(usage: TrialUsage, label: str) -> dict[str, object]:
    research = monthly_research_cost(
        jobs_per_user_per_week=usage.research_jobs_per_user_per_week,
        users=usage.users,
        weeks=usage.weeks_per_month,
        median_research_usd=GPT_RESEARCHER_OBSERVED["median_cost_usd"],
    )
    aux = monthly_auxiliary_cost(usage)
    search = monthly_search_cost(
        usage, GPT_RESEARCHER_OBSERVED["median_searches"]
    )
    total = research["total_usd"] + aux["aux_total_usd"] + search
    return {
        "label": label,
        "usage": asdict(usage),
        "research_cost_usd": research["total_usd"],
        "research_jobs": research["n_jobs"],
        "auxiliary_cost_usd": aux["aux_total_usd"],
        "auxiliary_breakdown": {
            "chat_usd": aux["chat_cost_usd"],
            "summary_usd": aux["summary_cost_usd"],
            "radar_usd": aux["radar_cost_usd"],
        },
        "search_cost_usd": search,
        "monthly_total_usd": round(total, 2),
        "within_200_budget": total <= 200.0,
    }


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def main() -> int:
    results = [
        extrapolate(SINGLE_USER_TRIAL, "single-user trial (team=1)"),
        extrapolate(FIVE_USER_TRIAL, "5-user trial (上限假设)"),
    ]
    print(json.dumps(results, indent=2, ensure_ascii=False))

    print()
    print("=" * 60)
    print("  假设与口径")
    print("=" * 60)
    print(f"  单次 AI 调研 LLM 成本: ${GPT_RESEARCHER_OBSERVED['median_cost_usd']:.2f}")
    print(f"    来源: A/B 实测 (ab-comparison-gpt-researcher-vs-claude.md)")
    print(f"  单次搜索成本: ${TAVILY_PER_SEARCH_USD:.2f} (Tavily advanced)")
    print(f"  distilled_scorer: ${DISTILLED_COST_USD:.5f}/候选")
    print(f"  summary_brief: ${SUMMARY_BRIEF_COST_USD:.5f}/每日")
    print(f"  chat 追问: ${CHAT_MESSAGE_COST_USD:.5f}/消息")
    print()
    print("  备注: 实际 cc-switch proxy 后端不计费到本项目")
    print("        上述为'如果不打折'的最坏情况")
    print()

    # 任何超 $200 的场景都打印警告
    over = [r for r in results if not r["within_200_budget"]]
    if over:
        print("⚠  超预算场景：")
        for r in over:
            print(f"  - {r['label']}: ${r['monthly_total_usd']}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
