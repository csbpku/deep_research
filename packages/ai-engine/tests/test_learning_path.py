"""A learning path must stay a path: six sections, bounded length."""

from ai_engine.learning_path import enforce_learning_budget, is_valid_learning_path

LONG = "这是一段很长的解释。" * 200


def _doc() -> str:
    return (
        "# 学习 PostgreSQL MVCC\n\n"
        f"## 90 秒回答\n{LONG}\n\n"
        f"## 概念图\n{LONG}\n\n"
        f"## 分层解释\n{LONG}\n\n"
        f"## 可运行示例\n{LONG}\n\n"
        f"## 常见误区\n{LONG}\n\n"
        f"## 自检\n{LONG}\n"
    )


def test_valid_learning_path_keeps_six_sections() -> None:
    text = _doc()
    assert is_valid_learning_path(text)
    bounded = enforce_learning_budget(text)
    assert is_valid_learning_path(bounded)
    assert len(bounded) <= 3_200
    assert all(heading in bounded for heading in ("90 秒回答", "概念图", "分层解释", "可运行示例", "常见误区", "自检"))


def test_missing_section_is_not_rewritten() -> None:
    text = "# 学习\n\n## 90 秒回答\n短。\n"
    assert not is_valid_learning_path(text)
    assert enforce_learning_budget(text) == text


def test_concept_table_is_not_cut_below_four_rows() -> None:
    rows = "\n".join(f"| C{i} | 含义 | 关系 [S1] |" for i in range(1, 8))
    text = (
        "# 学习\n\n## 90 秒回答\n短。\n\n## 概念图\n\n| 概念 | 含义 | 关系 |\n|---|---|---|\n"
        + rows
        + "\n\n## 分层解释\n短。\n\n## 可运行示例\n短。\n\n## 常见误区\n短。\n\n## 自检\n短。\n"
    )
    bounded = enforce_learning_budget(text)
    table_rows = [line for line in bounded.splitlines() if line.startswith("| C")]
    assert 4 <= len(table_rows) <= 6
