"""Transient PDF extraction in a credential-free, resource-bounded child process."""
from __future__ import annotations

import asyncio
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path

MAX_PDF_BYTES = 12 * 1024 * 1024
MAX_PDF_PAGES = 80
MAX_PDF_CHARS = 200_000


class PdfReadError(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class PdfText:
    text: str
    complete: bool


async def read_pdf(data: bytes) -> PdfText:
    if len(data) > MAX_PDF_BYTES:
        raise PdfReadError('SOURCE_PDF_TOO_LARGE')
    if not data.startswith(b'%PDF-'):
        raise PdfReadError('SOURCE_INVALID_PDF')
    child = await asyncio.create_subprocess_exec(
        sys.executable, '-m', 'ai_engine.fetcher.pdf_text',
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        env={'PYTHONPATH': str(Path(__file__).resolve().parents[2])},
    )
    try:
        async with asyncio.timeout(12):
            stdout, _ = await child.communicate(data)
    except BaseException:
        if child.returncode is None:
            child.kill()
        await child.wait()
        raise
    if child.returncode != 0:
        code = {2: 'SOURCE_INVALID_PDF', 3: 'SOURCE_PDF_ENCRYPTED',
                4: 'SOURCE_PDF_NO_TEXT'}.get(child.returncode or -1, 'SOURCE_PDF_EXTRACTION_FAILED')
        raise PdfReadError(code)
    try:
        payload = json.loads(stdout)
        text = payload['text']
        complete = payload['complete']
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_PDF_CHARS or type(complete) is not bool:
            raise ValueError('invalid extractor output')
    except (ValueError, KeyError, TypeError):
        raise PdfReadError('SOURCE_PDF_EXTRACTION_FAILED') from None
    return PdfText(text, complete)


def _main() -> None:
    import resource

    # No credentials, source files, external commands or PDF actions are used.
    # Linux production additionally caps address space; macOS has different AS
    # accounting, so its development tests use the same CPU/page/text deadlines.
    if sys.platform == 'linux':
        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CPU, (6, 6))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
    import fitz  # type: ignore[import-untyped]

    data = sys.stdin.buffer.read(MAX_PDF_BYTES + 1)
    if len(data) > MAX_PDF_BYTES or not data.startswith(b'%PDF-'):
        raise SystemExit(2)
    try:
        with fitz.open(stream=data, filetype='pdf') as doc:
            if doc.needs_pass:
                raise SystemExit(3)
            chunks: list[str] = []
            chars = 0
            complete = len(doc) <= MAX_PDF_PAGES
            for index in range(min(len(doc), MAX_PDF_PAGES)):
                page = str(doc[index].get_text('text') or '').replace('\x00', '')
                complete = complete and bool(page.strip())
                remaining = MAX_PDF_CHARS - chars
                chunks.append(page[:remaining])
                chars += len(chunks[-1])
                if len(page) > remaining or (chars == MAX_PDF_CHARS and index + 1 < len(doc)):
                    complete = False
                    break
            text = ''.join(chunks).strip()
            if not text:
                raise SystemExit(4)
    except Exception:
        raise SystemExit(2) from None
    sys.stdout.write(json.dumps({'text': text, 'complete': complete}))


if __name__ == '__main__':
    # Keep the worker independent of the business process and its environment.
    os.umask(0o077)
    _main()
