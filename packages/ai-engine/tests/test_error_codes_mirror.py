"""Keep the Python error-code mirror identical to packages/shared/src/errors.ts."""

from __future__ import annotations

import re
from pathlib import Path

from ai_engine.contracts.errors import ERROR_CODES, HTTP_STATUS

ERRORS_TS = Path(__file__).resolve().parents[3] / "packages" / "shared" / "src" / "errors.ts"


def _ts_error_codes() -> dict[str, str]:
    text = ERRORS_TS.read_text(encoding="utf-8")
    match = re.search(r"export const ERROR_CODES = \{(.*?)\n\} as const;", text, re.S)
    assert match, "ERROR_CODES block not found in errors.ts"
    return dict(re.findall(r"^\s*([A-Z][A-Z0-9_]*):\s*'([A-Z][A-Z0-9_]*)',?\s*(?://.*)?$", match.group(1), re.M))


def test_python_error_codes_match_typescript() -> None:
    ts_codes = _ts_error_codes()
    assert ts_codes, "no codes parsed from errors.ts"
    assert all(k == v for k, v in ts_codes.items()), "TS code key and value must be identical"
    assert dict(ERROR_CODES) == ts_codes, (
        f"only in TS: {sorted(set(ts_codes) - set(ERROR_CODES))}; "
        f"only in Python: {sorted(set(ERROR_CODES) - set(ts_codes))}"
    )


def test_every_python_code_has_http_status() -> None:
    assert set(HTTP_STATUS) == set(ERROR_CODES)
