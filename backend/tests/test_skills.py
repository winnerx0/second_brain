"""Tests for the skills loader.

The frontmatter parser is deliberately lax rather than a YAML parser, so its exact
tolerances are part of the contract: a stricter parser would start rejecting skill
files that work today.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from app.tools.skills import (
    build_skills_system_prompt,
    list_skills,
    load_skills,
    parse_frontmatter,
    read_skill,
)


def _write_skill(root: Path, folder: str, content: str) -> Path:
    directory = root / folder
    directory.mkdir(parents=True)
    path = directory / "SKILL.md"
    path.write_text(content, encoding="utf-8")
    return path


@pytest.fixture
def skills_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "skills"
    root.mkdir()
    monkeypatch.setenv("AGENT_SKILLS_DIR", str(root))
    from app.config import get_settings

    get_settings.cache_clear()
    return root


def test_parse_frontmatter_strips_one_layer_of_quotes() -> None:
    metadata, body = parse_frontmatter(
        "---\nname: \"my-skill\"\ndescription: 'Does a thing'\n---\n\nBody text here."
    )
    assert metadata == {"name": "my-skill", "description": "Does a thing"}
    assert body == "Body text here."


def test_parse_frontmatter_without_frontmatter() -> None:
    metadata, body = parse_frontmatter("  Just a body.  ")
    assert metadata == {}
    assert body == "Just a body."


def test_parse_frontmatter_ignores_unparseable_lines() -> None:
    """A line without `key: value` is skipped rather than failing the file."""
    metadata, _ = parse_frontmatter(
        "---\nname: ok\nthis line has no colon\n  - a list item\n---\nbody"
    )
    assert metadata == {"name": "ok"}


async def test_skill_without_name_or_description_is_skipped(skills_root: Path) -> None:
    _write_skill(skills_root, "good", "---\nname: good\ndescription: d\n---\nbody")
    _write_skill(skills_root, "nameless", "---\ndescription: d\n---\nbody")
    _write_skill(skills_root, "undescribed", "---\nname: x\n---\nbody")

    skills = await load_skills()
    assert [s.name for s in skills] == ["good"]


async def test_unknown_type_defaults_to_workflow(skills_root: Path) -> None:
    _write_skill(skills_root, "a", "---\nname: a\ndescription: d\ntype: nonsense\n---\nb")
    _write_skill(skills_root, "b", "---\nname: b\ndescription: d\ntype: PERSONALITY\n---\nb")
    _write_skill(skills_root, "c", "---\nname: c\ndescription: d\ntype: context\n---\nb")

    by_name = {s.name: s.type for s in await load_skills()}
    assert by_name == {"a": "workflow", "b": "personality", "c": "context"}


async def test_directories_without_skill_md_and_dotfiles_are_ignored(
    skills_root: Path,
) -> None:
    (skills_root / "empty-dir").mkdir()
    _write_skill(skills_root, ".hidden", "---\nname: hidden\ndescription: d\n---\nb")
    _write_skill(skills_root, "real", "---\nname: real\ndescription: d\n---\nb")

    assert [s.name for s in await load_skills()] == ["real"]


async def test_skills_are_sorted_case_insensitively(skills_root: Path) -> None:
    """`localeCompare` ignores case; a codepoint sort would put Zebra before apple."""
    _write_skill(skills_root, "z", "---\nname: Zebra\ndescription: d\n---\nb")
    _write_skill(skills_root, "a", "---\nname: apple\ndescription: d\n---\nb")

    assert [s.name for s in await load_skills()] == ["apple", "Zebra"]


async def test_multiple_directories_are_searched(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    first, second = tmp_path / "one", tmp_path / "two"
    first.mkdir()
    second.mkdir()
    _write_skill(first, "a", "---\nname: from-one\ndescription: d\n---\nb")
    _write_skill(second, "b", "---\nname: from-two\ndescription: d\n---\nb")

    monkeypatch.setenv("AGENT_SKILLS_DIRS", f"{first}{os.pathsep}{second}")
    from app.config import get_settings

    get_settings.cache_clear()

    assert [s.name for s in await load_skills()] == ["from-one", "from-two"]


async def test_system_prompt_composition(skills_root: Path) -> None:
    _write_skill(
        skills_root, "p", "---\nname: tone\ndescription: d\ntype: personality\n---\nBe terse."
    )
    _write_skill(
        skills_root, "c", "---\nname: stack\ndescription: d\ntype: context\n---\nUses Postgres."
    )
    _write_skill(skills_root, "w", "---\nname: emails\ndescription: Format emails.\n---\nSteps...")

    prompt = await build_skills_system_prompt()
    # Personality body is injected verbatim, first and unlabelled.
    assert prompt.startswith("Be terse.")
    # Context skills get a heading.
    assert "## stack\nUses Postgres." in prompt
    # Workflow skills appear only as a catalog line, not as their body.
    assert "- emails: Format emails." in prompt
    assert "Steps..." not in prompt
    assert "call read_skill with that skill name before acting" in prompt


async def test_system_prompt_is_empty_without_skills(skills_root: Path) -> None:
    assert await build_skills_system_prompt() == ""


async def test_list_and_read_skill_tools(skills_root: Path) -> None:
    _write_skill(skills_root, "e", "---\nname: emails\ndescription: Format emails.\n---\nDo this.")

    listed = json.loads(await list_skills.ainvoke({}))
    assert listed == [{"name": "emails", "type": "workflow", "description": "Format emails."}]

    # Name matching is case- and whitespace-insensitive.
    found = json.loads(await read_skill.ainvoke({"name": "  EMAILS "}))
    assert found == {
        "name": "emails",
        "description": "Format emails.",
        "instructions": "Do this.",
    }

    assert await read_skill.ainvoke({"name": "nope"}) == "Skill not found: nope"
