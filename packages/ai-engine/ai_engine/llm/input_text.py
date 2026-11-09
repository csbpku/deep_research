"""Readable text for model inputs, independent of Markdown used for display."""

from __future__ import annotations

import base64
import binascii
import re
from urllib.parse import unquote_to_bytes

_DATA_IMAGE = r"data:image/[a-zA-Z0-9.+-]+(?:;[a-zA-Z0-9=.+-]+)*,[^\s<>\"'()]+"
_MARKDOWN_IMAGE = re.compile(
    r"!\[(?P<alt>(?:\\.|[^\]\\]){0,1024})\]\(\s*<?(?P<uri>"
    + _DATA_IMAGE + r")>?\s*(?:[\"'][^\"']*[\"'])?\s*\)",
    re.IGNORECASE,
)
_BARE_IMAGE = re.compile(_DATA_IMAGE, re.IGNORECASE)
_MAX_SVG_BYTES = 2 * 1024 * 1024


def _svg_text(uri: str) -> str:
    metadata, _, payload = uri.partition(",")
    if not metadata.lower().startswith("data:image/svg+xml"):
        return ""
    payload = payload.split("#", 1)[0]
    if len(payload) > _MAX_SVG_BYTES * 4 // 3 + 4:
        return ""
    try:
        decoded = (
            base64.b64decode(unquote_to_bytes(payload), validate=True)
            if ";base64" in metadata.lower() else unquote_to_bytes(payload)
        )
        if len(decoded) > _MAX_SVG_BYTES:
            return ""
        from bs4 import BeautifulSoup

        # html.parser never resolves external XML entities or linked resources.
        soup = BeautifulSoup(decoded.decode("utf-8", errors="replace"), "html.parser")
        for node in soup.select("script, style, metadata"):
            node.decompose()
        labels: list[str] = []
        seen: set[str] = set()
        for node in soup.select("title, desc, text, foreignobject"):
            text = " ".join(node.get_text(" ", strip=True).split())
            if text and text not in seen:
                labels.append(text)
                seen.add(text)
        return "；".join(labels)
    except (ValueError, binascii.Error):
        return ""


def model_readable_text(value: str) -> str:
    """Remove inline image bytes before chunking; retain captions and SVG text.

    Ordinary URLs, prose, tables, and external image links stay intact. Invalid
    or oversized image data is still removed, without claiming to have read it.
    """
    if "data:image/" not in value.lower():
        return value

    def render(uri: str, alt: str = "") -> str:
        parts = [part for part in (" ".join(alt.split()), _svg_text(uri)) if part]
        label = "；".join(parts).replace("[", "\\[").replace("]", "\\]")
        return f"[内嵌图表：{label}]" if label else "[内嵌图片二进制已省略]"

    result = _MARKDOWN_IMAGE.sub(lambda m: render(m["uri"], m["alt"]), value)
    return _BARE_IMAGE.sub(lambda m: render(m.group()), result)
