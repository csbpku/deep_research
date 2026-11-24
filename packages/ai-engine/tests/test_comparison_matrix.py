from ai_engine.comparison_matrix import dedupe_option_rows


def test_dedupes_a_row_per_option() -> None:
    text = (
        "## 对比矩阵\n\n| 方案 | 维度 |\n|---|---|\n"
        "| 甲 | a |\n| 甲 | b |\n| 乙 | c |\n\n## 下一步\nok\n"
    )
    out = dedupe_option_rows(text)
    assert out.count("| 甲 |") == 1
    assert "| 乙 |" in out
    assert out.endswith("## 下一步\nok\n")


def test_is_a_no_op_without_duplicates() -> None:
    text = "## 对比矩阵\n\n| 方案 | 维度 |\n|---|---|\n| 甲 | a |\n\n## 下一步\n"
    assert dedupe_option_rows(text) == text


def test_ignores_a_report_without_a_matrix() -> None:
    assert dedupe_option_rows("# 结论\n正文\n") == "# 结论\n正文\n"


def test_keeps_the_separator_row_and_prose() -> None:
    text = (
        "## 对比矩阵\n\n矩阵只比较差异。\n\n| 方案 | 维度 |\n|---|---|\n"
        "| 甲 | a |\n| 甲 | b |\n| 乙 | c |\n"
        "| 说明 | 未找到 |\n\n## 未知与冲突\n\n| 项 | 说明 |\n|---|---|\n| x | y |\n"
    )
    out = dedupe_option_rows(text)
    assert "|---|---|" in out
    assert out.count("| 甲 |") == 1
    assert out.count("矩阵只比较差异。") == 1
    assert "| 项 | 说明 |" in out
    assert out.count("| 说明 | 未找到 |") == 1
