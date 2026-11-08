from __future__ import annotations

from functools import lru_cache
from typing import Any

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from app.agent.subagents.base import make_subagent, run_subagent
from app.tools.github import (
    close_issue,
    create_issue,
    create_pull_request,
    delete_issue,
    get_assigned_issues,
    get_commits,
    get_open_prs,
    get_pull_request,
    merge_pull_request,
)

GITHUB_SYSTEM_PROMPT = """You are a GitHub Assistant with access to the user's GitHub account.

You can:
- Fetch open pull requests, assigned issues, and commits (with full messages) in any date/time range — defaults to the last 24 hours
- Create, close, and delete issues

When helping:
- Always use real data from tools, never guess or fabricate
- For destructive operations (close, delete), identify the correct repo and issue number, then ask for confirmation before acting
- If a tool returns an Error/Failed result, report that failure instead of treating it as success
- Return concise, structured summaries of results"""

_GITHUB_TOOLS = [
    get_open_prs,
    get_assigned_issues,
    get_commits,
    create_issue,
    close_issue,
    delete_issue,
    create_pull_request,
    get_pull_request,
    merge_pull_request,
]


@lru_cache(maxsize=1)
def _agent() -> Any:
    return make_subagent(_GITHUB_TOOLS)


class GitHubArgs(BaseModel):
    query: str = Field(
        description=(
            "Natural language request for GitHub operations (e.g., 'List my open PRs', "
            "'Create an issue in second-brain titled Fix login bug', 'What did I push today?')"
        )
    )


@tool("github", args_schema=GitHubArgs)
async def github_tool(query: str) -> str:
    """Fetch GitHub data (open PRs, assigned issues, commits in any date/time range) or manage issues (create, close, delete)."""
    return await run_subagent(
        _agent(),
        [
            {"role": "system", "content": GITHUB_SYSTEM_PROMPT},
            {"role": "user", "content": query},
        ],
        "github",
    )
