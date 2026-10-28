import re

from ai_engine.contracts.artifacts import render_artifact_content


def test_render_slide_deck_preserves_report_sections() -> None:
    deck = render_artifact_content(
        "# Findings\n\nIntro.\n\n## Evidence\n\nA claim.\n\n## Risks\n\nA risk.",
        "slides",
        "GraphRAG evaluation",
    )
    assert deck.startswith("## Slide 1: Findings")
    assert "主题：GraphRAG evaluation" in deck
    assert "## Slide 2: Evidence" in deck
    assert "## Slide 3: Risks" in deck


def test_render_slide_deck_is_deterministic_for_plain_text() -> None:
    report = "A conclusion.\n\nA source-backed limitation."
    assert render_artifact_content(report, "slides", "Topic") == render_artifact_content(
        report, "slides", "Topic"
    )


def test_render_slide_deck_respects_explicit_page_limit_without_dropping_sections() -> None:
    report = "\n\n".join(f"## Section {index}\n\nEvidence {index}." for index in range(1, 10))
    deck = render_artifact_content(report, "slides", "请输出 6 页以内的 Slides 提纲")

    assert len(re.findall(r"(?m)^## Slide \d+:", deck)) == 6
    for index in range(1, 10):
        assert f"Evidence {index}." in deck


def test_render_slide_deck_clamps_unreasonable_page_limit() -> None:
    report = "\n\n".join(f"## Section {index}\n\nEvidence {index}." for index in range(1, 15))
    deck = render_artifact_content(report, "slides", "up to 99 slides")

    assert len(re.findall(r"(?m)^## Slide \d+:", deck)) == 12


def test_render_slide_deck_honors_requested_five_pages() -> None:
    report = "\n\n".join(f"## Slide {i}: Finding\n\nEvidence {i}." for i in range(1, 8))
    deck = render_artifact_content(report, "slides", "用5页提纲说明异步任务差异")
    assert len(re.findall(r"(?m)^## Slide \d+:", deck)) == 5
    for i in range(1, 8):
        assert f"Evidence {i}." in deck


def test_numbered_slides_preserve_cover_boundaries_and_outside_references() -> None:
    report = (
        "# 文稿标题\n\n开场背景\n\n"
        + "\n\n".join(
            f"## Slide {i}: {label}\n\n正文{i}"
            for i, label in enumerate(["封面", "gather", "TaskGroup", "边界", "结论"], 1)
        )
        + "\n\n## 参考文献\n\n- [来源](https://example.test/doc)"
    )
    deck = render_artifact_content(report, "slides", "用5页说明")
    assert deck.count("## Slide ") == 5
    assert deck.startswith("## Slide 1: 封面")
    assert "# 文稿标题" in deck.split("## Slide 2:")[0]
    assert "正文2" in deck.split("## Slide 2:")[1].split("## Slide 3:")[0]
    assert "正文3" in deck.split("## Slide 3:")[1].split("## Slide 4:")[0]
    assert deck.endswith("## 参考文献\n\n- [来源](https://example.test/doc)")
    assert render_artifact_content(deck, "slides", "用5页说明") == deck


def test_numbered_reference_slide_is_appendix_and_overflow_keeps_all_content() -> None:
    pages = "\n\n".join(f"## Slide {i}: 标题{i}\n\n正文{i}" for i in range(1, 8))
    report = "# 文稿标题\n\n" + pages + "\n\n## Slide 8: 参考文献\n\n- 来源A"
    deck = render_artifact_content(report, "slides", "用5页说明")
    assert deck.count("## Slide ") == 5
    assert all(f"正文{i}" in deck and f"标题{i}" in deck for i in range(1, 8))
    assert deck.endswith("## 参考文献\n\n- 来源A")
