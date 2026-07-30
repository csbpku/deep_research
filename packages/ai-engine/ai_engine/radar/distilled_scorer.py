"""Distilled 7-dimension content scoring rubric (v2).

v2 changes vs v1:
- Profiles: weights / thresholds shift per audience (paper / engineering
  / news) via ``ai_engine.scoring.scoring_profiles``. The active profile
  is selected at runtime by ``active_profile()`` and can be overridden
  with the ``SCORING_PROFILE`` env var.
- ``综合信号`` dimension is renamed semantically to "受众匹配度": same
  rubric, same weight per profile, but the prompt now anchors scoring
  against the target audience instead of generic "信号".
- Hard vetoes are split:
    * ``title_content_mismatch`` and ``unsafe_content`` remain hard
      vetoes (score 0, must_read=False, tier=noise).
    * ``security_risk`` is now a *risk flag* on the result — it sets a
      ``has_risk_signal=True`` field and zeros the score / must_read, but
      ``veto`` is left as ``None`` so downstream code can apply policy
      (e.g. require human review before publishing) without the candidate
      being filtered out by the radar ingest path.
    * ``pure_repost`` is now ``suspected_repost``: it caps 信息增量 at 1
      and forces must_read=False, but does not zero other dimensions.
- must_read rule is precise: total >= profile.must_read_total AND
  profile.must_read_core_count of the 3 core dims >= 2.
- Prompt includes profile id, source type, URL domain, published date,
  and the current date so the LLM has temporal context.

Backward compatibility:
- The LLM JSON output can use either the new Chinese key ``综合信号`` or
  the legacy English key ``overall_signal``; both resolve to the
  audience-fit dimension.
- Old Chinese keys (信息增量 / 分析深度 / 可行动性 / 事实可信度 / 时效性
  / 表达质量 / 综合信号) are still supported as input. The
  ``dimension_scores`` dict on the result still uses Chinese keys so
  existing serialization to DB and reasoning blocks is unchanged.
- ``DISTILLED_VERSION`` is bumped to ``"2.0"`` so log readers can detect
  the upgrade.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from collections.abc import Awaitable, Callable
from typing import Any, Protocol
from urllib.parse import urlsplit

from ai_engine.scoring.scoring_profiles import (
    ScoringProfile,
    active_profile,
)

logger = logging.getLogger("ai_engine.radar.distilled_scorer")

DISTILLED_VERSION = "2.0"

# ── 7 Dimensions (fixed; only weights vary per profile) ───────────
#
# Each dimension has: name, description, and a 4-level rubric (0–3).
# Core dimensions (信息增量, 分析深度, 可行动性) are the must_read axis.
#
# In v2, 综合信号 is renamed semantically to 受众匹配度. The LLM is
# instructed to anchor scoring against the active profile's target
# audience. The JSON key remains "综合信号" for prompt simplicity and
# backward compatibility with v1 outputs in logs.

MAX_DIM_SCORE = 3
MAX_TOTAL = 100  # sum of weights, enforced by profile definition


@dataclass(slots=True, frozen=True)
class Dimension:
    name: str
    description: str
    rubric: dict[int, str]


# Rubrics are profile-agnostic — they describe absolute quality, not
# audience-relative quality. Audience fit is captured by the profile
# weight on the 综合信号 dimension itself.
DIMENSIONS: tuple[Dimension, ...] = (
    Dimension(
        name="信息增量",
        description="有没有告诉我一件我不知道的事？",
        rubric={
            0: "通篇是已知信息或常识，读完没有获得任何新认知",
            1: "有少量新信息，但大部分是已有知识的重新表述",
            2: "包含明确的新事实、新数据或新视角，有增量价值",
            3: "揭示了重要但未被广泛讨论的信息，显著扩展认知边界",
        },
    ),
    Dimension(
        name="分析深度",
        description="作者有没有真正想清楚这件事？",
        rubric={
            0: "停留在表面描述，无分析，无因果推理",
            1: "有简单归因或列举，但缺乏逻辑链条和证据支撑",
            2: "有清晰的因果分析，论点有数据或案例支撑",
            3: "深入机制层面，揭示非显然的因果关系，分析经得起推敲",
        },
    ),
    Dimension(
        name="可行动性",
        description="能不能转化为行动？",
        rubric={
            0: "纯信息/观点，无法指导任何具体行动",
            1: "有模糊的方向性建议，但缺乏可执行细节",
            2: "包含具体可执行的步骤或明确的决策建议",
            3: "提供了可直接落地的方案，含步骤、工具、注意事项",
        },
    ),
    Dimension(
        name="事实可信度",
        description="数据和结论靠谱吗？",
        rubric={
            0: "无来源、有明显事实错误或逻辑谬误",
            1: "部分论断缺少来源，但无重大错误",
            2: "关键论断有来源或可验证，结论合理",
            3: "来源权威可追溯，数据准确，结论严谨",
        },
    ),
    Dimension(
        name="时效性",
        description="内容新鲜吗？",
        rubric={
            0: "内容已过时，讨论的问题已有明确结论或已被替代",
            1: "内容不够新，但有历史参考价值",
            2: "内容是近期热点或仍在演进的话题",
            3: "第一时间报道或深度分析最新事件/技术",
        },
    ),
    Dimension(
        name="表达质量",
        description="文章是在认真说清楚一件事，还是在凑字数？",
        rubric={
            0: "大量废话、重复、标题党、或故意模糊。读完不知道作者想说什么。噪音占比>50%",
            1: "结构混乱或有明显注水，但核心观点还能提取出来。需要跳过大量无用内容",
            2: "表达清晰，重点突出，有少量冗余但不影响阅读。核心信息容易获取",
            3: "极度克制高效，每一段都有信息量，没有一句废话。清晰的问题→分析→结论脉络",
        },
    ),
    Dimension(
        name="综合信号",
        description="对 AI/LLM 工程实践者是否有直接参考价值？（受众匹配度）",
        rubric={
            0: "与 AI/LLM 工程无关或只有表面关联。地理、非技术领域、纯商业新闻、其他非 AI 学科内容",
            1: "与 AI 有间接联系但不提供工程层面的可操作信息。纯新闻播报、财务报告、行业趋势",
            2: "对 AI 工程实践有一定参考价值。产品发布、技术选型、架构思路，但缺乏深入的技术方案",
            3: "直接回答 AI 工程实践者当前正在解决的问题。可立即应用于 Agent、LLM 部署、RAG、工具链优化等工作",
        },
    ),
)

DIM_NAMES: tuple[str, ...] = tuple(d.name for d in DIMENSIONS)
_CORE_DIM_INDICES: tuple[int, ...] = (0, 1, 2)  # 信息增量, 分析深度, 可行动性


# ── Legacy key aliases ────────────────────────────────────────────
#
# v1 / cross-system keys that resolve to the same dimension. Used when
# parsing the LLM JSON output so old outputs still work.
_LEGACY_KEY_ALIASES: dict[str, str] = {
    "overall_signal": "综合信号",
    "audience_fit": "综合信号",
    "novelty": "信息增量",
    "depth": "分析深度",
    "actionability": "可行动性",
    "credibility": "事实可信度",
    "timeliness": "时效性",
    "expression": "表达质量",
}


# ── Tier constants ────────────────────────────────────────────────
#
# Per-profile thresholds live on the profile object. The names below are
# kept for backward compatibility with code that imported the v1
# constants (test code, dashboards).

TIER_COLLECTION = "collection"   # profile.tier_collection+
TIER_DEEP_READ = "deep_read"     # profile.tier_deep_read..(collection-1)
TIER_SKIM = "skim"               # profile.tier_skim..(deep_read-1)
TIER_NOISE = "noise"             # below profile.tier_skim


# ── Veto / flag conditions ────────────────────────────────────────
#
# v2 splits the v1 "veto" field into:
#   - ``veto``: hard veto (title_content_mismatch, unsafe_content).
#   - ``risk_flag``: non-veto risk signal (security_risk). Sets
#     ``has_risk_signal=True`` and forces must_read=False, but does not
#     zero the dimension scores.
#   - ``suspected_repost``: pure repost → cap 信息增量 at 1, must_read=
#     False, but do not zero scores.
#
# Old string ``pure_repost`` is still accepted on input and translated
# to ``suspected_repost`` so callers using the v1 name keep working.

VETO_MISMATCH = "title_content_mismatch"
VETO_UNSAFE = "unsafe_content"

RISK_SECURITY = "security_risk"

REPOST_FLAG = "suspected_repost"
_LEGACY_REPOST = "pure_repost"


# ── Result ────────────────────────────────────────────────────────


@dataclass(slots=True, frozen=True)
class DistilledScore:
    """Full Distilled scoring result (v2)."""

    total: float                          # 0–100 weighted score
    tier: str                             # collection / deep_read / skim / noise
    must_read: bool                       # profile.must_read_total + core count
    dimension_scores: dict[str, int]      # Chinese dim name → 0–3
    weak_point: str                       # lowest dimension's deduction reason
    veto: str | None                      # hard veto (title_content_mismatch / unsafe_content)
    risk_flag: str | None                 # soft risk (security_risk)
    suspected_repost: bool                # True if pure_repost was flagged
    has_risk_signal: bool                 # True if any risk_flag is set
    profile_id: str                       # id of the active profile
    is_default: bool                      # True if LLM scoring was skipped/fallback
    version: str = DISTILLED_VERSION

    @property
    def risk_flags(self) -> tuple[str, ...]:
        flags: list[str] = []
        if self.risk_flag == RISK_SECURITY:
            flags.append("security_review_required")
        if self.suspected_repost:
            flags.append(REPOST_FLAG)
        return tuple(flags)

    @property
    def profile(self) -> str:
        return self.profile_id

    def to_dict(self) -> dict[str, Any]:
        return {
            "total": self.total,
            "tier": self.tier,
            "mustRead": self.must_read,
            "dimensions": {
                SERIAL_KEYS[name]: value
                for name, value in self.dimension_scores.items()
            },
            "weakPoint": self.weak_point,
            "veto": self.veto,
            "riskFlags": list(self.risk_flags),
            "profile": self.profile_id,
            "isDefault": self.is_default,
            "version": self.version,
        }


# ── Stable English serialization keys ─────────────────────────────
#
# Used by the LLM prompt and by ``compute_score`` output consumers that
# prefer English. The Chinese keys remain canonical for the JSON
# contract with the LLM (it scores 0–3 in Chinese-named fields).

SERIAL_KEYS: dict[str, str] = {
    "信息增量": "info_increment",
    "分析深度": "analysis_depth",
    "可行动性": "actionability",
    "事实可信度": "fact_credibility",
    "时效性": "timeliness",
    "表达质量": "expression_quality",
    "综合信号": "audience_fit",
}
SERIAL_KEY_TO_CN: dict[str, str] = {v: k for k, v in SERIAL_KEYS.items()}


# ── LLM scoring ───────────────────────────────────────────────────


SYSTEM_PROMPT = """你是一名严苛的评审员，为一个面向 AI 工程师的雷达筛选文章。

受众画像：
- 主要工作：构建 LLM 应用、Agent 系统、RAG、AI 工具链
- 不需要：纯商业新闻、非 AI 学科（地理/金融/体育/医疗）、纯营销稿

前置过滤规则（优先级最高）：
1. 文章是否与 AI/LLM/Agent 工程实践直接相关？如果答案是"否"，受众匹配度必须为 0-1 分
2. 纯财务报告、行业融资新闻、非 AI 技术工具（如 docker/nginx/linux 低层）→ 受众匹配度 0
3. API 工具、AI 框架、模型部署、Agent 设计模式、RAG 管线等 → 正常评分

评分纪律：
- 受众匹配度低于 1.5 的文章，即便其他维度很高（如信息增量 3/分析深度 3），也说明
  它不属于本平台，请在 weak_point 中明确说明原因
- 不要假定所有含"AI/neural"字眼的项目都面向 AI 工程师
- 如果你的评分结果里超过 30% 的文章在 3 个以上维度得到 2 分或以上，说明你的标准太松了"""


def _build_rubric_text(profile: ScoringProfile) -> str:
    """Render the rubric block with per-profile weights."""
    lines: list[str] = []
    for d in DIMENSIONS:
        w = profile.weights[d.name]
        lines.append(f"\n### {d.name}（权重 {w}，{d.description}）")
        for score in range(4):
            lines.append(f"  {score}分: {d.rubric[score]}")
    return "\n".join(lines)


def _build_veto_text() -> str:
    """Veto / risk / repost rules.

    v2 distinction:
      - Hard vetoes (``title_content_mismatch``, ``unsafe_content``)
        zero the score and force must_read=False.
      - Risk flag (``security_risk``) sets has_risk_signal=True and
        forces must_read=False but does not zero the score.
      - Repost flag (``suspected_repost``) caps 信息增量 at 1 and
        forces must_read=False but does not zero the score.
    """
    return """
## 三类信号（按严重程度）
1. **硬否决**（任一命中则所有维度记 0 分）：
   - `title_content_mismatch`：标题与内容严重不符，标题党
   - `unsafe_content`：明确鼓励违法、伤害、歧视或其他违反公共安全的内容
2. **风险标记**（不否决但 must_read=false，并标 risk_flag）：
   - `security_risk`：涉及安全漏洞利用、攻击教程、恶意代码分发。仍可能有分析价值，但不应被高优先级推送
3. **疑似搬运标记**（不否决但必须把 信息增量 限制在 1 分以下，must_read=false）：
   - `suspected_repost`：纯搬运/转载，逐字复制他人内容且无任何增量。注意：原创项目的 README、awesome-list 策展列表、聚合了多个资源并提供使用说明的内容不算 repost——它们有原创的组织和行动指引增量，应正常评分
""".strip()


def _format_meta_block(
    *,
    profile: ScoringProfile,
    source_type: str | None,
    url: str | None,
    published_at: datetime | None,
    current_date: datetime | None,
) -> str:
    """Format the contextual meta block (profile / source / domain /
    published / current date) for the prompt."""
    lines: list[str] = []
    lines.append(f"- 当前评分画像 (profile): {profile.id}")
    lines.append(f"- 画像说明: {profile.description}")
    if source_type:
        lines.append(f"- 来源类型 (source_type): {source_type}")
    if url:
        host = (urlsplit(url).hostname or "").lower()
        if host:
            lines.append(f"- 站点域名 (domain): {host}")
    if published_at is not None:
        try:
            ts = published_at.astimezone(timezone.utc)
            lines.append(f"- 文章发布时间 (published_at): {ts.strftime('%Y-%m-%d')}")
        except Exception:
            lines.append(f"- 文章发布时间 (published_at): {str(published_at)[:10]}")
    else:
        lines.append("- 文章发布时间 (published_at): 未知")
    if current_date is None:
        current_date = datetime.now(timezone.utc)
    lines.append(f"- 当前日期 (current_date): {current_date.strftime('%Y-%m-%d')}")
    return "\n".join(lines)


# v1 fallback: keep build_user_prompt(title, content) callable for
# existing callers / tests.
def build_user_prompt(
    title: str,
    content: str,
    *,
    profile: ScoringProfile | None = None,
    source_type: str | None = None,
    url: str | None = None,
    published_at: datetime | None = None,
    current_date: datetime | None = None,
) -> str:
    """Build the user message for the LLM scoring call.

    v2 adds contextual meta (profile / source_type / domain /
    published_at / current_date). Old calls that pass only title +
    content still work — meta fields default to None and only the
    profile line appears in the prompt.
    """
    profile = profile or active_profile()
    meta_block = _format_meta_block(
        profile=profile,
        source_type=source_type,
        url=url,
        published_at=published_at,
        current_date=current_date,
    )
    return f"""请对以下文章进行 7 个维度的评分（每个维度 0–3 分）。

## 评分画像上下文
{meta_block}

## 评分维度与锚点
{_build_rubric_text(profile)}

## 评分纪律
- 每个维度独立评估，对照绝对标准，不参考批内其他文章
- weak_point 只写最低维度的具体扣分原因，一句话，不超过 30 字
- 不要解释高分，只解释最低分
- "综合信号" 这一维度的评判基准是上面评分画像的目标读者，而不是泛化的"信号"

{_build_veto_text()}

## 文章内容
标题: {title}

正文（截取）:
{content[:8000]}

## 输出格式（严格 JSON，不要 markdown 代码块）
{{
  "信息增量": 0,
  "分析深度": 0,
  "可行动性": 0,
  "事实可信度": 0,
  "时效性": 0,
  "表达质量": 0,
  "综合信号": 0,
  "weak_point": "最低维度扣分原因",
  "veto": null,
  "risk_flag": null,
  "suspected_repost": false
}}

判定规则：
- 硬否决命中：`veto` 填 `"title_content_mismatch"` 或 `"unsafe_content"`，`risk_flag=null`，`suspected_repost=false`，所有维度填 0
- 风险标记命中：`risk_flag` 填 `"security_risk"`，`veto=null`，`suspected_repost=false`，其它维度正常评分
- 疑似搬运命中：`suspected_repost=true`，`veto=null`，`risk_flag=null`，其它维度正常评分（信息增量会在后处理中限制到 ≤ 1）"""


# ── LLM caller protocol ───────────────────────────────────────────


class DimensionScorer(Protocol):
    """Callable that sends prompt context to LLM and returns raw JSON string."""

    async def __call__(self, title: str, content: str) -> str:
        ...


# ── Anthropic implementation ───────────────────────────────────────


async def anthropic_scorer(
    title: str,
    content: str,
    *,
    profile: ScoringProfile | None = None,
    source_type: str | None = None,
    url: str | None = None,
    published_at: datetime | None = None,
) -> str:
    """Call Anthropic API to score article dimensions. Returns raw JSON string.

    Passes profile / source_type / url / published_at to the prompt so
    the LLM has temporal and source context for accurate scoring.
    """
    from anthropic import AsyncAnthropic

    light_key = os.environ.get("ANTHROPIC_API_KEY", "")
    light_url = os.environ.get("ANTHROPIC_BASE_URL")
    api_key = light_key or os.environ.get("ANTHROPIC_API_KEY_HEAVY", "")
    base_url = light_url or os.environ.get("ANTHROPIC_BASE_URL_HEAVY")
    client = AsyncAnthropic(
        api_key=api_key,
        base_url=base_url,
    )
    llm_spec = (
        os.environ.get("BRIEF_LLM")
        or os.environ.get("SMART_LLM")
        or "anthropic:claude-haiku-4-5"
    )
    _, _, model_name = llm_spec.partition(":")

    message = await client.messages.create(
        model=model_name,
        max_tokens=1024,
        timeout=60.0,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": build_user_prompt(
            title, content,
            profile=profile,
            source_type=source_type,
            url=url,
            published_at=published_at,
        )}],
    )
    parts = [
        block.text
        for block in message.content
        if getattr(block, "type", None) == "text" and hasattr(block, "text")
    ]
    return "".join(parts)


# ── Default (no-LLM) scorer ────────────────────────────────────────


async def default_scorer(title: str, content: str) -> str:
    """Return all-zero scores for CI/no-API-key environments."""
    return json.dumps({
        name: 0 for name in DIM_NAMES
    } | {
        "weak_point": "default fallback (no LLM)",
        "veto": None,
        "risk_flag": None,
        "suspected_repost": False,
    })


# ── Score computation ──────────────────────────────────────────────


def _normalize_dim_key(raw_key: str) -> str | None:
    """Map any of {canonical Chinese key, legacy Chinese key, English
    alias} to the canonical Chinese key. Returns None if unknown."""
    if raw_key in DIM_NAMES:
        return raw_key
    if raw_key in _LEGACY_KEY_ALIASES:
        return _LEGACY_KEY_ALIASES[raw_key]
    # Try the reverse: English serial key → Chinese
    if raw_key in SERIAL_KEY_TO_CN:
        return SERIAL_KEY_TO_CN[raw_key]
    return None


def _coerce_bool(value: Any) -> bool:
    """Robustly coerce an LLM-provided boolean-like value."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "yes"}
    return bool(value)


def _parse_llm_response(raw: str) -> dict[str, Any]:
    """Parse LLM JSON response, stripping markdown fences if present."""
    text = raw.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        lines = [ln for ln in lines if not ln.strip().startswith("```")]
        text = "\n".join(lines).strip()
    result: dict[str, Any] = json.loads(text)
    return result


def _tier_for_score(total: float, profile: ScoringProfile) -> str:
    if total >= profile.tier_collection:
        return TIER_COLLECTION
    if total >= profile.tier_deep_read:
        return TIER_DEEP_READ
    if total >= profile.tier_skim:
        return TIER_SKIM
    return TIER_NOISE


def _normalize_repost_flag(parsed: dict[str, Any]) -> bool:
    """Detect repost flag. Accepts:
      - ``suspected_repost`` (v2 canonical, bool)
      - ``pure_repost`` (v1 legacy bool / string)
      - legacy ``veto == "pure_repost"`` / ``"suspected_repost"`` strings
    """
    if _coerce_bool(parsed.get("suspected_repost", False)):
        return True
    if _coerce_bool(parsed.get("pure_repost", False)):
        return True
    legacy = parsed.get("veto")
    if legacy in {REPOST_FLAG, _LEGACY_REPOST}:
        return True
    return False


def _normalize_risk_flag(parsed: dict[str, Any]) -> str | None:
    """Detect risk flag. Accepts ``risk_flag`` (v2) or legacy veto
    values ``security_risk``. Returns one of {None, RISK_SECURITY}."""
    flag = parsed.get("risk_flag")
    if isinstance(flag, str) and flag.strip():
        # Map any "security_risk"-shaped value to the canonical id.
        candidate = flag.strip().lower()
        if candidate in {RISK_SECURITY, "security", "security-risk", "security_risk"}:
            return RISK_SECURITY
        # Unknown risk flag values are surfaced as-is so future flags
        # can pass through without breaking the parser.
        return candidate
    # Legacy fallback: veto=="security_risk" → migrate to risk_flag.
    legacy_veto = parsed.get("veto")
    if isinstance(legacy_veto, str) and legacy_veto.strip().lower() == RISK_SECURITY:
        return RISK_SECURITY
    return None


def _normalize_hard_veto(parsed: dict[str, Any]) -> str | None:
    """Detect hard veto. Accepts:
      - ``veto == "title_content_mismatch"`` or ``"unsafe_content"``
      - v2 also adds a ``hard_veto`` field for explicit clarity.
    Returns one of {None, VETO_MISMATCH, VETO_UNSAFE}.
    """
    explicit = parsed.get("hard_veto")
    if isinstance(explicit, str) and explicit.strip():
        candidate = explicit.strip()
        if candidate in {VETO_MISMATCH, VETO_UNSAFE}:
            return candidate

    legacy = parsed.get("veto")
    if isinstance(legacy, str) and legacy.strip():
        candidate = legacy.strip()
        if candidate in {VETO_MISMATCH, VETO_UNSAFE}:
            return candidate
    return None


def compute_score(
    parsed: dict[str, Any],
    *,
    profile: ScoringProfile | None = None,
) -> DistilledScore:
    """Compute weighted score from parsed LLM dimension scores.

    v2 changes:
    - Accepts a profile argument (defaults to active_profile()).
    - Hard veto = title_content_mismatch / unsafe_content → score 0,
      tier=noise, must_read=False, veto set.
    - Risk flag (security_risk) → does NOT zero scores, but sets
      risk_flag / has_risk_signal and forces must_read=False.
    - Suspected repost → does NOT zero scores, but caps 信息增量 at 1
      and forces must_read=False.
    - must_read rule is precise: total >= profile.must_read_total AND
      profile.must_read_core_count of the 3 core dims >= 2.
    """
    profile = profile or active_profile()
    risk_flag = _normalize_risk_flag(parsed)
    repost_flag = _normalize_repost_flag(parsed)
    hard_veto = _normalize_hard_veto(parsed)

    if hard_veto is not None:
        veto_scores: dict[str, int] = {d.name: 0 for d in DIMENSIONS}
        return DistilledScore(
            total=0.0,
            tier=TIER_NOISE,
            must_read=False,
            dimension_scores=veto_scores,
            weak_point=str(hard_veto),
            veto=str(hard_veto),
            risk_flag=None,
            suspected_repost=False,
            has_risk_signal=False,
            profile_id=profile.id,
            is_default=False,
        )

    # Build dimension scores with key normalization + clamping.
    dim_scores: dict[str, int] = {d.name: 0 for d in DIMENSIONS}
    for raw_key, raw_val in parsed.items():
        canonical = _normalize_dim_key(str(raw_key))
        if canonical is None:
            continue
        try:
            val = int(raw_val)
        except (ValueError, TypeError):
            val = 0
        dim_scores[canonical] = max(0, min(MAX_DIM_SCORE, val))

    # Repost cap: 信息增量 ≤ 1.
    if repost_flag and dim_scores["信息增量"] > 1:
        dim_scores["信息增量"] = 1

    # Weighted total using profile weights.
    total = sum(
        dim_scores[d.name] * profile.weights[d.name] / MAX_DIM_SCORE
        for d in DIMENSIONS
    )
    total = round(total, 2)

    # must_read: total >= profile.must_read_total AND ≥ core_count of
    # 3 core dims ≥ 2.
    core_names = tuple(DIMENSIONS[i].name for i in _CORE_DIM_INDICES)
    core_high = sum(1 for n in core_names if dim_scores[n] >= 2)
    must_read = (
        total >= profile.must_read_total
        and core_high >= profile.must_read_core_count
        and not repost_flag
        and risk_flag is None
    )

    # ── Audience-fit safety net ─────────────────────────────────────
    # If the LLM rates an article highly on other dimensions but gave
    # it a low audience-fit score (≤ 1), the content is off-topic for
    # this platform. We cap the tier (no collection / deep_read) and
    # suppress must_read so these articles don't crowd out on-topic
    # candidates. The raw total is preserved for audit.
    audience_fit = dim_scores.get("综合信号", 0)
    capped_by_audience = audience_fit <= 1
    effective_total = total if not capped_by_audience else min(total, 60.0)
    effective_must_read = must_read and not capped_by_audience

    weak_point = str(parsed.get("weak_point", ""))[:100]
    if not weak_point:
        min_name = min(dim_scores, key=lambda k: dim_scores[k])
        weak_point = f"{min_name}={dim_scores[min_name]}分"

    return DistilledScore(
        total=total,
        tier=_tier_for_score(effective_total, profile),
        must_read=effective_must_read,
        dimension_scores=dim_scores,
        weak_point=weak_point,
        veto=None,
        risk_flag=risk_flag,
        suspected_repost=repost_flag,
        has_risk_signal=(risk_flag is not None),
        profile_id=profile.id,
        is_default=False,
    )


def default_score(profile: ScoringProfile | None = None) -> DistilledScore:
    """Return a default (all-zero) DistilledScore for fallback/no-LLM path."""
    profile = profile or active_profile()
    return DistilledScore(
        total=0.0,
        tier=TIER_NOISE,
        must_read=False,
        dimension_scores={d.name: 0 for d in DIMENSIONS},
        weak_point="default fallback (no LLM)",
        veto=None,
        risk_flag=None,
        suspected_repost=False,
        has_risk_signal=False,
        profile_id=profile.id,
        is_default=True,
    )


_LLM_MAX_RETRIES = 2
_LLM_RETRY_DELAY = 3.0


async def score_with_llm(
    title: str,
    content: str,
    *,
    scorer: DimensionScorer | None = None,
    profile: ScoringProfile | None = None,
    source_type: str | None = None,
    url: str | None = None,
    published_at: datetime | None = None,
) -> DistilledScore:
    """Score an article using the LLM dimension scorer.

    Passes source_type / url / published_at to the LLM prompt so the
    scorer has temporal and source context.

    Retries up to _LLM_MAX_RETRIES times on failure, with _LLM_RETRY_DELAY
    seconds between attempts. Falls back to default_score() only if all
    retries are exhausted.
    """
    profile = profile or active_profile()
    if scorer is None:
        if not os.environ.get("ANTHROPIC_API_KEY"):
            logger.debug("distilled_scorer.fallback: no ANTHROPIC_API_KEY")
            return default_score(profile)
        # Use anthropic_scorer with full context
        async def _contextual_scorer(t: str, c: str) -> str:
            return await anthropic_scorer(
                t, c,
                profile=profile,
                source_type=source_type,
                url=url,
                published_at=published_at,
            )
        active_scorer: Callable[[str, str], Awaitable[str]] = _contextual_scorer
    else:
        active_scorer = scorer

    for attempt in range(_LLM_MAX_RETRIES + 1):
        try:
            raw = await active_scorer(title, content)
            parsed = _parse_llm_response(raw)
            return compute_score(parsed, profile=profile)
        except Exception as exc:
            if attempt < _LLM_MAX_RETRIES:
                logger.info(
                    "distilled_scorer.retry",
                    extra={"attempt": attempt + 1, "error_type": type(exc).__name__},
                )
                await asyncio.sleep(_LLM_RETRY_DELAY)
            else:
                logger.warning(
                    "distilled_scorer.fallback",
                    extra={
                        "error_type": type(exc).__name__,
                        "error": str(exc)[:200],
                        "attempts": attempt + 1,
                    },
                )
    return default_score(profile)


# ── Monitoring helpers ────────────────────────────────────────────


@dataclass(slots=True)
class ScoringMonitor:
    """Tracks scoring quality across a batch for alert evaluation.

    v2: adds ``risk_count`` and ``repost_count`` so dashboards can split
    these signals from hard vetos.
    """
    total_count: int = 0
    default_count: int = 0
    must_read_count: int = 0
    risk_count: int = 0
    repost_count: int = 0
    scores: list[float] = field(default_factory=list)

    def record(self, score: DistilledScore) -> None:
        self.total_count += 1
        if score.is_default:
            self.default_count += 1
        if score.must_read:
            self.must_read_count += 1
        if score.has_risk_signal:
            self.risk_count += 1
        if score.suspected_repost:
            self.repost_count += 1
        self.scores.append(score.total)

    @property
    def default_rate(self) -> float:
        if self.total_count == 0:
            return 0.0
        return self.default_count / self.total_count

    @property
    def must_read_rate(self) -> float:
        if self.total_count == 0:
            return 0.0
        return self.must_read_count / self.total_count

    @property
    def risk_rate(self) -> float:
        if self.total_count == 0:
            return 0.0
        return self.risk_count / self.total_count

    @property
    def repost_rate(self) -> float:
        if self.total_count == 0:
            return 0.0
        return self.repost_count / self.total_count

    @property
    def daily_avg(self) -> float:
        if not self.scores:
            return 0.0
        return sum(self.scores) / len(self.scores)

    def evaluate(
        self,
        *,
        baseline_daily_avg: float | None = None,
        baseline_must_read_rate: float | None = None,
    ) -> list[str]:
        """Return list of alert messages (empty if all healthy)."""
        alerts: list[str] = []
        if self.total_count == 0:
            return alerts

        if self.default_rate > 0.15:
            alerts.append(
                f"default_rate {self.default_rate:.1%} > 15% threshold"
            )
        if baseline_daily_avg is not None:
            drop = baseline_daily_avg - self.daily_avg
            if drop > 12:
                alerts.append(
                    f"daily_avg {self.daily_avg:.1f} dropped {drop:.1f} "
                    f"from baseline {baseline_daily_avg:.1f}"
                )
        if baseline_must_read_rate is not None:
            if self.must_read_rate < baseline_must_read_rate * 0.75:
                alerts.append(
                    f"must_read_rate {self.must_read_rate:.1%} < 75% of "
                    f"baseline {baseline_must_read_rate:.1%}"
                )
        # New v2 alert: too many risk-flagged items.
        if self.risk_rate > 0.10:
            alerts.append(
                f"risk_rate {self.risk_rate:.1%} > 10% threshold — "
                f"many candidates flagged security_risk"
            )
        return alerts


__all__ = [
    "DIMENSIONS",
    "DIM_NAMES",
    "DISTILLED_VERSION",
    "DistilledScore",
    "DimensionScorer",
    "REPOST_FLAG",
    "RISK_SECURITY",
    "SERIAL_KEYS",
    "SERIAL_KEY_TO_CN",
    "ScoringMonitor",
    "SYSTEM_PROMPT",
    "TIER_COLLECTION",
    "TIER_DEEP_READ",
    "TIER_NOISE",
    "TIER_SKIM",
    "VETO_MISMATCH",
    "VETO_UNSAFE",
    "build_user_prompt",
    "compute_score",
    "default_score",
    "default_scorer",
    "score_with_llm",
]