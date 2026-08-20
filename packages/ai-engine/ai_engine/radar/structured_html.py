"""Structure-preserving HTML to Markdown conversion for radar source pages.

The generic text extractor is intentionally kept as a fallback.  This module
handles article pages where heading/list/code/table boundaries are meaningful
to the reader and to the generated article map.
"""

from __future__ import annotations

import re
from html import unescape
from typing import Any
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup, Comment, Tag
from bs4.element import NavigableString


_ROOT_SELECTORS = (
    "[itemprop='articleBody']",
    ".blog-content",
    "article.markdown-body",
    "article",
    "main",
)
_REMOVE_SELECTORS = (
    "script",
    "style",
    "noscript",
    "template",
    "nav",
    "header",
    "footer",
    "aside",
    ".SVELTE_HYDRATER",
    "[data-target='RepoCodeCopy']",
    ".not-prose",
)


def _clean_inline(value: str) -> str:
    value = unescape(value).replace("\xa0", " ")
    return re.sub(r"\s+", " ", value).strip()


def _href(node: Tag) -> str:
    href = str(node.get("href") or "").strip()
    if href.startswith(("javascript:", "data:")):
        return ""
    return href


def _image_url(node: Tag, base_url: str | None) -> str:
    raw = str(node.get("src") or node.get("data-src") or "").strip()
    if not raw:
        srcset = str(node.get("srcset") or "").strip()
        raw = srcset.split(",", 1)[0].strip().split(" ", 1)[0] if srcset else ""
    value = urljoin(base_url or "", raw)
    return value if urlparse(value).scheme in {"http", "https"} else ""


def _inline(node: Any, base_url: str | None = None) -> str:
    if isinstance(node, Comment):
        return ""
    if isinstance(node, NavigableString):
        return str(node)
    if not isinstance(node, Tag):
        return ""
    name = node.name.lower()
    if name in {"script", "style", "svg", "button", "input"}:
        return ""
    if name == "br":
        return "\n"
    if name == "a":
        label = _clean_inline("".join(_inline(child, base_url) for child in node.children))
        href = _href(node)
        return f"[{label}]({href})" if label and href else label
    if name == "img":
        src = _image_url(node, base_url)
        alt = _clean_inline(str(node.get("alt") or node.get("title") or "图片"))
        return f"![{alt}]({src})" if src else ""
    if name == "code" and node.parent and node.parent.name != "pre":
        return f"`{node.get_text('', strip=False).strip()}`"
    if name in {"strong", "b"}:
        text = _clean_inline("".join(_inline(child, base_url) for child in node.children))
        return f"**{text}**" if text else ""
    if name in {"em", "i"}:
        text = _clean_inline("".join(_inline(child, base_url) for child in node.children))
        return f"*{text}*" if text else ""
    return "".join(_inline(child, base_url) for child in node.children)


def _render(node: Any, level: int = 0, base_url: str | None = None) -> str:
    if isinstance(node, Comment):
        return ""
    if isinstance(node, NavigableString):
        return str(node)
    if not isinstance(node, Tag):
        return ""
    name = node.name.lower()
    if name in {"script", "style", "svg", "button", "input"}:
        return ""
    if name in {"h1", "h2", "h3", "h4", "h5", "h6"}:
        text = _clean_inline("".join(_inline(child, base_url) for child in node.children))
        return f"{'#' * int(name[1])} {text}\n\n" if text else ""
    if name == "pre":
        code = node.get_text("", strip=False).strip("\n")
        language = ""
        code_node = node.find("code")
        if isinstance(code_node, Tag):
            classes = code_node.get("class")
            if isinstance(classes, list) and classes:
                language = str(classes[0]).removeprefix("language-")
        # Use tilde fences: the source code of technical articles often
        # contains backtick-heavy examples, and the web reader's Markdown
        # normalizer is more robust when those cannot accidentally close a
        # backtick fence.
        return f"~~~{language}\n{code}\n~~~\n\n"
    if name == "li":
        body = _clean_inline("".join(_inline(child, base_url) for child in node.children if not (isinstance(child, Tag) and child.name == "ul")))
        nested = "".join(_render(child, level + 1, base_url) for child in node.children if isinstance(child, Tag) and child.name == "ul")
        return f"{'  ' * level}- {body}\n{nested}"
    if name in {"ul", "ol"}:
        items = [child for child in node.find_all("li", recursive=False)]
        if name == "ol":
            return "".join(f"{index}. {_clean_inline(_inline(item, base_url))}\n" for index, item in enumerate(items, 1)) + "\n"
        return "".join(_render(item, level, base_url) for item in items) + "\n"
    if name == "blockquote":
        text = _compact(_render_children(node, base_url))
        return "\n".join(f"> {line}" for line in text.splitlines()) + "\n\n" if text else ""
    if name == "table":
        rows: list[list[str]] = []
        for row in node.find_all("tr"):
            cells = [_clean_inline(_inline(cell, base_url)) for cell in row.find_all(["th", "td"], recursive=False)]
            if cells:
                rows.append(cells)
        if not rows:
            return ""
        width = max(len(row) for row in rows)
        rows = [row + [""] * (width - len(row)) for row in rows]
        output = ["| " + " | ".join(rows[0]) + " |", "| " + " | ".join(["---"] * width) + " |"]
        output.extend("| " + " | ".join(row) + " |" for row in rows[1:])
        return "\n".join(output) + "\n\n"
    if name == "figure":
        image = node.find("img")
        if not isinstance(image, Tag):
            return _render_children(node, base_url)
        image_markdown = _inline(image, base_url)
        caption_node = node.find("figcaption")
        caption = _clean_inline(caption_node.get_text(" ", strip=True)) if isinstance(caption_node, Tag) else ""
        return f"{image_markdown}\n\n*{caption}*\n\n" if image_markdown and caption else f"{image_markdown}\n\n"
    if name == "details":
        summary = node.find("summary", recursive=False)
        label = _clean_inline(_inline(summary, base_url)) if summary else ""
        body = "".join(_render(child, level, base_url) for child in node.children if child is not summary)
        # Keep collapsible blocks readable without turning their labels into
        # headings; otherwise the article map mistakes implementation options
        # for article chapters.
        label_markdown = label if label.startswith("**") else f"**{label}**"
        return (f"{label_markdown}\n\n" if label else "") + body + "\n"
    if name in {"p", "dt", "dd"}:
        text = _clean_inline(_inline(node, base_url))
        return f"{text}\n\n" if text else ""
    if name in {"div", "section", "figcaption", "body"}:
        return _render_children(node, base_url)
    return _inline(node, base_url)


def _render_children(node: Tag, base_url: str | None = None) -> str:
    return "".join(_render(child, base_url=base_url) for child in node.children)


def _compact(markdown: str) -> str:
    markdown = re.sub(r"(?m)[ \t]+$", "", markdown)
    markdown = re.sub(r"\n{3,}", "\n\n", markdown)
    # Repair a common DOM boundary artifact without joining intentional prose.
    markdown = re.sub(r"(\]\([^\n)]*\))(?=[A-Za-z])", r"\1 ", markdown)
    return markdown.strip()


def structured_html_to_markdown(html: str, base_url: str | None = None) -> str:
    """Return structured Markdown, or an empty string when no article exists."""
    soup = BeautifulSoup(html, "html.parser")
    root: Tag | None = None
    for selector in _ROOT_SELECTORS:
        candidate = soup.select_one(selector)
        if candidate and len(candidate.get_text(" ", strip=True)) >= 80:
            root = candidate
            break
    if root is None:
        return ""

    for selector in _REMOVE_SELECTORS:
        for node in root.select(selector):
            node.decompose()

    # Remove page chrome that is embedded in the article container by some
    # blog frameworks, while retaining the article title and lead paragraphs.
    for link in root.find_all("a", href="/blog"):
        parent = link.parent
        if parent:
            parent.decompose()
    for link in root.find_all("a", string=lambda value: value and "Update on GitHub" in value):
        parent = link.parent
        if parent:
            parent.decompose()
    for node in root.find_all("div"):
        text = _clean_inline(node.get_text(" ", strip=True))
        if "Published" in text and not node.find(["p", "h1", "h2", "h3", "h4", "h5", "h6"]):
            node.decompose()

    # A page-generated TOC duplicates the radar's own article map and is not
    # part of the article's reading flow.
    for heading in root.find_all(["h2", "h3"]):
        if _clean_inline(heading.get_text(" ", strip=True)).lower() in {"table of contents", "contents"}:
            sibling = heading.find_next_sibling()
            heading.decompose()
            if sibling and sibling.name in {"ul", "ol"}:
                sibling.decompose()

    return _compact(_render_children(root, base_url))
