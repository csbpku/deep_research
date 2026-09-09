import asyncio
import json
from pathlib import Path

import pytest

from ai_engine.radar import zread_cli
from ai_engine.radar.zread_cli import (
    _generate_command,
    _work_dir,
    _read_generated_wiki,
    _read_wiki,
    generate_zread_wiki,
)


def test_work_dir_defaults_to_durable_user_cache(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("ZREAD_CLI_WORK_DIR", raising=False)
    assert Path(_work_dir()).name == "deep-research-zread"


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


def test_read_generated_wiki_merges_newer_draft_over_stale_current(
    tmp_path: Path,
) -> None:
    wiki = tmp_path / ".zread" / "wiki"
    version = wiki / "versions" / "old"
    version.mkdir(parents=True)
    (version / "1-overview.md").write_text(
        "# Overview\n\nOld content.", encoding="utf-8"
    )
    (version / "2-runtime.md").write_text(
        "# Runtime\n\nOld runtime.", encoding="utf-8"
    )
    (wiki / "current").write_text("versions/old\n", encoding="utf-8")

    drafts = wiki / "drafts"
    drafts.mkdir(parents=True)
    (drafts / "wiki.json").write_text(
        json.dumps(
            {
                "pages": [
                    {"slug": "1-overview", "file": "1-overview.md"},
                    {"slug": "2-runtime", "file": "2-runtime.md"},
                    {"slug": "3-new", "file": "3-new.md"},
                ]
            }
        ),
        encoding="utf-8",
    )
    (drafts / "1-overview.md").write_text(
        "# Overview\n\nFresh content.", encoding="utf-8"
    )
    (drafts / "2-runtime.md").write_text(
        "# Runtime\n\nFresh runtime.", encoding="utf-8"
    )
    (drafts / "3-new.md").write_text("# New\n\nNew page.", encoding="utf-8")

    pages, completeness, published = _read_generated_wiki(wiki)

    by_path = {page["path"]: page["content"] for page in pages}
    assert published is True
    assert len(pages) == 3
    assert completeness["expectedPageCount"] == 3
    assert completeness["coveredPageCount"] == 3
    assert completeness["missingPages"] == []
    assert by_path["1-overview.md"].endswith("Fresh content.")
    assert by_path["3-new.md"].endswith("New page.")


def test_catalog_gap_is_not_filled_by_an_unrelated_old_page(tmp_path: Path) -> None:
    drafts = tmp_path / "drafts"
    drafts.mkdir()
    (drafts / "wiki.json").write_text(json.dumps({"pages": [
        {"slug": "1-overview", "file": "1-overview.md"},
        {"slug": "2-runtime", "file": "2-runtime.md"},
    ]}))
    (drafts / "1-overview.md").write_text("# Overview\n\nContent")
    (drafts / "1-old-overview.md").write_text("# Old overview\n\nDifferent outline")

    pages, completeness = _read_wiki(drafts)

    assert len(pages) == completeness["expectedPageCount"] == 2
    assert completeness["coveredPageCount"] == 1
    assert completeness["missingPages"] == ["2-runtime.md"]
    assert completeness["uncatalogedPages"] == ["1-old-overview.md"]


@pytest.mark.asyncio
async def test_checkout_resolves_relative_work_dir_before_cloning(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    monkeypatch.chdir(tmp_path)

    async def fake_run(*args: str, cwd: Path, timeout: float | None) -> tuple[int, str, str]:
        assert cwd.is_absolute()
        if args[1] == "clone":
            assert Path(args[-1]).is_absolute()
            (Path(args[-1]) / ".git").mkdir(parents=True)
            return 0, "", ""
        assert args[1] == "rev-parse"
        return 0, "abc1234\n", ""

    monkeypatch.setattr(zread_cli, "_run", fake_run)
    checkout = await zread_cli.prepare_zread_checkout(
        owner="example", repo="repo", branch="main", commit_sha="abc1234",
        work_dir=Path("reports/repair"),
    )
    assert checkout == tmp_path / "reports/repair/example__repo__abc1234/repo"


@pytest.mark.asyncio
async def test_generate_preserves_draft_pages_when_outer_timeout_cancels(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("ZREAD_CLI_WORK_DIR", str(tmp_path))

    async def fake_run(*args: str, cwd: Path, timeout: float | None) -> tuple[int, str, str]:
        if args[0] == "git":
            if args[1] == "clone":
                (cwd / "repo" / ".git").mkdir(parents=True)
                return 0, "", ""
            if args[1] == "rev-parse":
                return 0, "abc1234\n", ""
            raise AssertionError(args)
        checkout = cwd
        drafts = checkout / ".zread" / "wiki" / "drafts"
        drafts.mkdir(parents=True)
        (drafts / "1-overview.md").write_text(
            "# Overview\n\nGenerated before timeout.", encoding="utf-8"
        )
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


@pytest.mark.asyncio
async def test_generate_resumes_durable_checkout_with_draft_resume(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    calls: list[tuple[str, ...]] = []
    monkeypatch.setenv("ZREAD_CLI_WORK_DIR", str(tmp_path))

    async def fake_run(*args: str, cwd: Path, timeout: float | None) -> tuple[int, str, str]:
        del timeout
        calls.append(args)
        if args[0] == "git":
            if args[1] == "clone":
                (cwd / "repo" / ".git").mkdir(parents=True)
                return 0, "", ""
            if args[1] == "rev-parse":
                return 0, "abc1234\n", ""
            raise AssertionError(args)
        wiki = cwd / ".zread" / "wiki"
        if "--draft" not in args:
            drafts = wiki / "drafts"
            drafts.mkdir(parents=True)
            (drafts / "1-overview.md").write_text(
                "# Overview\n\nGenerated before timeout.", encoding="utf-8"
            )
            raise asyncio.CancelledError
        version = wiki / "versions" / "resumed"
        version.mkdir(parents=True)
        (version / "1-overview.md").write_text(
            "# Overview\n\nExisting page.", encoding="utf-8"
        )
        (version / "2-architecture.md").write_text(
            "# Architecture\n\nNewly resumed page.", encoding="utf-8"
        )
        (wiki / "current").write_text("versions/resumed\n", encoding="utf-8")
        return 0, "", ""

    monkeypatch.setattr(zread_cli, "_binary", lambda: "zread")
    monkeypatch.setattr(zread_cli, "_run", fake_run)

    first = await generate_zread_wiki(
        owner="example",
        repo="repo",
        branch="main",
        commit_sha="abc1234",
    )
    second = await generate_zread_wiki(
        owner="example",
        repo="repo",
        branch="main",
        commit_sha="abc1234",
    )

    assert first is not None and first["status"] == "partial"
    assert second is not None and second["status"] == "complete"
    assert second["pageCount"] == 2
    assert not any("--draft" in call for call in calls[:1])
    assert any("--draft" in call and "resume" in call for call in calls)
