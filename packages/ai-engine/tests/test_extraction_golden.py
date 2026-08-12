"""P0 黄金提取 fixture：覆盖 blog/RSS/GitHub/arXiv/中文长文/脚注/异常/验证码 8 类来源。

依据：docs/PRODUCT_REWORK_PLAN.md §P0 —— 正文抽取黄金 fixture 应覆盖这些来源类型，
防止 trafilatura 升级或 HTML-to-MD 路径变更时静默退化。

每个 case 跑同一管线：
    html_to_markdown(html) -> normalize_markdown -> inspect_markdown

断言：
  - 不抛异常
  - markdown_sha256 跨运行稳定（确定性）
  - 合法样本产出包含预期子串（结构稳定）
  - 验证码/异常 HTML 产出很短，不被误当成正文
  - 任意 HTML 中的 javascript: 协议不会保留在最终 markdown 中
"""
from __future__ import annotations

from pathlib import Path

import pytest

from ai_engine.markdown_pipeline import inspect_markdown, markdown_sha256, normalize_markdown
from ai_engine.server.share import html_to_markdown


FIXTURE_DIR = Path(__file__).parent / "fixtures" / "extraction"


def _load(name: str) -> str:
    return (FIXTURE_DIR / name).read_text(encoding="utf-8")


# (fixture 文件名, 输出应包含的子串; None 表示不强制断言)
LEGIT_FIXTURES: list[tuple[str, str | None]] = [
    ("blog-article.html", "stateless"),
    ("rss-item.html", "structured outputs"),
    ("github-readme.html", "mcp-router"),
    ("arxiv-abstract.html", "sparse attention"),
    ("zh-long-form.html", "向量数据库"),
    ("footnote-heavy.html", "footnote"),
]

# (fixture 文件名, 期望最长字符数 —— 用于确保不被误判为正文)
SHORT_FIXTURES: list[tuple[str, int]] = [
    ("captcha.html", 200),
    ("malformed.html", 600),
]


@pytest.mark.parametrize(("fixture", "expected_substring"), LEGIT_FIXTURES)
def test_legit_fixture_yields_expected_markdown(fixture: str, expected_substring: str | None) -> None:
    html = _load(fixture)
    md = html_to_markdown(html)
    assert md, f"{fixture}: empty markdown output"
    normalized = normalize_markdown(md)
    quality = inspect_markdown(normalized)
    assert quality is not None
    if expected_substring is not None:
        assert expected_substring in normalized, f"{fixture}: missing substring {expected_substring!r}"


@pytest.mark.parametrize("fixture", [name for name, _ in LEGIT_FIXTURES])
def test_legit_fixture_hash_is_stable(fixture: str) -> None:
    """同一 fixture 跑两次，markdown_sha256 必须一致 —— 防止 normalizer 改动悄悄退化。"""
    html = _load(fixture)
    md = html_to_markdown(html)
    first = markdown_sha256(md)
    second = markdown_sha256(html_to_markdown(html))
    assert first == second, f"{fixture}: hash drift"


@pytest.mark.parametrize(("fixture", "max_len"), SHORT_FIXTURES)
def test_short_fixture_is_not_mistaken_for_body(fixture: str, max_len: int) -> None:
    """验证码页和异常 HTML 必须产出极短的 markdown，不能被当成正文。"""
    html = _load(fixture)
    md = html_to_markdown(html)
    assert len(md) <= max_len, (
        f"{fixture}: output too long ({len(md)} > {max_len}); "
        "captcha/malformed pages should be detected as low-quality"
    )


@pytest.mark.parametrize("fixture", [name for name, _ in SHORT_FIXTURES])
def test_dangerous_protocols_stripped(fixture: str) -> None:
    """javascript: 等危险协议不应保留在最终 markdown 中。"""
    html = _load(fixture)
    md = html_to_markdown(html).lower()
    assert "javascript:" not in md, f"{fixture}: javascript: protocol leaked into markdown"
    assert "vbscript:" not in md
    assert "<script" not in md
