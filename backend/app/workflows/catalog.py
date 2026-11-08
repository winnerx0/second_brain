from __future__ import annotations

from typing import Any

from langchain_core.tools import BaseTool

from app.errors import BadRequestError
from app.tools.anilist import anilist_tools
from app.tools.calendar import calendar_tools
from app.tools.clickup import clickup_tools
from app.tools.github import github_tools
from app.tools.gmail import gmail_tools
from app.tools.google_docs import google_doc_tools
from app.tools.knowledge_graph import knowledge_graph_tools
from app.tools.notion import notion_tools
from app.tools.spotify import spotify_tools
from app.tools.tavily import tavily_tools
from app.tools.twitter import twitter_tools
from app.workflows.types import Definition, is_read_tool

#: specialist -> its tools. Add an entry as each provider module lands.
TOOL_GROUPS: dict[str, list[BaseTool]] = {
    "github": list(github_tools),
    "calendar": list(calendar_tools),
    "gmail": list(gmail_tools),
    "docs": list(google_doc_tools),
    "anilist": list(anilist_tools),
    "knowledge_graph": list(knowledge_graph_tools),
    "notion": list(notion_tools),
    "clickup": list(clickup_tools),
    "spotify": list(spotify_tools),
    "twitter": list(twitter_tools),
    "web_search": list(tavily_tools),
}

#: Specialists expected to have tool groups. Any of these missing
#: from TOOL_GROUPS is simply not available yet.
EXPECTED_TOOL_GROUPS = (
    "github",
    "gmail",
    "calendar",
    "docs",
    "notion",
    "clickup",
    "spotify",
    "twitter",
    "anilist",
    "knowledge_graph",
    "web_search",
)

#: Specialists with no tool group of their own.
#: `synthesis` reasons over dependency outputs and may not call tools at all;
#: `telegram` has exactly one authorized delivery action.
TELEGRAM_TOOLS = ("send_telegram_message",)


def unported_specialists() -> list[str]:
    return [name for name in EXPECTED_TOOL_GROUPS if name not in TOOL_GROUPS]


def _parameters(tool: BaseTool) -> Any:
    """The tool's argument JSON Schema, or a fallback string."""
    try:
        return tool.tool_call_schema.model_json_schema()
    except Exception:
        return "Consult the tool description"


def capability_catalog() -> list[dict[str, Any]]:
    """Every specialist's tools, with names, descriptions and argument schemas."""
    return [
        {
            "specialist": specialist,
            "tools": [
                {
                    "name": tool.name,
                    "description": tool.description,
                    "readOnly": is_read_tool(tool.name),
                    "parameters": _parameters(tool),
                }
                for tool in tools
            ],
        }
        for specialist, tools in TOOL_GROUPS.items()
    ]


def validate_capabilities(definition: Definition) -> None:
    """Refuse permissions naming tools the step's specialist does not have."""
    for step in definition.steps:
        if step.specialist == "telegram":
            names: list[str] = list(TELEGRAM_TOOLS)
        elif step.specialist == "synthesis":
            names = []
        else:
            group = TOOL_GROUPS.get(step.specialist)
            if group is None:
                raise BadRequestError(
                    f"The {step.specialist} specialist is not available in this "
                    "build yet; its tools are not available."
                )
            names = [tool.name for tool in group]

        for permission in step.permissions:
            if permission.tool not in names:
                raise BadRequestError(f"Unknown {step.specialist} capability: {permission.tool}")

        # Telegram delivery must have something to deliver, and must be explicitly
        # authorized — otherwise a workflow could acquire an outbound message step.
        if step.specialist == "telegram" and (
            not step.dependsOn
            or not any(p.tool == "send_telegram_message" for p in step.permissions)
        ):
            raise BadRequestError(
                "Telegram requires an authorized delivery action and an input step"
            )
