from pathlib import Path

from ai_engine.radar.zread_cli import _generate_command, _read_wiki


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
