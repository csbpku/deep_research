"""Python mirror of the browser-reading request/result contract.

The Web BFF validates the public payload with the shared TypeScript schema.
These models keep the engine boundary explicit for tests and future streaming
adapters without treating page text as a trusted instruction source.
"""

from __future__ import annotations

from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class SourceAnchor(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    quote: str = Field(min_length=1, max_length=12_000)
    prefix: str = Field(default="", max_length=500)
    suffix: str = Field(default="", max_length=500)
    start_offset: int | None = Field(default=None, ge=0, alias="startOffset")
    end_offset: int | None = Field(default=None, ge=0, alias="endOffset")
    content_hash: str | None = Field(
        default=None,
        pattern=r"^[a-f0-9]{64}$",
        alias="contentHash",
    )
    selector_path: str | None = Field(default=None, max_length=1000, alias="selectorPath")

    @model_validator(mode="after")
    def ordered_offsets(self) -> "SourceAnchor":
        if (
            self.start_offset is not None
            and self.end_offset is not None
            and self.end_offset < self.start_offset
        ):
            raise ValueError("锚点结束位置不能早于开始位置")
        return self


class ReadingDocument(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    url: str = Field(max_length=2048)
    title: str = Field(max_length=300)
    version: str | None = Field(default=None, max_length=128)

    @field_validator("url")
    @classmethod
    def http_url_only(cls, value: str) -> str:
        if urlsplit(value).scheme not in {"http", "https"}:
            raise ValueError("原网页阅读只支持 HTTP(S) 页面")
        return value


class ReadingContext(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    url: str = Field(max_length=2048)
    title: str = Field(default="当前网页", max_length=300)
    language: str = Field(default="zh-CN", max_length=20)
    scope: Literal["selection", "section", "page"] = "selection"
    body: str = Field(min_length=1, max_length=256_000)
    section: str | None = Field(default=None, max_length=80_000)
    selection: SourceAnchor | None = None

    @field_validator("url")
    @classmethod
    def http_url_only(cls, value: str) -> str:
        if urlsplit(value).scheme not in {"http", "https"}:
            raise ValueError("原网页阅读只支持 HTTP(S) 页面")
        return value

    @model_validator(mode="after")
    def selection_scope_requires_anchor(self) -> "ReadingContext":
        # Keep the Python mirror aligned with the shared TypeScript boundary:
        # a selection-scoped request must not silently widen to the page.
        if self.scope == "selection" and self.selection is None:
            raise ValueError("选段范围需要提供原文锚点")
        return self


class Annotation(BaseModel):
    """A private reading note tied to a source anchor."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    id: str = Field(min_length=1, max_length=160)
    document: ReadingDocument
    anchor: SourceAnchor
    note: str = Field(default="", max_length=8_000)
    created_at: str = Field(alias="createdAt")
    updated_at: str | None = Field(default=None, alias="updatedAt")


class ReadingCitation(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    quote: str = Field(min_length=1, max_length=12_000)
    url: str = Field(max_length=2048)
    anchor: SourceAnchor | None = None


class ReadingEvidence(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    quote: str = Field(min_length=1, max_length=12_000)
    claim: str = Field(default="", max_length=4_000)
    anchor: SourceAnchor | None = None


class ReadingAnswer(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    answer: str = Field(max_length=20_000)
    background: str = Field(default="", max_length=12_000)
    inference: str = Field(default="", max_length=12_000)
    limitations: list[str] = Field(default_factory=list, max_length=8)
    evidence: list[ReadingEvidence] = Field(default_factory=list, max_length=8)
    citations: list[ReadingCitation] = Field(default_factory=list, max_length=24)
    warnings: list[str] = Field(default_factory=list, max_length=20)
    structured: bool = False


class ReadingResult(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    operation: Literal["ask", "explain", "translate"]
    original: str
    suggestion: str | None = None
    reading: ReadingAnswer | None = None
    citations: list[ReadingCitation] = Field(default_factory=list, max_length=24)
    warnings: list[str] = Field(default_factory=list, max_length=20)
    truncated: bool = False
