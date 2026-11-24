"""Web briefs must stay one page even when the writer ignores the budget."""

from __future__ import annotations

import pytest

from ai_engine import web_brief


def _brief(padding: str = "") -> str:
    return (
        "# 网页简报\n\n"
        f"## 决策摘要\n结论。{padding}\n\n"
        "## 关键发现\n- 事实 [S1]\n\n"
        "## 风险与限制\n- 风险\n\n"
        "## 下一步行动\n- 验证\n\n"
        "## 结构化推荐\n- 采用：先试点\n"
    )


def test_valid_web_brief_requires_the_section_order() -> None:
    assert web_brief.is_valid_web_brief(_brief())
    assert not web_brief.is_valid_web_brief("## 结构化推荐\n- x\n## 决策摘要\n")


@pytest.mark.asyncio
async def test_short_brief_is_returned_without_another_model_call(monkeypatch) -> None:
    async def fail(**_kwargs):  # pragma: no cover - must not run
        raise AssertionError("compression should not run for a short brief")

    monkeypatch.setattr(web_brief, "generate_text", fail)

    result = await web_brief.condense_web_brief(
        report=_brief(),
        request_id="r1",
        llm_spec="fake:model",
    )

    assert result == _brief()


@pytest.mark.asyncio
async def test_long_brief_is_replaced_with_a_shorter_valid_brief(monkeypatch) -> None:
    long_report = _brief("很长的背景说明。" * 300)
    compressed = _brief("精简后的摘要。" * 20)

    class _Result:
        text = compressed
        truncated = False

    async def fake_generate_text(**_kwargs):
        return _Result()

    monkeypatch.setattr(web_brief, "generate_text", fake_generate_text)

    result = await web_brief.condense_web_brief(
        report=long_report,
        request_id="r2",
        llm_spec="fake:model",
    )

    assert result == compressed.strip()
    assert web_brief.memo_readable_chars(result) <= web_brief.WEB_BRIEF_MAX_CHARS


def test_budget_trim_keeps_headings_and_recommendation() -> None:
    long_brief = (
        "# 网页简报\n\n"
        "## 决策摘要\n" + "背景。" * 400 + "\n\n"
        "## 关键发现\n- 事实 [S1]\n- 事实二\n\n"
        "## 风险与限制\n- 风险\n\n"
        "## 下一步行动\n- 验证\n\n"
        "## 结构化推荐\n- 采用：先试点\n- 不建议：全量迁移\n"
    )

    trimmed = web_brief.enforce_web_brief_budget(long_brief)

    assert web_brief.memo_readable_chars(trimmed) <= web_brief.WEB_BRIEF_MAX_CHARS
    for heading in web_brief._REQUIRED_HEADINGS:
        assert heading in trimmed
    assert "先试点" in trimmed
