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


def test_memo_validation_requires_both_sections() -> None:
    assert is_valid_decision_memo("# 决策备忘\n\n## 建议\n\n## 关键声明\n")
    assert not is_valid_decision_memo("## 建议\n")
    assert not is_valid_decision_memo("")
