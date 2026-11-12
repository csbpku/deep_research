from ai_engine.research_summary import derive_research_summary

REPORT = """## 决策摘要

对 20 人团队，暂不能定案。现有证据只支持条件性倾向。

## 研究范围与方法

本轮只读取公开网页与官方文档，未做独立计时实验。

## 取舍与结论

并行执行有直接正文支持 Playwright；CI 成本测算不闭合，调试体验无法判胜负。

## 证据覆盖与未确认项

缺少团队套件规模、浏览器矩阵与 CI 单价；Cypress Cloud 价目未确认。

## 参考文献

[1] Sharding | Playwright
"""


def test_derives_three_publish_fields_from_report_sections():
    fields = derive_research_summary(REPORT)

    assert "公开网页" in fields["background"]
    assert "并行执行" in fields["conclusion"]
    assert "Cypress Cloud" in fields["risks"]
    assert "参考文献" not in fields["conclusion"]


def test_keeps_risks_empty_when_report_has_no_risk_section():
    body = "## 背景\n\n为什么做。\n\n## 结论\n\n可以继续。\n"

    fields = derive_research_summary(body)

    assert fields["background"] == "为什么做。"
    assert fields["conclusion"] == "可以继续。"
    assert fields["risks"] == ""


def test_strips_links_and_emphasis_and_bounds_length():
    body = "## 结论\n\n**重点**：[官方文档](https://example.com/a) 说明该行为。\n" * 200

    fields = derive_research_summary(body)

    assert "https://example.com" not in fields["conclusion"]
    assert "**" not in fields["conclusion"]
    assert len(fields["conclusion"]) <= 1_200


def test_empty_report_yields_empty_fields():
    assert derive_research_summary("   ") == {
        "background": "",
        "conclusion": "",
        "risks": "",
    }


def test_missing_updates_never_overwrite_author_text():
    from ai_engine.research_summary import missing_summary_updates

    updates = missing_summary_updates(
        {"background": "作者写的背景", "conclusion": "  ", "risks": None},
        REPORT,
    )

    assert "background" not in updates
    assert "并行执行" in updates["conclusion"]
    assert "Cypress Cloud" in updates["risks"]
