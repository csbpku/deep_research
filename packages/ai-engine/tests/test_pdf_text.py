from __future__ import annotations

import pytest

from ai_engine.fetcher.pdf_text import MAX_PDF_BYTES, MAX_PDF_PAGES, PdfReadError, read_pdf


def pdf_bytes(*, pages: int = 1, text: str = 'Verified research content.', encrypted: bool = False) -> bytes:
    import fitz  # type: ignore[import-untyped]

    with fitz.open() as doc:
        for _ in range(pages):
            page = doc.new_page()
            if text:
                page.insert_text((50, 50), text)
        if encrypted:
            return bytes(doc.tobytes(encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw='owner', user_pw='reader'))
        return bytes(doc.tobytes())


async def test_real_pdf_text_and_page_limit() -> None:
    result = await read_pdf(pdf_bytes())
    assert 'Verified research content.' in result.text and result.complete
    truncated = await read_pdf(pdf_bytes(pages=MAX_PDF_PAGES + 1))
    assert truncated.text.count('Verified research content.') == MAX_PDF_PAGES
    assert not truncated.complete


@pytest.mark.parametrize('kind,code', [
    ('html', 'SOURCE_INVALID_PDF'), ('broken', 'SOURCE_INVALID_PDF'),
    ('encrypted', 'SOURCE_PDF_ENCRYPTED'), ('scanned', 'SOURCE_PDF_NO_TEXT'),
    ('oversized', 'SOURCE_PDF_TOO_LARGE'),
])
async def test_pdf_failures_are_explicit(kind: str, code: str) -> None:
    data = {'html': lambda: b'<html>Access denied</html>', 'broken': lambda: b'%PDF-broken',
            'encrypted': lambda: pdf_bytes(encrypted=True), 'scanned': lambda: pdf_bytes(text=''),
            'oversized': lambda: b'%PDF-' + b'0' * MAX_PDF_BYTES}[kind]()
    with pytest.raises(PdfReadError) as caught:
        await read_pdf(data)
    assert caught.value.code == code
