from ai_engine.contracts.artifacts import render_artifact_content


def test_render_slide_deck_preserves_report_sections() -> None:
    deck = render_artifact_content(
        "# Findings\n\nIntro.\n\n## Evidence\n\nA claim.\n\n## Risks\n\nA risk.",
        "slides",
        "GraphRAG evaluation",
    )
    assert deck.startswith("# GraphRAG evaluation")
    assert "## Slide 2: Evidence" in deck
    assert "## Slide 3: Risks" in deck


def test_render_slide_deck_is_deterministic_for_plain_text() -> None:
    report = "A conclusion.\n\nA source-backed limitation."
    assert render_artifact_content(report, "slides", "Topic") == render_artifact_content(report, "slides", "Topic")
