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
