import json
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest

from scripts import repair_zread_page_gaps as repair


def test_seeding_only_uses_exact_catalog_paths(tmp_path: Path) -> None:
    drafts = tmp_path / ".zread" / "wiki" / "drafts"
    drafts.mkdir(parents=True)
    (drafts / "wiki.json").write_text(json.dumps({"pages": [
        {"file": "1-overview.md", "slug": "1-overview"},
        {"file": "2-runtime.md", "slug": "2-runtime"},
    ]}))
    (drafts / "1-overview.md").write_text("Newly generated")
    written = repair._seed_db_pages(tmp_path, {"pages": [
        {"path": "1-overview.md", "content": "Old"},
        {"path": "2-runtime.md", "content": "Runtime"},
        {"path": "1-old-overview.md", "content": "Another outline"},
        {"path": "../outside.md", "content": "Unsafe"},
    ]})
    assert written == 1
    assert (drafts / "1-overview.md").read_text() == "Newly generated"
    assert (drafts / "2-runtime.md").read_text() == "Runtime"
    assert not (drafts / "1-old-overview.md").exists()
    assert not (drafts.parent / "outside.md").exists()


def test_no_catalog_means_no_seeding_or_inferred_page_count(tmp_path: Path) -> None:
    drafts = tmp_path / ".zread" / "wiki" / "drafts"
    drafts.mkdir(parents=True)
    (drafts / "1-overview.md").write_text("Existing")
    assert repair._catalog_page_count(tmp_path) == 0
    assert repair._seed_db_pages(tmp_path, {"pages": [
        {"path": "2-runtime.md", "content": "Runtime"},
    ]}) == 0


def test_recover_catalog_requires_unambiguous_corroborated_links() -> None:
    payload = {
        "expectedPageCount": 3, "commitSha": "abc",
        "pages": [
            {"path": "1-overview.md", "title": "Overview", "content": "[Runtime](2-runtime)"},
            {"path": "3-tests.md", "title": "Tests", "content": "[Runtime](2-runtime)"},
        ],
    }
    result = repair._recover_catalog_from_links(payload)
    assert result is not None
    assert [page["file"] for page in result["pages"]] == [
        "1-overview.md", "2-runtime.md", "3-tests.md",
    ]
    assert result["recovery"]["missingPages"][0]["referencedBy"] == [
        "1-overview.md", "3-tests.md",
    ]
    payload["pages"][1]["content"] = "[Other runtime](2-other-runtime)"
    assert repair._recover_catalog_from_links(payload) is None


def test_recovery_refuses_multiple_outlines() -> None:
    assert repair._recover_catalog_from_links({
        "expectedPageCount": 3, "pages": [
            {"path": "1-overview.md", "content": "[Runtime](2-runtime)"},
            {"path": "1-another-overview.md", "content": "[Runtime](2-runtime)"},
        ],
    }) is None


def test_retained_pages_do_not_hide_a_catalog_gap() -> None:
    result = repair._with_catalog_coverage({
        "status": "complete", "catalogPaths": ["1-overview.md", "2-runtime.md"],
        "pages": [
            {"path": "1-overview.md", "content": "Current"},
            {"path": "1-old-overview.md", "content": "Old but retained"},
        ],
    })
    assert result["status"] == "partial"
    assert result["pageCount"] == 2
    assert result["expectedPageCount"] == 3
    assert result["coveredPageCount"] == 1
    assert result["catalogPageCount"] == 2
    assert result["retainedPageCount"] == 1
    assert result["missingPages"] == ["2-runtime.md"]


class RepairPool:
    def __init__(self, rowcounts: list[int]) -> None:
        self.rowcounts = iter(rowcounts)
        self.queries: list[tuple[str, tuple]] = []

    @asynccontextmanager
    async def connection(self):
        yield self

    async def execute(self, query: str, params: tuple):
        self.queries.append((query, params))
        return SimpleNamespace(rowcount=next(self.rowcounts))


@pytest.mark.asyncio
async def test_snapshot_conflict_stops_before_quality_or_review(monkeypatch: pytest.MonkeyPatch) -> None:
    async def unexpected(*args, **kwargs):
        raise AssertionError("Must not review a rejected snapshot")

    monkeypatch.setattr(repair, "load_and_persist_reader_quality", unexpected)
    pool = RepairPool([0])
    with pytest.raises(RuntimeError, match="repairable state"):
        await repair._persist_snapshot(pool, row={
            "id": "summary", "originalMeta": {"zread": {}}, "originalSha256": "before",
        }, zread={"status": "partial", "pages": [{"path": "1.md", "content": "Content"}]})
    query, params = pool.queries[0]
    assert '"originalMeta" IS NOT DISTINCT FROM %s::jsonb' in query
    assert params[-1] == "before"


@pytest.mark.asyncio
async def test_source_finalization_rejects_a_concurrent_snapshot(monkeypatch: pytest.MonkeyPatch) -> None:
    async def quality(*args, **kwargs):
        return SimpleNamespace(ready=True, status="ready")

    async def review(*args, **kwargs):
        raise AssertionError("Must not review a superseded snapshot")

    monkeypatch.setattr(repair, "load_and_persist_reader_quality", quality)
    monkeypatch.setattr(repair, "finalize_enrichment", review)
    pool = RepairPool([1, 0])
    with pytest.raises(RuntimeError, match="changed before source finalization"):
        await repair._persist_snapshot(pool, row={"id": "summary"}, zread={
            "status": "complete", "pageCount": 1, "expectedPageCount": 1,
            "pages": [{"path": "1.md", "content": "Content"}],
        })
    assert '"originalMeta" IS NOT DISTINCT FROM %s::jsonb' in pool.queries[1][0]


@pytest.mark.asyncio
async def test_source_ready_is_saved_before_independent_review(monkeypatch: pytest.MonkeyPatch) -> None:
    pool = RepairPool([1, 1])

    async def quality(*args, **kwargs):
        return SimpleNamespace(ready=True, status="ready")

    async def review(*args, **kwargs):
        assert len(pool.queries) == 2
        assert pool.queries[1][1][0] == "ready"
        raise TimeoutError("Review unavailable")

    monkeypatch.setattr(repair, "load_and_persist_reader_quality", quality)
    monkeypatch.setattr(repair, "finalize_enrichment", review)
    result = await repair._persist_snapshot(pool, row={"id": "summary"}, zread={
        "status": "complete", "pageCount": 1, "expectedPageCount": 1,
        "pages": [{"path": "1.md", "content": "Content"}],
    })
    assert result["status"] == "ready"
    assert result["reviewError"] == "TimeoutError: Review unavailable"
    assert len(pool.queries) == 2
