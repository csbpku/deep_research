from ai_engine.server.app import ResearchAssistantBody, _extract_json_object, _strip_reasoning_blocks


def test_research_assistant_accepts_dedicated_translate_operation() -> None:
    body = ResearchAssistantBody(
        operation="translate",
        body="Translate this paragraph.",
        instruction="Translate to zh-CN.",
    )

    assert body.operation == "translate"


def test_reasoning_markup_is_removed_from_reader_output() -> None:
    assert _strip_reasoning_blocks(
        "<think>内部推理，不应展示。</think>\n真正的摘要。"
    ) == "真正的摘要。"
    assert _strip_reasoning_blocks(
        "<think>未闭合的内部推理"
    ) == ""


def test_json_recovery_ignores_reasoning_markup() -> None:
    assert _extract_json_object(
        "<think>先分析，再输出。</think>\n{\"version\": 2}"
    ) == {"version": 2}
