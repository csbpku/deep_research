import pytest
from pydantic import ValidationError

from ai_engine.contracts.reading import Annotation, ReadingContext, SourceAnchor


def test_reading_context_accepts_camel_case_anchor_fields() -> None:
    context = ReadingContext.model_validate({
        "url": "https://example.com/docs",
        "body": "A paragraph from the original page.",
        "selection": {
            "quote": "A paragraph",
            "startOffset": 0,
            "endOffset": 12,
            "contentHash": "a" * 64,
        },
    })
    assert context.selection is not None
    assert context.selection.start_offset == 0


def test_reading_context_rejects_non_http_sources() -> None:
    with pytest.raises(ValidationError):
        ReadingContext(url="file:///tmp/page", body="local page")


def test_selection_scope_requires_anchor() -> None:
    with pytest.raises(ValidationError, match="选段范围"):
        ReadingContext(url="https://example.com/docs", body="text", scope="selection")

    context = ReadingContext(
        url="https://example.com/docs",
        body="text",
        scope="page",
    )
    assert context.selection is None


def test_anchor_rejects_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        SourceAnchor(quote="quote", unexpected="value")


def test_anchor_rejects_reversed_offsets() -> None:
    with pytest.raises(ValidationError):
        SourceAnchor(quote="quote", startOffset=8, endOffset=2)


def test_annotation_keeps_document_and_anchor_together() -> None:
    annotation = Annotation.model_validate({
        "id": "annotation-1",
        "document": {
            "url": "https://example.com/docs",
            "title": "Docs",
            "version": "sha256:test",
        },
        "anchor": {"quote": "A paragraph", "prefix": "The ", "suffix": " context."},
        "note": "Check this assumption later.",
        "createdAt": "2026-09-21T00:00:00Z",
    })
    assert annotation.document.url == "https://example.com/docs"
    assert annotation.anchor.quote == "A paragraph"


def test_annotation_rejects_non_http_document_and_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        Annotation.model_validate({
            "id": "annotation-1",
            "document": {"url": "file:///tmp/page", "title": "Local"},
            "anchor": {"quote": "text"},
            "createdAt": "2026-09-21T00:00:00Z",
        })
    with pytest.raises(ValidationError):
        Annotation.model_validate({
            "id": "annotation-1",
            "document": {"url": "https://example.com/docs", "title": "Docs"},
            "anchor": {"quote": "text"},
            "createdAt": "2026-09-21T00:00:00Z",
            "unexpected": True,
        })
