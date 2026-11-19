"""A learning path must stay a path: six sections, bounded length."""

from ai_engine.learning_path import (
    enforce_answer_shape,
    enforce_learning_budget,
    fill_answer_boundary_from_sources,
    is_valid_learning_path,
    reconcile_answer_shape,
)

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


def test_heading_glued_to_table_is_normalized() -> None:
    from ai_engine.learning_path import enforce_learning_budget

    text = (
        "## 90 秒回答\n回答\n\n"
        "## 概念图| 核心概念 | 作用 | 关系 |\n|---|---|---|\n"
        "| A | a | 与 B 相连 |\n| B | b | 与 A 相连 |\n"
        "| C | c | 依赖 A |\n| D | d | 依赖 B |\n\n"
        "## 分层解释\n解释\n\n## 可运行示例\n示例\n\n"
        "## 常见误区\n误区\n\n## 自检\n问题\n"
    )
    normalized = enforce_learning_budget(text)
    assert "## 概念图\n\n| 核心概念" in normalized
    assert "| D | d | 依赖 B |" in normalized
    assert "## 概念图|" not in normalized


def test_budget_never_leaves_a_truncation_note() -> None:
    bounded = enforce_learning_budget(_doc())
    assert "已压缩到字数上限" not in bounded
    assert bounded.count("## ") == 6
    assert bounded.rstrip().endswith("。")


def test_a_single_oversized_paragraph_stops_on_a_sentence() -> None:
    long_paragraph = "这是一个完整句子。" * 400
    text = (
        "## 90 秒回答\n短。\n\n## 概念图\n\n| 概念 | 含义 | 关系 |\n|---|---|---|\n"
        "| A | a | 与 B 相连 |\n| B | b | 与 A 相连 |\n\n"
        f"## 分层解释\n{long_paragraph}\n\n## 可运行示例\n短。\n\n"
        "## 常见误区\n短。\n\n## 自检\n短。\n"
    )
    bounded = enforce_learning_budget(text)
    assert "已压缩到字数上限" not in bounded
    assert "这是一个完整句子。" in bounded


def test_the_opening_answer_keeps_only_three_sentences() -> None:
    text = _doc().replace(
        "## 90 秒回答\n" + LONG,
        "## 90 秒回答\n\n它是什么。什么时候用！什么时候不要用？这是第四句。\n",
    )
    bounded = enforce_learning_budget(text)
    opening = bounded.split("## 概念图")[0]
    assert opening.count("。") + opening.count("！") + opening.count("？") == 3
    assert "第四句" not in opening


def test_the_opening_answer_keeps_three_labelled_lines() -> None:
    text = _doc().replace(
        "## 90 秒回答\n" + LONG,
        "## 90 秒回答\n\n- 是什么：清理旧版本。\n- 什么时候用：更新频繁时。\n"
        "- 什么时候不要用：只读表。\n- 多余的一句：应被删除。\n",
    )
    bounded = enforce_learning_budget(text)
    opening = bounded.split("## 概念图")[0]
    assert opening.count("- 是什么：") == 1
    assert opening.count("- 什么时候用：") == 1
    assert opening.count("- 什么时候不要用：") == 1
    assert "多余的一句" not in opening


def test_a_missing_opening_label_is_filled_as_an_evidence_gap() -> None:
    text = _doc().replace(
        "## 90 秒回答\n" + LONG,
        "## 90 秒回答\n\n- 是什么：清理旧版本。\n- 什么时候用：更新频繁时。\n",
    )
    bounded = enforce_learning_budget(text)
    opening = bounded.split("## 概念图")[0]
    assert "- 什么时候不要用：本轮未确认（证据缺口）。" in opening


def test_opening_gap_is_filled_from_a_cited_misconception() -> None:
    text = """## 90 秒回答

- 是什么：VACUUM 清理死元组。
- 什么时候用：死元组堆积时。
- 什么时候不要用：本轮未确认（证据缺口）。

## 概念图

| 概念 | 含义 |

## 常见误区

- 误区：死元组增长就全库 VACUUM → 实际情况：不要无原因地全库手动清理，可能制造额外 I/O。[S4](https://pg)
"""
    result = reconcile_answer_shape(text)
    assert "本轮未确认" not in result.split("## 概念图")[0]
    assert "不要无原因地全库手动清理" in result
    assert "[S4]" in result.split("## 概念图")[0]


def test_opening_gap_stays_when_the_body_has_no_counterexample() -> None:
    text = """## 90 秒回答

- 是什么：VACUUM 清理死元组。
- 什么时候不要用：本轮未确认（证据缺口）。

## 概念图

| 概念 | 含义 |
"""
    assert reconcile_answer_shape(text) == text


def test_opening_bullet_drops_the_misconception_template() -> None:
    text = """## 90 秒回答

- 是什么：VACUUM 清理死元组。
- 什么时候用：死元组堆积时。
- 什么时候不要用：实际情况：** 固定计划无法适应峰值；官方不建议完全禁用 autovacuum。[S4](https://pg)

## 概念图

| 概念 | 含义 |
"""
    opening = enforce_answer_shape(text).split("## 概念图")[0]
    assert "实际情况" not in opening
    assert "固定计划无法适应峰值" in opening


def test_prerequisite_in_the_third_bullet_is_replaced_by_a_real_boundary() -> None:
    text = """## 90 秒回答

- 是什么：VACUUM 清理死元组。
- 什么时候用：死元组堆积时。
- 什么时候不要用：学习 VACUUM 前应先理解 MVCC 和事务快照。

## 常见误区

1. **误区：VACUUM FULL 能及时解决所有膨胀。 → 实际情况：它会重写整表，需要 ACCESS EXCLUSIVE 锁，运行时表不能并行读写；常规维护应优先使用标准 VACUUM。** [S3](https://pg)
"""
    opening = reconcile_answer_shape(text).split("## 常见误区")[0]
    assert "学习 VACUUM 前" not in opening
    assert "ACCESS EXCLUSIVE" in opening
    assert "[S3]" in opening


def test_prerequisite_without_a_counterexample_becomes_an_explicit_gap() -> None:
    text = """## 90 秒回答

- 是什么：VACUUM 清理死元组。
- 什么时候不要用：学习 VACUUM 前应先理解 MVCC。

## 常见误区

- 误区：VACUUM 会归还磁盘空间 → 实际情况：普通 VACUUM 只复用空间。[S1](https://pg)
"""
    opening = reconcile_answer_shape(text).split("## 常见误区")[0]
    assert "本轮未确认" in opening


def test_the_budget_drops_a_trailing_bibliography() -> None:
    text = """## 90 秒回答

- 是什么：VACUUM 清理死元组。[S1](https://pg)
- 什么时候用：死元组堆积时。
- 什么时候不要用：标准 VACUUM 已能清理；FULL 需要排他锁。

## 概念图

| 核心概念 | 含义 | 关系 |
|---|---|---|
| MVCC | 多版本 | 决定死元组 |
| VACUUM | 清理 | 清理死元组 |
| autovacuum | 自动清理 | 执行 VACUUM |
| ANALYZE | 统计 | 更新统计 |

## 分层解释

一

## 可运行示例

二

## 常见误区

- 误区：FULL 解决一切 → 实际情况：FULL 需要排他锁。[S1](https://pg)

## 自检

1. 三

## 参考文献

1. [PostgreSQL](https://pg)
"""
    bounded = enforce_learning_budget(text)
    assert "## 参考文献" not in bounded
    assert "## 自检" in bounded


def test_trimming_a_section_never_leaves_a_code_fence_open() -> None:
    text = _doc()
    text = text.replace(
        "## 可运行示例\n",
        "## 可运行示例\n\n"
        + "\n\n".join(f"说明段落 {index}。" * 30 for index in range(6))
        + "\n\n```sql\nSELECT 1;\n```\n\n结尾说明。\n",
    )
    bounded = enforce_learning_budget(text)
    assert bounded.count("```") % 2 == 0
    assert "## 常见误区" in bounded.split("```")[-1]


def test_an_unclosed_fence_is_closed_before_the_next_heading() -> None:
    text = _doc().replace(
        "```sql\nSELECT 1;\n```",
        "```sql\nSELECT 1;",
    )
    bounded = enforce_learning_budget(text)
    assert bounded.count("```") % 2 == 0
    assert "## 常见误区" in bounded


def test_a_fence_glued_to_a_heading_is_separated() -> None:
    text = _doc().replace("## 可运行示例\n", "## 可运行示例```sql\n")
    bounded = enforce_learning_budget(text)
    assert "## 可运行示例\n" in bounded
    assert bounded.count("```") % 2 == 0


def _doc_with_third_bullet(third: str) -> str:
    answer = (
        "## 90 秒回答\n\n"
        "- 是什么：VACUUM 回收死元组。\n"
        "- 什么时候用：日常维护。\n"
        f"- 什么时候不要用：{third}\n"
    )
    doc = _doc()
    return doc.replace(doc[doc.index("## 90 秒回答"):doc.index("## 概念图")], answer)


def test_a_limitation_is_not_accepted_as_a_boundary() -> None:
    text = _doc_with_third_bullet("普通 VACUUM 通常不会立即把磁盘空间归还操作系统。")
    bounded = enforce_learning_budget(text)
    assert "本轮未确认（证据缺口）" in bounded
    assert "不会立即把磁盘空间归还" not in bounded.split("## 概念图")[0]


def test_a_conditional_boundary_survives() -> None:
    text = _doc_with_third_bullet("当长事务阻塞 xmin 视界时，不要继续提高 autovacuum 力度。")
    bounded = enforce_learning_budget(text)
    assert "当长事务阻塞 xmin 视界时" in bounded


def test_a_disabled_setting_is_not_a_direct_prohibition() -> None:
    text = _doc_with_third_bullet(
        "答案要点：还要依次检查表级禁用、锁等待和旧快照阻塞。"
    )
    bounded = enforce_learning_budget(text)
    assert "本轮未确认（证据缺口）" in bounded


def test_a_cited_condition_in_the_body_becomes_the_boundary() -> None:
    text = _doc_with_third_bullet("本轮未确认（证据缺口）。").replace(
        "## 概念图\n",
        "## 概念图\n\n| 概念 | 含义 | 关系 |\n|---|---|---|\n"
        "| `xmin` 视界 | 最旧快照边界 | 长事务、复制槽可阻止视界推进，"
        "使调高 autovacuum 强度也无效。[S5] |\n\n",
    )
    bounded = enforce_learning_budget(text)
    bullet = next(line for line in bounded.splitlines() if line.startswith("- 什么时候不要用"))
    assert "阻止视界推进" in bullet
    assert "[S5]" in bullet


def test_an_uncited_condition_is_not_lifted() -> None:
    text = _doc_with_third_bullet("本轮未确认（证据缺口）。").replace(
        "## 概念图\n",
        "## 概念图\n\n| 概念 | 含义 | 关系 |\n|---|---|---|\n"
        "| `xmin` 视界 | 最旧快照边界 | 长事务可阻止视界推进，使调高 autovacuum 强度也无效。 |\n\n",
    )
    bounded = enforce_learning_budget(text)
    bullet = next(line for line in bounded.splitlines() if line.startswith("- 什么时候不要用"))
    assert "本轮未确认" in bullet


def test_a_condition_without_a_negative_outcome_is_not_a_boundary() -> None:
    text = _doc_with_third_bullet(
        "autovacuum 在表内容变化足够多时更新统计信息，使规划器获得较新的数据分布。"
    )
    bounded = enforce_learning_budget(text)
    bullet = next(line for line in bounded.splitlines() if line.startswith("- 什么时候不要用"))
    assert "本轮未确认" in bullet


def test_an_empty_layer_gets_a_stated_gap_not_a_bare_heading() -> None:
    text = _doc_with_third_bullet("本轮未确认（证据缺口）。").replace(
        "## 分层解释\n",
        "## 分层解释\n\n### 第一层\n有正文。\n\n### 第二层\n\n### 第三层\n也有正文。\n\n",
    ).replace("## 概念图\n", "## 概念图\n\n| 概念 | 含义 | 关系 |\n|---|---|---|\n| A | a | 与 B 相连 |\n| B | b | 与 A 相连 |\n| C | c | 依赖 A |\n| D | d | 依赖 B |\n\n")
    bounded = enforce_learning_budget(text)
    layer = bounded.split("### 第二层")[1].split("### 第三层")[0]
    assert "本轮未确认" in layer


def test_an_example_without_an_expectation_states_the_gap() -> None:
    text = _doc_with_third_bullet("本轮未确认（证据缺口）。").replace(
        "## 可运行示例\n" + LONG,
        "## 可运行示例\n```bash\npsql -c 'select 1';\n```",
    )
    bounded = enforce_learning_budget(text)
    assert "预期输出" in bounded
    assert "尚未记录实际运行结果" in bounded


def test_an_example_with_an_expectation_is_untouched() -> None:
    text = _doc_with_third_bullet("本轮未确认（证据缺口）。").replace(
        "## 可运行示例\n" + LONG,
        "## 可运行示例\n```bash\npsql -c 'select 1';\n```\n\n预期输出：一行 `1`。",
    )
    bounded = enforce_learning_budget(text)
    assert bounded.count("预期输出") == 1


def test_an_example_cut_mid_statement_is_closed_at_the_last_statement() -> None:
    text = _doc_with_third_bullet("本轮未确认（证据缺口）。").replace(
        "## 可运行示例\n" + LONG,
        "## 可运行示例\n```sql\nSELECT 1;\nSELECT pid, datname,\n```\n\n预期输出：两行。",
    )
    bounded = enforce_learning_budget(text)
    section = bounded.split("## 可运行示例")[1].split("## 常见误区")[0]
    assert "SELECT 1;" in section
    assert "SELECT pid, datname," not in section
    assert "其余语句已省略" in section


def test_self_check_does_not_end_mid_question() -> None:
    text = _doc_with_third_bullet("本轮未确认（证据缺口）。").replace(
        "## 自检\n" + LONG,
        "## 自检\n\n1. 问题一？\n\n答案要点：一。\n\n2. 问题二？\n\n答案要点：二。\n\n3. 问题三？\n\n答案要点：三。\n",
    )
    bounded = enforce_learning_budget(text)
    section = bounded.split("## 自检")[1]
    assert section.count("问题") >= 3
    assert "3. 问题三？" in section


def test_concept_map_keeps_one_blank_line_before_the_next_heading() -> None:
    text = _doc()
    bounded = enforce_learning_budget(text)
    assert "\n\n\n" not in bounded


def test_a_question_without_an_answer_is_counted_as_a_gap() -> None:
    text = _doc_with_third_bullet("本轮未确认（证据缺口）。").replace(
        "## 自检\n" + LONG,
        "## 自检\n\n1. 问题一？\n\n答案要点：一。\n\n2. 问题二？\n\n3. 问题三？\n\n答案要点：三。\n",
    )
    bounded = enforce_learning_budget(text)
    section = bounded.split("## 自检")[1]
    assert "本轮未确认" in section


def test_a_source_condition_fills_an_unconfirmed_boundary() -> None:
    text = _doc_with_third_bullet("本轮未确认（证据缺口）。")
    sources = [
        (5, "任何阻止 xmin 视界推进的因素都会使所有表的清理无法进行，不管 autovacuum 调得多激进。"),
    ]
    out = fill_answer_boundary_from_sources(text, sources)
    assert "什么时候不要用：本轮未确认" not in out
    assert "阻止 xmin 视界推进" in out
    assert "[S5]" in out


def test_a_source_trade_off_does_not_fill_the_boundary() -> None:
    text = _doc_with_third_bullet("本轮未确认（证据缺口）。")
    sources = [(1, "普通 VACUUM 通常不会把空间归还操作系统。")]
    out = fill_answer_boundary_from_sources(text, sources)
    assert "本轮未确认" in out


def test_a_source_boundary_drops_writer_labels_and_stray_punctuation() -> None:
    text = _doc_with_third_bullet("本轮未确认（证据缺口）。")
    sources = [(1, "答案要点：若 xmin 视界被卡住，参数调整无法解除阻塞；。")]
    out = fill_answer_boundary_from_sources(text, sources)
    line = next(line for line in out.splitlines() if line.startswith("- 什么时候不要用"))
    assert "答案要点" not in line
    assert "；。" not in line
    assert line.endswith("。[S1]")


def test_boundary_scaffolding_is_removed_even_when_the_sentence_is_valid() -> None:
    text = _doc_with_third_bullet("答案要点：若 xmin 被卡住，参数调整无法解除阻塞；。[S1]")
    bounded = enforce_learning_budget(text)
    line = next(line for line in bounded.splitlines() if line.startswith("- 什么时候不要用"))
    assert "答案要点" not in line
    assert "；。" not in line
    assert line.endswith("。[S1]")
