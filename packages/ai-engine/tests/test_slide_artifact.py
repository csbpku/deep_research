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
    assert render_artifact_content(report, "slides", "Topic") == render_artifact_content(report, "slides", "Topic")


def test_render_slide_deck_respects_explicit_page_limit_without_dropping_sections() -> None:
    report = "\n\n".join(
        f"## Section {index}\n\nEvidence {index}." for index in range(1, 10)
    )
    deck = render_artifact_content(report, "slides", "请输出 6 页以内的 Slides 提纲")

    assert len(re.findall(r"(?m)^## Slide \d+:", deck)) == 6
    for index in range(1, 10):
        assert f"Evidence {index}." in deck


def test_render_slide_deck_clamps_unreasonable_page_limit() -> None:
    report = "\n\n".join(f"## Section {index}\n\nEvidence {index}." for index in range(1, 15))
    deck = render_artifact_content(report, "slides", "up to 99 slides")

    assert len(re.findall(r"(?m)^## Slide \d+:", deck)) == 12
