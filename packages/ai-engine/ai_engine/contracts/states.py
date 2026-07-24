"""Business state enums mirror.

Single source of truth: `docs/contracts/state-machines.md` and
`packages/shared/src/states.ts`.
"""

from __future__ import annotations

from typing import Final, Literal

# ai_research_jobs.status — see docs/contracts/state-machines.md §1
AI_JOB_STATUS: Final[dict[str, str]] = {
    "QUEUED": "queued",
    "RUNNING": "running",
    "PARTIAL": "partial",
    "SUCCEEDED": "succeeded",
    "FAILED": "failed",
    "CANCELLED": "cancelled",
}
AiJobStatus = Literal["queued", "running", "partial", "succeeded", "failed", "cancelled"]

# ai_research_jobs.current_step — see docs/contracts/state-machines.md §2
AI_JOB_STEP: Final[dict[str, str]] = {
    "PLAN": "plan",
    "SEARCH": "search",
    "COMPRESS": "compress",
    "ANALYZE": "analyze",
    "WRITE": "write",
}
AiJobStep = Literal["plan", "search", "compress", "analyze", "write"]
# `current_step` always points to the LAST step that COMPLETED — see §2.
AI_JOB_STEP_ORDER: Final[tuple[AiJobStep, ...]] = (
    "plan",
    "search",
    "compress",
    "analyze",
    "write",
)

# content_import_jobs.status — see docs/contracts/state-machines.md §3
IMPORT_STATUS: Final[dict[str, str]] = {
    "QUEUED": "queued",
    "RUNNING": "running",
    "SUCCEEDED": "succeeded",
    "FAILED": "failed",
    "CANCELLED": "cancelled",
}
ImportStatus = Literal["queued", "running", "succeeded", "failed", "cancelled"]

# content_import_jobs.sourceKind — see docs/contracts/state-machines.md §11
IMPORT_SOURCE_KIND: Final[dict[str, str]] = {
    "FILE": "file",
    "CONFLUENCE": "confluence",
}
ImportSourceKind = Literal["file", "confluence"]

# summaries.status — see docs/contracts/state-machines.md §4
SUMMARY_STATUS: Final[dict[str, str]] = {
    "CANDIDATE": "candidate",
    "PENDING_REVIEW": "pending_review",
    "PUBLISHED": "published",
    "REJECTED": "rejected",
    "ARCHIVED": "archived",
}
SummaryStatus = Literal["candidate", "pending_review", "published", "rejected", "archived"]

# researches.status — see docs/contracts/state-machines.md §5
RESEARCH_STATUS: Final[dict[str, str]] = {
    "DRAFT": "draft",
    "PUBLISHED": "published",
    "ARCHIVED": "archived",
}
ResearchStatus = Literal["draft", "published", "archived"]

# researches.type
RESEARCH_TYPE: Final[dict[str, str]] = {
    "RESEARCH": "research",
    "KNOWLEDGE": "knowledge",
}
ResearchType = Literal["research", "knowledge"]

# researches.creation_method — see §7
CREATION_METHOD: Final[dict[str, str]] = {
    "MANUAL": "manual",
    "AI_RESEARCH": "ai_research",
    "FILE_IMPORT": "file_import",
    "CONFLUENCE_IMPORT": "confluence_import",
}
CreationMethod = Literal["manual", "ai_research", "file_import", "confluence_import"]

# comments.promote_status — see §8
PROMOTE_STATUS: Final[dict[str, str]] = {
    "NONE": "none",
    "NOMINATED": "nominated",
    "APPROVED": "approved",
    "REJECTED": "rejected",
}
PromoteStatus = Literal["none", "nominated", "approved", "rejected"]

# Source policy — see §9
SOURCE_POLICY: Final[dict[str, str]] = {
    "PREFER_USER_SOURCES": "prefer_user_sources",
    "ONLY_USER_SOURCES": "only_user_sources",
}
SourcePolicy = Literal["prefer_user_sources", "only_user_sources"]

# User role — see §10
USER_ROLE: Final[dict[str, str]] = {
    "MEMBER": "member",
    "ADMIN": "admin",
}
UserRole = Literal["member", "admin"]

# Week 6: AI 多轮追问会话状态（架构 §六点一）
AI_CHAT_SESSION_STATUS: Final[dict[str, str]] = {
    "ACTIVE": "active",
    "CLOSED": "closed",
}
AiChatSessionStatus = Literal["active", "closed"]

# Week 6: AI 多轮追问消息角色
AI_CHAT_ROLE: Final[dict[str, str]] = {
    "USER": "user",
    "ASSISTANT": "assistant",
}
AiChatRole = Literal["user", "assistant"]

# AI research job `reportType` (DB column is VarChar(40)). The contract uses
# these two values only — see docs/contracts/api-schemas.md and state-machines.md.
REPORT_TYPE: Final[dict[str, str]] = {
    "RESEARCH_REPORT": "research_report",
    "SUMMARY_BRIEF": "summary_brief",
}
ReportType = Literal["research_report", "summary_brief"]

# Helpers for partial-job rule (架构 §九 风险 10 / state-machines §1):
# mid-failure with at least 3 sources → partial; otherwise failed.
PARTIAL_MIN_SOURCES: Final[int] = 3