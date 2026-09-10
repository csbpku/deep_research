"""Shared Hugging Face endpoint and URL handling.

The public Hugging Face origin is not reachable from every deployment
network. Keep the visible/public URL stable while allowing operators to
route API and article fetches through a compatible mirror.
"""

from __future__ import annotations

import os
from urllib.parse import urlsplit, urlunsplit

PUBLIC_HUGGINGFACE_BASE_URL = "https://huggingface.co"


def huggingface_base_url() -> str:
    """Return the configured origin used for Hugging Face HTTP requests."""
    raw = os.environ.get(
        "HUGGINGFACE_BASE_URL",
        PUBLIC_HUGGINGFACE_BASE_URL,
    ).strip().rstrip("/")
    parsed = urlsplit(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return PUBLIC_HUGGINGFACE_BASE_URL
    return raw


def huggingface_endpoint(path: str) -> str:
    """Build a request URL while keeping path/query escaping untouched."""
    return f"{huggingface_base_url()}/{path.lstrip('/')}"


def rewrite_huggingface_url(url: str) -> str:
    """Route a public Hugging Face URL through the configured request origin."""
    parsed = urlsplit(url)
    if parsed.netloc.lower() not in {
        "huggingface.co",
        "www.huggingface.co",
    }:
        return url
    base = urlsplit(huggingface_base_url())
    return urlunsplit((
        base.scheme,
        base.netloc,
        parsed.path,
        parsed.query,
        parsed.fragment,
    ))


__all__ = [
    "PUBLIC_HUGGINGFACE_BASE_URL",
    "huggingface_base_url",
    "huggingface_endpoint",
    "rewrite_huggingface_url",
]
