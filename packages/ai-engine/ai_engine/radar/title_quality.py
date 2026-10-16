"""Recognize exact navigation labels without rejecting article titles about them."""
from __future__ import annotations

import html
import re


def is_navigation_title(value: str) -> bool:
    normalized = re.sub(r'\s+', ' ', html.unescape(value)).strip().casefold()
    return normalized in {'skip to main content', 'skip to content'}
