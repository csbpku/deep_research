import pytest

from ai_engine.decision_memo import build_decision_memo_prompt, is_valid_decision_memo


def test_memo_prompt_keeps_topic_sources_and_contract() -> None:
    prompt = build_decision_memo_prompt(
        "选 Playwright 还是 Cypress",
        "报告正文 [S1]",
        [{"title": "Playwright docs", "url": "https://playwright.dev"}],
    )
    assert "## 建议" in prompt
    assert "## 关键声明" in prompt
    assert "[S1] Playwright docs" in prompt
    assert "选 Playwright 还是 Cypress" in prompt
    assert "报告正文 [S1]" in prompt


def test_memo_prompt_without_sources_is_explicit() -> None:
    prompt = build_decision_memo_prompt("问题", "正文", [])
    assert "本轮没有可引用来源" in prompt


def test_memo_validation_requires_complete_nonempty_sections() -> None:
    assert is_valid_decision_memo(
        "# 决策备忘\n\n## 问题\n选择工具。\n\n## 建议\n暂不能定案。\n\n"
        "## 关键声明\n成本未确认。\n\n## 风险与未确认\n缺少实测。\n\n"
        "## 下一步验证\n运行团队测试套件。\n"
    )
    assert not is_valid_decision_memo("# 决策备忘\n\n## 建议\n\n## 关键声明\n")
    assert not is_valid_decision_memo("## 建议\n")
    assert not is_valid_decision_memo("")


def test_memo_strips_bibliography_and_keeps_report_tail() -> None:
    from ai_engine.decision_memo import (
        MEMO_MAX_SOURCE_CHARS,
        build_decision_memo_prompt,
        strip_reference_section,
    )

    memo = "# 决策备忘\n\n## 下一步验证\n\n做实验。\n\n## 参考文献\n\n1. [x](https://x)"
    assert strip_reference_section(memo).endswith("做实验。")

    report = "HEAD\n" + ("A" * (MEMO_MAX_SOURCE_CHARS + 100)) + "\nTAIL-CONCLUSION"
    prompt = build_decision_memo_prompt("问题", report, [])
    assert "HEAD" in prompt
    assert "TAIL-CONCLUSION" in prompt


@pytest.mark.asyncio
async def test_oversized_memo_gets_one_shortening_pass(monkeypatch: pytest.MonkeyPatch) -> None:
    from types import SimpleNamespace

    import ai_engine.decision_memo as memo_module

    long_body = "这是一段需要压缩的说明。" * 160
    long_memo = (
        "# 决策备忘\n\n## 问题\n" + long_body + "\n\n## 建议\n" + long_body
        + "\n\n## 关键声明\n" + long_body + "\n\n## 风险与未确认\n" + long_body
        + "\n\n## 下一步验证\n" + long_body
    )
    short_memo = (
        "# 决策备忘\n\n## 问题\n选择工具。\n\n## 建议\n暂不能定案。\n\n"
        "## 关键声明\n成本未确认。\n\n## 风险与未确认\n缺少实测。\n\n"
        "## 下一步验证\n运行测试。\n"
    )
    calls: list[str] = []

    async def fake_generate(**kwargs: object) -> SimpleNamespace:
        calls.append(str(kwargs["user_prompt"]))
        text = short_memo if "待压缩的备忘" in str(kwargs["user_prompt"]) else long_memo
        return SimpleNamespace(text=text, truncated=False)

    monkeypatch.setattr(memo_module, "generate_text", fake_generate)
    result = await memo_module.condense_to_decision_memo(
        topic="问题",
        report="正文",
        sources=[],
        request_id="req-1",
        llm_spec="fake:model",
    )

    assert result == short_memo.strip()
    assert len(calls) == 2
