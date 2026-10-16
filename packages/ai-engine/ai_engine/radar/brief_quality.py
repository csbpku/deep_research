"""Recognize source-unavailable responses masquerading as long summaries.

This is an absence check, not a semantic quality score. A useful abstract or
an article that discusses missing evidence remains eligible for review.
"""
from __future__ import annotations

import re


def is_unavailable_brief(text: str) -> bool:
    plain = re.sub(r"[*_`#]", "", text).strip()
    opening = plain[:350]
    if re.match(r"^(?:抱歉[，,。\s]*)?(?:无法|不能|未能)(?:生成|提供|撰写)(?:实质性|准确的|中文)?摘要", opening):
        return True
    if re.match(r"^抱歉[，,。\s]*(?:您|你)?提供的.{0,20}不足以.{0,20}摘要", opening):
        return True
    if re.match(r"^(?:sorry[, .]*)?(?:i (?:cannot|can't|am unable to)|unable to|cannot|can't)"
                r".{0,80}(?:summarize|summarise|provide.{0,20}summary)", opening, re.I):
        return True
    if re.search(r"(?:以下摘要仅基于标题|上述描述完全基于标题|据标题推断|仅基于标题内容撰写)", opening):
        return True
    source_absent = re.search(
        r"(?:没有可用的正文|未提供(?:任何)?(?:文档)?正文|没有任何正文|"
        r"(?:缺少|缺乏)(?:文章|原文)?(?:实际)?(?:正文|摘录)|"
        r"原始文章的具体内容并未提供|摘要正文及论文具体内容并未给出|"
        r"未包含(?:该论文)?的?(?:实际)?正文|仅有标题(?:信息|可供参考)|"
        r"仅返回.{0,20}(?:错误|失败)提示)", opening,
    )
    cannot_summarize = re.search(
        r"(?:无法.{0,16}(?:摘要|概述|总结|了解|获知)|不足以.{0,12}摘要|"
        r"(?:建议|请).{0,25}(?:提供|获取|查阅|粘贴).{0,30}(?:正文|原文|PDF))", plain,
    )
    return bool(source_absent and cannot_summarize)
