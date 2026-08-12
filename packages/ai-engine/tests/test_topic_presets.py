from ai_engine.radar.topic_presets import DEFAULT_TOPIC_PRESETS, load_topic_presets


def test_default_topic_presets_are_stable_and_non_empty() -> None:
    presets = load_topic_presets()
    assert presets == DEFAULT_TOPIC_PRESETS
    assert {preset.slug for preset in presets} >= {"ai-agents", "rag-retrieval", "mcp-protocols"}


def test_topic_presets_accept_operator_json(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv(
        "TOPIC_PRESETS_JSON",
        '[{"name":"Eval","keywords":["evaluation","benchmark"],"enabled":true}]',
    )
    presets = load_topic_presets()
    assert len(presets) == 1
    assert presets[0].slug == "eval"
    assert presets[0].keywords == ("evaluation", "benchmark")
