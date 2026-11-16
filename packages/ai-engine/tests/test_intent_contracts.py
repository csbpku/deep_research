"""The report contract must follow the confirmed research intent."""

from __future__ import annotations

from ai_engine.adapters.gpt_researcher import _report_output_contract


def test_learning_contract_is_a_path_not_a_procurement_memo() -> None:
    contract = _report_output_contract(
        "学习 PostgreSQL 的 MVCC", report_type="research_report", objective="learn"
    )

    assert "## 心智模型" in contract
    assert "## 可运行示例" in contract
    assert "## 覆盖检查" in contract
    assert "## 自检" in contract
    assert "采购建议" in contract


def test_investigation_contract_requires_competing_hypotheses() -> None:
    contract = _report_output_contract(
        "为什么连接池下锁会失效", report_type="research_report", objective="investigate"
    )

    assert "## 竞争假设" in contract
    assert "## 判别性证据" in contract
    assert "## 剩余不确定性" in contract
    assert "## 覆盖检查" in contract


def test_exploration_contract_is_a_map_not_a_decision() -> None:
    contract = _report_output_contract(
        "向量数据库生态", report_type="research_report", objective="explore"
    )

    assert "## 主题地图" in contract
    assert "## 关键问题" in contract
    assert "## 下一步阅读" in contract


def test_confirmed_learning_intent_beats_a_comparison_keyword_in_context() -> None:
    contract = _report_output_contract(
        "PostgreSQL 的 MVCC 是如何工作的？",
        report_type="research_report",
        context="研究计划：说明版本链、快照与 VACUUM 的取舍，不要写成选型报告。",
        objective="learn",
    )

    assert "## 心智模型" in contract
    assert "## 对比矩阵" not in contract


def test_decision_intent_keeps_the_comparison_contract() -> None:
    contract = _report_output_contract(
        "比较 Playwright 与 Cypress", report_type="research_report", objective="decide"
    )

    assert "## 对比矩阵" in contract
    assert "## 结构化推荐" in contract


def test_coverage_table_only_holds_must_answer_questions() -> None:
    contract = _report_output_contract(
        "学习 PostgreSQL 的 MVCC", report_type="research_report", objective="learn"
    )

    assert "完成标准不要混进表格" in contract
    assert "行内引用只写 [S#]" in contract


def test_comparison_matrix_contract_does_not_recommend_a_winner() -> None:
    contract = _report_output_contract(
        "比较 pg_advisory_xact_lock 与 SELECT FOR UPDATE",
        report_type="comparison_matrix",
        objective="decide",
    )

    assert "## 对比矩阵" in contract
    assert "## 权重敏感性" in contract
    assert "## 适用条件" in contract
    assert "不要给唯一推荐" in contract
    assert "推荐方案" in contract
