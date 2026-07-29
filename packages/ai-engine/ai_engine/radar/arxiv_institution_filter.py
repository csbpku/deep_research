"""ArXiv institution allowlist filter.

Filters ArXiv papers by author affiliations, keeping only papers from
top universities, companies, and research labs.
"""

from __future__ import annotations

import logging
import re as _re
from typing import Any

logger = logging.getLogger("arxiv_institution_filter")

# Tier 1: Top universities worldwide
_TIER1_UNIVERSITIES: dict[str, str] = {
    "mit": "MIT",
    "massachusetts institute": "MIT",
    "stanford": "Stanford University",
    "stanford university": "Stanford University",
    "cmu": "Carnegie Mellon University",
    "carnegie mellon": "Carnegie Mellon University",
    "uc berkeley": "UC Berkeley",
    "berkeley": "UC Berkeley",
    "university of california berkeley": "UC Berkeley",
    "oxford": "University of Oxford",
    "university of oxford": "University of Oxford",
    "cambridge": "University of Cambridge",
    "university of cambridge": "University of Cambridge",
    "eth zurich": "ETH Zurich",
    "eth": "ETH Zurich",
    "epfl": "EPFL",
    "caltech": "Caltech",
    "princeton": "Princeton University",
    "harvard": "Harvard University",
    "deepmind": "Google DeepMind",
    "google deepmind": "Google DeepMind",
    "openai": "OpenAI",
}

# Tier 2: Strong universities and research labs
_TIER2_UNIVERSITIES: dict[str, str] = {
    "ucla": "UCLA",
    "uc san diego": "UC San Diego",
    "ucsd": "UC San Diego",
    "uw": "University of Washington",
    "university of washington": "University of Washington",
    "uwa": "University of Washington",
    "columbia": "Columbia University",
    "cornell": "Cornell University",
    "yale": "Yale University",
    "u of t": "University of Toronto",
    "university of toronto": "University of Toronto",
    "waterloo": "University of Waterloo",
    "uiuc": "UIUC",
    "illinois": "UIUC",
    "university of illinois": "UIUC",
    "umich": "University of Michigan",
    "university of michigan": "University of Michigan",
    "gatech": "Georgia Tech",
    "georgia tech": "Georgia Tech",
    "ut austin": "UT Austin",
    "university of texas": "UT Austin",
    "imperial": "Imperial College London",
    "imperial college": "Imperial College London",
    "tsinghua": "Tsinghua University",
    "清华": "Tsinghua University",
    "pku": "Peking University",
    "peking university": "Peking University",
    "北大": "Peking University",
    "sjtu": "Shanghai Jiao Tong University",
    "shanghai jiao tong": "Shanghai Jiao Tong University",
    "zhejiang": "Zhejiang University",
    "university of tokyo": "University of Tokyo",
    "todai": "University of Tokyo",
    "nus": "National University of Singapore",
    "university of melbourne": "University of Melbourne",
    "kaist": "KAIST",
}

# Tier 3: Company research labs
_TIER3_COMPANIES: dict[str, str] = {
    "google": "Google Research",
    "meta": "Meta AI Research",
    "meta ai": "Meta AI Research",
    "microsoft": "Microsoft Research",
    "microsoft research": "Microsoft Research",
    "nvidia": "NVIDIA Research",
    "apple": "Apple ML Research",
    "amazon": "Amazon AWS AI",
    "aws": "Amazon AWS AI",
    "anthropic": "Anthropic",
    "baai": "BAAI / Beijing AI Academy",
    "智源": "BAAI / Beijing AI Academy",
    "deepseek": "DeepSeek",
    "月之暗面": "Moonshot AI",
    "moonshot": "Moonshot AI",
    "kimi": "Moonshot AI",
    "alibaba": "Alibaba DAMO Academy",
    "tencent": "Tencent AI Lab",
    "baidu": "Baidu Research",
    "huawei": "Huawei Noah's Ark",
    "ibm": "IBM Research",
    "intel": "Intel Labs",
    "allen institute": "Allen Institute for AI",
    "ai2": "Allen Institute for AI",
}

# Government / non-profit labs
_TIER4_LABS: dict[str, str] = {
    "cern": "CERN",
    "nasa": "NASA",
    "max planck": "Max Planck Institute",
    "inria": "INRIA",
}

_ALL_ALLOWLIST: dict[str, str] = {}
for d in (_TIER1_UNIVERSITIES, _TIER2_UNIVERSITIES, _TIER3_COMPANIES, _TIER4_LABS):
    _ALL_ALLOWLIST.update(d)

# Pre-compute normalized search keys
_ALLOWLIST_KEYS = sorted(_ALL_ALLOWLIST.keys(), key=len, reverse=True)


def _normalize(text: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace."""
    text = _re.sub(r"[^\w\s]", " ", text)
    text = _re.sub(r"\s+", " ", text).strip().lower()
    return text


def match_institution(raw_affiliation: str) -> str | None:
    """Match a raw affiliation string against the allowlist.

    Returns the canonical institution name, or None if unmatched.
    """
    normalized = _normalize(raw_affiliation)
    if not normalized:
        return None

    # Exact match on full normalized string
    if normalized in _ALL_ALLOWLIST:
        return _ALL_ALLOWLIST[normalized]

    # Substring match: the full text contains any allowlist key
    for key in _ALLOWLIST_KEYS:
        if key in normalized:
            return _ALL_ALLOWLIST[key]

    return None


def filter_papers_by_institution(
    papers: list[dict[str, Any]],
    *,
    keep_tier: int = 3,
) -> list[dict[str, Any]]:
    """Filter ArXiv papers, keeping those whose authors are from allowed institutions.

    Args:
        papers: List of paper dicts from fetch_arxiv(). Each should have an
            ``authors`` key (list of dicts with ``name`` and optional ``affiliation``).
            Falls back to ``snippet`` for backward compatibility.
        keep_tier: Max tier to keep (1=top uni, 2=strong uni, 3=company, 4=labs).
            Default 3 keeps tiers 1-3.

    Returns:
        Filtered papers with an added ``matched_institutions`` key.
    """
    tier_sets = [_TIER1_UNIVERSITIES, _TIER2_UNIVERSITIES, _TIER3_COMPANIES, _TIER4_LABS]

    filtered: list[dict[str, Any]] = []
    for paper in papers:
        authors_data: list[dict[str, str]] = paper.get("authors", [])
        if not authors_data:
            # Paper has no authors -- keep it only if allowlist_keywords in snippet.
            # NOTE: snippet gating was deferred (W5 followup). For now we keep all
            # authorless papers to preserve W4 behavior; revisit when tuning.
            filtered.append(paper)
            continue

        matched_institutions: set[str] = set()
        for author in authors_data:
            affil = author.get("affiliation", "")
            if affil:
                matched = match_institution(affil)
                if matched:
                    matched_institutions.add(matched)

            # Also check author name for common company patterns
            name = author.get("name", "")
            for key in _ALLOWLIST_KEYS:
                if key in name.lower():
                    matched_institutions.add(_ALL_ALLOWLIST[key])

        if not matched_institutions:
            continue

        # Check tier threshold
        max_tier = 99
        for inst in matched_institutions:
            for i, ts in enumerate(tier_sets, 1):
                if inst in ts.values():
                    max_tier = min(max_tier, i)
                    break

        if max_tier <= keep_tier:
            paper["matched_institutions"] = sorted(matched_institutions)
            filtered.append(paper)

    logger.info(
        "arxiv_institution_filter",
        extra={
            "incoming": len(papers),
            "filtered": len(filtered),
            "keep_tier": keep_tier,
        },
    )
    return filtered


__all__ = ["filter_papers_by_institution", "match_institution"]
