import asyncio
from pathlib import Path

import pytest

from ai_engine.radar import zread_cli
from ai_engine.radar.zread_cli import (
    _generate_command,
    _read_generated_wiki,
    _read_wiki,
    generate_zread_wiki,
)


def test_generate_command_is_strict() -> None:
    assert _generate_command("zread") == ("zread", "generate", "-y", "--stdio")
    assert "--skip-failed" not in _generate_command("zread")


def test_read_wiki_resolves_current_pointer(tmp_path: Path) -> None:
    wiki = tmp_path / ".zread" / "wiki"
    version = wiki / "versions" / "2026-08-20-153736"
    version.mkdir(parents=True)
    (version / "overview.md").write_text("# Overview\n\nReal generated page.", encoding="utf-8")
    (version / "architecture.md").write_text("# Architecture\n\nComponents.", encoding="utf-8")
    (wiki / "current").write_text("versions/2026-08-20-153736\n", encoding="utf-8")

    pages, completeness = _read_wiki(wiki / "current")

    assert [page["path"] for page in pages] == ["architecture.md", "overview.md"]
    assert completeness["expectedPageCount"] == 2


def test_read_wiki_does_not_treat_pointer_as_page(tmp_path: Path) -> None:
    current = tmp_path / "current"
    current.write_text("versions/missing\n", encoding="utf-8")

    pages, completeness = _read_wiki(current)

    assert pages == []
    assert completeness["expectedPageCount"] == 0


def test_read_wiki_preserves_zread_catalog_hierarchy(tmp_path: Path) -> None:
    wiki = tmp_path / ".zread" / "wiki"
    drafts = wiki / "drafts"
    drafts.mkdir(parents=True)
    (drafts / "1-overview.md").write_text("# Wrong title\n\nContent.", encoding="utf-8")
    (drafts / "2-architecture.md").write_text("# Architecture\n\nContent.", encoding="utf-8")
    (drafts / "wiki.json").write_text(
        (
            '{"pages":['
            '{"slug":"1-overview","title":"Overview: The Kernel",'
            '"file":"1-overview.md","section":"Get Started","level":"Beginner"},'
            '{"slug":"2-architecture","title":"Architecture",'
            '"file":"2-architecture.md","section":"Deep Dive",'
            '"group":"Runtime","level":"Intermediate"}'
            ']}'
        ),
        encoding="utf-8",
    )

    pages, _ = _read_wiki(drafts)

    assert pages[0]["title"] == "Overview: The Kernel"
    assert pages[0]["section"] == "Get Started"
    assert pages[0]["level"] == "Beginner"
    assert pages[1]["section"] == "Deep Dive"
    assert pages[1]["group"] == "Runtime"


def test_read_generated_wiki_uses_drafts_before_current_is_published(tmp_path: Path) -> None:
    wiki = tmp_path / ".zread" / "wiki"
    drafts = wiki / "drafts"
    drafts.mkdir(parents=True)
    (drafts / "1-overview.md").write_text("# Overview\n\nPartial page.", encoding="utf-8")

    pages, completeness, published = _read_generated_wiki(wiki)

    assert published is False
    assert pages[0]["path"] == "1-overview.md"
    assert completeness["expectedPageCount"] == 1


@pytest.mark.asyncio
async def test_generate_preserves_draft_pages_when_outer_timeout_cancels(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_run(*args: str, cwd: Path, timeout: float | None) -> tuple[int, str, str]:
        if args[0] == "git":
            checkout = cwd / "repo"
            drafts = checkout / ".zread" / "wiki" / "drafts"
            drafts.mkdir(parents=True)
            (drafts / "1-overview.md").write_text(
                "# Overview\n\nGenerated before timeout.", encoding="utf-8"
            )
            return 0, "", ""
        raise asyncio.CancelledError

    monkeypatch.setattr(zread_cli, "_binary", lambda: "zread")
    monkeypatch.setattr(zread_cli, "_run", fake_run)

    payload = await generate_zread_wiki(
        owner="example",
        repo="repo",
        branch="main",
        commit_sha="abc1234",
    )

    assert payload is not None
    assert payload["provider"] == "zread-cli"
    assert payload["status"] == "partial"
    assert payload["pageCount"] == 1
    assert payload["pages"][0]["title"] == "Overview"
