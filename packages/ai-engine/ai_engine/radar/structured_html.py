"""Structure-preserving HTML to Markdown conversion for radar source pages.

The generic text extractor is intentionally kept as a fallback.  This module
handles article pages where heading/list/code/table boundaries are meaningful
to the reader and to the generated article map.
"""

from __future__ import annotations

import base64
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
    raw = str(
        node.get("src")
        or node.get("data-src")
        or node.get("data")
        or ""
    ).strip()
    if not raw:
        srcset = str(node.get("srcset") or "").strip()
        raw = srcset.split(",", 1)[0].strip().split(" ", 1)[0] if srcset else ""
    if not raw:
        return ""
    value = urljoin(base_url or "", raw)
    return value if urlparse(value).scheme in {"http", "https"} else ""


def _clean_svg_text(value: str) -> str:
    """Turn arXiv's math-marked chart labels into readable SVG text."""
    cleaned = unescape(value)
    cleaned = re.sub(r"\$(.*?)\$", r"\1", cleaned)
    cleaned = re.sub(r"\\(?:text|mathrm|mathbf|mathit)\{([^{}]*)\}", r"\1", cleaned)
    replacements = (
        (r"\\Delta", "Δ"),
        (r"\\alpha", "α"),
        (r"\\beta", "β"),
        (r"\\gamma", "γ"),
        (r"\\lambda", "λ"),
        (r"\\mu", "μ"),
        (r"\\omega", "ω"),
        (r"\\pi", "π"),
        (r"\\rho", "ρ"),
        (r"\\sigma", "σ"),
        (r"\\tau", "τ"),
        (r"\\infty", "∞"),
        (r"\\blacksquare", "■"),
        (r"\\emptyset", "∅"),
        (r"\\times", "×"),
        (r"\\sim", "∼"),
        (r"\\to", "→"),
        (r"\\langle", "‹"),
        (r"\\rangle", "›"),
        (r"\\dots|\\ldots", "…"),
        (r"\\cdots", "⋯"),
        (r"\\cdot", "·"),
        (r"\\approx", "≈"),
        (r"\\propto", "∝"),
        (r"\\in", "∈"),
        (r"\\notin", "∉"),
        (r"\\left|\\right", ""),
        (r"\\left|", ""),
        (r"\\right|", ""),
        (r"\\left", ""),
        (r"\\right", ""),
        (r"\\pm", "±"),
        (r"\\leq?", "≤"),
        (r"\\geq?", "≥"),
        (r"\\%", "%"),
        (r"\\,", " "),
        (r"\\;", " "),
        (r"\\!", ""),
        (r"\\quad", "  "),
        (r"\\qquad", "    "),
    )
    for pattern, replacement in replacements:
        cleaned = re.sub(pattern, replacement, cleaned)
    cleaned = cleaned.replace(r"\{", "{").replace(r"\}", "}")
    cleaned = re.sub(r"\{([^{}]*)\}", r"\1", cleaned)
    return cleaned


def _svg_data_url(node: Tag, figure_id: str = "") -> str:
    """Serialize an arXiv chart SVG as a sanitized image data URL."""
    classes = node.get("class")
    if not isinstance(classes, list) or "ltx_picture" not in classes:
        return ""

    # Work on a detached copy so the source tree remains available to the
    # surrounding figure/caption extraction.
    try:
        copy = BeautifulSoup(str(node), "html5lib").find("svg")
    except Exception:
        copy = BeautifulSoup(str(node), "xml").find("svg")
    if not isinstance(copy, Tag):
        return ""
    copy["xmlns"] = "http://www.w3.org/2000/svg"
    has_link_attribute = any(
        attribute.lower() in {"xlink:href", "href"}
        for tag in [copy, *copy.find_all(True)]
        for attribute in tag.attrs
    )
    if has_link_attribute:
        copy["xmlns:xlink"] = "http://www.w3.org/1999/xlink"
    # arXiv uses XHTML nodes inside foreignObject for axis labels and
    # annotations. Once the SVG is loaded as a standalone image, those nodes
    # need their own namespace or Chromium renders only the vector shapes.
    for foreign_object in (
        tag for tag in copy.find_all(True) if tag.name.lower() == "foreignobject"
    ):
        # ar5iv emits the figure in TeX coordinates but leaves its XHTML
        # labels at the source 10pt size. As a standalone image Chromium does
        # not apply the page-level figure scale, so dense labels collide. The
        # PDF rendering uses roughly 72% of that size; carry that correction
        # into the self-contained SVG instead.
        style = str(foreign_object.get("style") or "")
        foreign_object["style"] = re.sub(
            r"font-size:\s*([\d.]+)pt",
            lambda match: f"font-size:{float(match.group(1)) * 0.72:.2f}pt",
            style,
            flags=re.IGNORECASE,
        )
        for child in foreign_object.find_all(True, recursive=False):
            child["xmlns"] = "http://www.w3.org/1999/xhtml"
        for text_node in foreign_object.find_all(string=True):
            text_node.replace_with(_clean_svg_text(str(text_node)))
    for tag in copy.find_all(["script", "iframe", "object", "embed"]):
        tag.decompose()
    for tag in [copy, *copy.find_all(True)]:
        for attribute in list(tag.attrs):
            lowered = attribute.lower()
            raw = str(tag.attrs[attribute])
            if lowered.startswith("on"):
                del tag.attrs[attribute]
            elif lowered in {"href", "xlink:href"} and not raw.lstrip().startswith("#"):
                del tag.attrs[attribute]
            elif lowered == "style" and "url(" in raw.lower():
                del tag.attrs[attribute]
    # ar5iv's converted Figure 12 drops the tail of the user-query label
    # while the surrounding prose and the PDF retain the full placeholder.
    # Repair this confirmed conversion artifact only for that figure.
    if figure_id == "A1.F12":
        for text_node in copy.find_all(string=lambda value: value and "推荐五款最值得" in value):
            text_node.replace_with(str(text_node).replace("推荐五款最值得", "推荐五款最值得买的 [产品]"))
        for text_node in copy.find_all(string=lambda value: value and "Recommend the top 5 …" in value):
            text_node.replace_with(
                str(text_node).replace("Recommend the top 5 …", "Recommend the top five most worth-buying [product]")
            )
    encoded = base64.b64encode(str(copy).encode("utf-8")).decode("ascii")
    return f"data:image/svg+xml;base64,{encoded}"


def _svg_abstract_markdown(node: Tag, base_url: str | None = None) -> str:
    """Recover the abstract when arXiv embeds it in the first SVG card.

    ar5iv renders some papers' abstracts as text inside an SVG
    ``foreignObject``. Treating that SVG only as an image makes the abstract
    inaccessible and causes the reader to jump straight from authors to the
    first numbered section.
    """
    foreign_object = node.find("foreignObject")
    if not isinstance(foreign_object, Tag):
        return ""

    paragraphs: list[str] = []
    for paragraph in foreign_object.select(".ltx_p"):
        text = _clean_inline(_inline(paragraph, base_url))
        if text and text not in paragraphs:
            paragraphs.append(text)
    if len(paragraphs) < 2 or paragraphs[0].strip().lower() not in {"abstract", "摘要"}:
        return ""
    return "## Abstract\n\n" + "\n\n".join(paragraphs[1:])


def _figure_fragment(value: Any) -> str:
    figure_id = str(value or "").strip()
    return f"#{figure_id}" if re.fullmatch(r"[A-Za-z]\d+\.F\d+", figure_id) else ""


def _inline(node: Any, base_url: str | None = None, figure_id: str = "") -> str:
    if isinstance(node, Comment):
        return ""
    if isinstance(node, NavigableString):
        return str(node)
    if not isinstance(node, Tag):
        return ""
    name = node.name.lower()
    if name in {"script", "style", "button", "input"}:
        return ""
    if name == "svg":
        abstract = _svg_abstract_markdown(node, base_url)
        if abstract:
            return abstract
        src = _svg_data_url(node, figure_id)
        src += _figure_fragment(figure_id)
        return f"![图形]({src})" if src else ""
    if name == "object":
        src = _image_url(node, base_url)
        src += _figure_fragment(figure_id)
        alt = _clean_inline(str(node.get("aria-label") or node.get("title") or "图形"))
        return f"![{alt}]({src})" if src else ""
    if name == "math":
        alttext = str(node.get("alttext") or "").strip()
        if alttext:
            delimiter = "$$" if str(node.get("display") or "").lower() in {"block", "display"} else "$"
            return f"{delimiter}{alttext}{delimiter}"
        return _clean_inline(node.get_text(" ", strip=True))
    if name == "br":
        return "\n"
    if name == "a":
        label = _clean_inline("".join(_inline(child, base_url) for child in node.children))
        href = _href(node)
        return f"[{label}]({href})" if label and href else label
    if name == "img":
        src = _image_url(node, base_url)
        src += _figure_fragment(figure_id)
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
        group_heading = ""
        source_rows = node.find_all("tr")
        for row_index, row in enumerate(source_rows):
            cells = [_clean_inline(_inline(cell, base_url)) for cell in row.find_all(["th", "td"], recursive=False)]
            if cells:
                has_colspan = any(
                    str(cell.get("colspan") or "1").isdigit()
                    and int(str(cell.get("colspan") or "1")) > 1
                    for cell in row.find_all(["th", "td"], recursive=False)
                )
                if row_index == 0 and has_colspan and len(source_rows) > 1:
                    group_heading = " / ".join(cell for cell in cells if cell)
                    continue
                rows.append(cells)
        if not rows:
            return ""
        width = max(len(row) for row in rows)
        rows = [row + [""] * (width - len(row)) for row in rows]
        output = ["| " + " | ".join(rows[0]) + " |", "| " + " | ".join(["---"] * width) + " |"]
        output.extend("| " + " | ".join(row) + " |" for row in rows[1:])
        prefix = f"*{group_heading}*\n\n" if group_heading else ""
        return prefix + "\n".join(output) + "\n\n"
    if name == "figure":
        image = node.find("img")
        object_node = node.find("object", class_="ltx_graphics")
        svg = node.find("svg", class_="ltx_picture")
        if not isinstance(image, Tag) and not isinstance(object_node, Tag) and not isinstance(svg, Tag):
            return _render_children(node, base_url)
        image_markdown = _inline(
            image if isinstance(image, Tag) else object_node if isinstance(object_node, Tag) else svg,
            base_url,
            str(node.get("id") or ""),
        )
        caption_node = node.find("figcaption")
        caption = _clean_inline(_inline(caption_node, base_url)) if isinstance(caption_node, Tag) else ""
        if image_markdown and caption:
            return f"{image_markdown}\n\n*{caption}*\n\n"
        if image_markdown:
            return f"{image_markdown}\n\n"
        return f"*{caption}*\n\n" if caption else ""
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
    # arXiv wraps wide tables in transformed inline spans. Treat only spans
    # that actually contain block-like structures as containers; ordinary
    # inline spans must keep using ``_inline`` so SVG abstracts still pass
    # through the dedicated foreignObject recovery path above.
    if name in {"div", "section", "figcaption", "body"}:
        return _render_children(node, base_url)
    if name == "span" and node.find(["table", "figure", "pre", "ul", "ol", "blockquote"]):
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
    # html5lib keeps SVG's case-sensitive names (viewBox, foreignObject) so
    # extracted arXiv figures remain valid when serialized as image data URLs.
    soup = BeautifulSoup(html, "html5lib")
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
