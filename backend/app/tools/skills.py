"""Project-local skills — port of `src/tools/skills.ts`.

A skill is a `<dir>/<skill-name>/SKILL.md` file with frontmatter carrying `name`,
`description` and an optional `type`. Workflow skills are advertised to the agent as
a catalog it can `read_skill` from; personality and context skills are injected into
the system prompt directly.

The frontmatter parser is intentionally lax — a line-wise regex that strips one layer
of surrounding quotes. PyYAML would accept and reject a different set of files, so it
is deliberately not used here.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from app.config import get_settings
from app.logging import get_logger

logger = get_logger("skills")

SkillType = Literal["workflow", "personality", "context"]

_FRONTMATTER = re.compile(r"^---\s*\n(.*?)\n---\s*\n?", re.DOTALL)
_ENTRY = re.compile(r"^([A-Za-z0-9_-]+):\s*(.*)$")
_QUOTES = re.compile(r"^['\"]|['\"]$")


@dataclass(frozen=True)
class Skill:
    name: str
    description: str
    type: SkillType
    body: str
    file_path: Path


def skill_dirs() -> list[Path]:
    """`AGENT_SKILLS_DIRS` / `AGENT_SKILLS_DIR`, else `<cwd>/skills`.

    Multiple directories are separated by the platform path delimiter, as
    `path.delimiter` did.
    """
    settings = get_settings()
    configured = settings.AGENT_SKILLS_DIRS or settings.AGENT_SKILLS_DIR
    raw = configured.split(os.pathsep) if configured else [str(Path.cwd() / "skills")]
    return [Path(entry).resolve() for entry in raw if entry]


def parse_frontmatter(content: str) -> tuple[dict[str, str], str]:
    match = _FRONTMATTER.match(content)
    if match is None:
        return {}, content.strip()

    metadata: dict[str, str] = {}
    for line in (match.group(1) or "").split("\n"):
        entry = _ENTRY.match(line)
        if entry is None:
            continue
        key, raw_value = entry.group(1), entry.group(2) or ""
        metadata[key] = _QUOTES.sub("", raw_value).strip()

    return metadata, content[match.end() :].strip()


def _load_skill(path: Path) -> Skill | None:
    metadata, body = parse_frontmatter(path.read_text(encoding="utf-8"))
    name = (metadata.get("name") or "").strip()
    description = (metadata.get("description") or "").strip()
    if not name or not description:
        logger.warning("[skills] skipping %s: missing name or description", path)
        return None

    raw_type = (metadata.get("type") or "").strip().lower()
    skill_type: SkillType = raw_type if raw_type in ("personality", "context") else "workflow"  # type: ignore[assignment]
    return Skill(name=name, description=description, type=skill_type, body=body, file_path=path)


def _discover_skill_files() -> list[Path]:
    files: list[Path] = []
    for directory in skill_dirs():
        if not directory.is_dir():
            continue
        for entry in sorted(directory.iterdir()):
            if not entry.is_dir() or entry.name.startswith("."):
                continue
            candidate = entry / "SKILL.md"
            if candidate.is_file():
                files.append(candidate)
    return files


def _load_skills_sync() -> list[Skill]:
    skills: list[Skill] = []
    for path in _discover_skill_files():
        try:
            skill = _load_skill(path)
        except Exception as exc:
            logger.error("[skills] failed to load %s", path, exc_info=exc)
            continue
        if skill is not None:
            skills.append(skill)
    # `localeCompare` orders case-insensitively; plain codepoint sort would put every
    # capitalised name before every lower-case one.
    return sorted(skills, key=lambda skill: (skill.name.lower(), skill.name))


async def load_skills() -> list[Skill]:
    """Read every skill from disk. Off-thread, since this is blocking file I/O."""
    return await asyncio.to_thread(_load_skills_sync)


async def build_skills_system_prompt() -> str:
    """Compose the skills section appended to the agent's system prompt."""
    skills = await load_skills()
    if not skills:
        return ""

    parts: list[str] = []

    # Personality skills are injected verbatim — they shape the agent's voice.
    parts.extend(skill.body for skill in skills if skill.type == "personality")
    # Context skills get a heading so the model can tell them apart.
    parts.extend(f"## {skill.name}\n{skill.body}" for skill in skills if skill.type == "context")

    workflow_skills = [skill for skill in skills if skill.type == "workflow"]
    if workflow_skills:
        catalog = "\n".join(f"- {skill.name}: {skill.description}" for skill in workflow_skills)
        parts.append(
            "Skills:\n"
            "The user can add project-local skills as skills/<skill-name>/SKILL.md. "
            "A skill is a named workflow or domain guide.\n"
            "Available skills:\n"
            f"{catalog}\n\n"
            "When a request clearly matches a skill description, call read_skill with "
            "that skill name before acting. Use only the relevant skill body; do not "
            "mention skills or internal routing to the user."
        )

    return "\n\n".join(parts)


@tool("list_skills")
async def list_skills() -> str:
    """List available project-local skills and their trigger descriptions."""
    skills = await load_skills()
    return json.dumps(
        [
            {"name": skill.name, "type": skill.type, "description": skill.description}
            for skill in skills
        ],
        separators=(",", ":"),
        ensure_ascii=False,
    )


class ReadSkillArgs(BaseModel):
    name: str = Field(description="The skill name from the skill frontmatter.")


@tool("read_skill", args_schema=ReadSkillArgs)
async def read_skill(name: str) -> str:
    """Read the full instructions for a project-local skill by skill name."""
    skills = await load_skills()
    normalized = name.strip().lower()
    match = next((s for s in skills if s.name.lower() == normalized), None)
    if match is None:
        return f"Skill not found: {name}"
    return json.dumps(
        {
            "name": match.name,
            "description": match.description,
            "instructions": match.body,
        },
        separators=(",", ":"),
        ensure_ascii=False,
    )


skill_tools = [list_skills, read_skill]
