"""Week 9 收尾验收：20 个文件导入样本（10 合法 + 10 恶意）。

依据：docs/IMPLEMENTATION_PLAN.md §十一
  - "20 个合法/恶意文件导入样本均符合预期"
  - "HTML 危险内容残留为 0"

本文件是验收的回归门，不替代其他 import 单元测试。
每个 case 自带描述（name/expectation/assertions），失败时能直接看到是哪类
输入退化了。
"""
from __future__ import annotations


import pytest

from ai_engine.import_worker import convert_to_markdown


# ---------------------------------------------------------------------------
# 10 个合法样本 —— 应能成功转换为 markdown 且不产生 warnings
# ---------------------------------------------------------------------------

LEGIT_SAMPLES: list[tuple[str, str, str, str]] = [
    # (name, content, extension, expected_substring)
    (
        "纯文本 plain text",
        "Some plain text content.\nWith multiple lines.\n",
        ".txt",
        "Some plain text content.",
    ),
    (
        "Markdown 标题与列表",
        "# Title\n\n- item one\n- item two\n\n## Sub\n\nbody\n",
        ".md",
        "# Title",
    ),
    (
        "Markdown 代码块",
        "Intro\n\n```python\ndef f():\n    return 1\n```\n\nOutro\n",
        ".md",
        "```python",
    ),
    (
        "HTML 简单段落",
        "<p>Hello <strong>world</strong>.</p>",
        ".html",
        "**world**",
    ),
    (
        "HTML 标题与列表",
        "<h1>Top</h1><ul><li>One</li><li>Two</li></ul>",
        ".html",
        "# Top",
    ),
    (
        "HTML 链接到合法 https",
        '<a href="https://example.com/page">link</a>',
        ".html",
        "[link](https://example.com/page)",
    ),
    (
        "HTML 嵌套结构",
        "<section><h2>S</h2><p>Body with <em>emphasis</em>.</p></section>",
        ".html",
        "## S",
    ),
    (
        "Markdown 引用与分隔",
        "> quoted line\n\n---\n\nafter\n",
        ".md",
        "> quoted line",
    ),
    (
        "HTML 表格最小化",
        "<table><tr><th>A</th></tr><tr><td>1</td></tr></table>",
        ".html",
        "A",
    ),
    (
        "Markdown 行内代码 + 强调",
        "Use `pip install` to install **pkg**.",
        ".md",
        "`pip install`",
    ),
]


# ---------------------------------------------------------------------------
# 10 个恶意样本 —— 转换后必须不含危险载荷
# 期望：
#   - 转换成功（除"只剩危险内容"那条），但 warnings 非空
#   - 输出 markdown 不含 <script>/onclick/javascript:/data: 等
# ---------------------------------------------------------------------------

MALICIOUS_SAMPLES: list[tuple[str, str, str, list[str]]] = [
    # (name, content, extension, forbidden_substrings_in_output)
    (
        "script 标签注入",
        '<p>safe</p><script>alert(1)</script>',
        ".html",
        ["<script>", "alert(1)"],
    ),
    (
        "iframe 注入",
        '<p>safe</p><iframe src="https://evil.example/"></iframe>',
        ".html",
        ["<iframe", "evil.example"],
    ),
    (
        "onclick 事件处理器",
        '<p onclick="steal()">click me</p>',
        ".html",
        ["onclick", "steal()"],
    ),
    (
        "onerror / onload 事件",
        '<p>safe text</p><img src="x" onerror="x()" onload="y()">',
        ".html",
        ["onerror", "onload", "x()", "y()", "<img"],
    ),
    (
        "javascript: 协议链接",
        '<a href="javascript:alert(1)">click</a>',
        ".html",
        ["javascript:"],
    ),
    (
        "data: URL 链接",
        '<a href="data:text/html,<script>alert(1)</script>">d</a>',
        ".html",
        ["data:text/html", "alert(1)"],
    ),
    (
        "vbscript: 协议",
        '<a href="vbscript:msgbox(1)">v</a>',
        ".html",
        ["vbscript:"],
    ),
    (
        "object/embed 标签",
        '<p>x</p><object data="evil.swf"></object><embed src="evil.swf">',
        ".html",
        ["<object", "<embed", "evil.swf"],
    ),
    (
        "style 标签 + css 表达式",
        '<p>x</p><style>body{background:url("javascript:alert(1)")}</style>',
        ".html",
        ["<style", "javascript:"],
    ),
    (
        "嵌套危险标签",
        '<div onclick="a()"><script>b()</script><p onclick="c()">d</p></div>',
        ".html",
        ["<script", "b()", "onclick", "a()", "c()"],
    ),
]


# ---------------------------------------------------------------------------
# 参数化测试
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "name, content, ext, expected_substring",
    LEGIT_SAMPLES,
    ids=[s[0] for s in LEGIT_SAMPLES],
)
def test_legit_sample_converts_cleanly(
    name: str, content: str, ext: str, expected_substring: str
) -> None:
    """合法样本应：转换成功、含预期子串、不产生 warnings。"""
    md, warnings = convert_to_markdown(content, ext)
    assert expected_substring in md, f"[{name}] expected {expected_substring!r} in {md!r}"
    if ext == ".html":
        # HTML 合法样本不应触发任何 sanitization 警告
        assert warnings == [], f"[{name}] unexpected warnings: {warnings}"


@pytest.mark.parametrize(
    "name, content, ext, forbidden",
    MALICIOUS_SAMPLES,
    ids=[s[0] for s in MALICIOUS_SAMPLES],
)
def test_malicious_sample_strips_dangerous_content(
    name: str, content: str, ext: str, forbidden: list[str]
) -> None:
    """恶意样本：输出 markdown 不能含任何危险载荷；HTML 应触发 warnings。"""
    md, warnings = convert_to_markdown(content, ext)
    for token in forbidden:
        assert token not in md, (
            f"[{name}] dangerous token {token!r} leaked into output: {md!r}"
        )
    # warnings 应至少记录了一条"被剥离"
    assert len(warnings) > 0, f"[{name}] expected at least one warning, got none"


def test_legit_count_is_10() -> None:
    """回归守门：合法样本数量。"""
    assert len(LEGIT_SAMPLES) == 10


def test_malicious_count_is_10() -> None:
    """回归守门：恶意样本数量。"""
    assert len(MALICIOUS_SAMPLES) == 10


def test_html_only_dangerous_content_is_rejected() -> None:
    """整段 HTML 只含危险标签时，convert 应拒绝（无 importable text）。"""
    with pytest.raises(ValueError, match="no importable text"):
        convert_to_markdown("<script>alert(1)</script><style>body{}</style>", ".html")


def test_unsupported_extension_is_rejected() -> None:
    """非白名单扩展名应被拒。"""
    with pytest.raises(ValueError, match="unsupported extension"):
        convert_to_markdown("content", ".exe")
    with pytest.raises(ValueError, match="unsupported extension"):
        convert_to_markdown("content", ".docx")
