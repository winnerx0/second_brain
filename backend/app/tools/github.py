from __future__ import annotations

import datetime as dt
from typing import Any, Literal

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from app.config import get_settings
from app.http import get_client
from app.json import dumps, js_date
from app.logging import get_logger
from app.oauth import get_valid_token

logger = get_logger("github")


async def _token() -> str:
    token = await get_valid_token("github")
    return token or get_settings().GITHUB_TOKEN


async def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {await _token()}",
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "second-brain-agent",
    }


def _summarize_search_item(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "title": item["title"],
        "repo": "/".join(item["repository_url"].split("/")[-2:]),
        "createdAt": item["created_at"],
        "url": item["html_url"],
    }


@tool("get_open_prs")
async def get_open_prs() -> str:
    """Get all open pull requests authored by the user across all repos."""
    try:
        username = get_settings().GITHUB_USERNAME
        response = await get_client().get(
            "https://api.github.com/search/issues",
            params={"q": f"author:{username} type:pr state:open"},
            headers=await _headers(),
        )
        data = response.json()
        items = data.get("items") or []
        return dumps([_summarize_search_item(item) for item in items])
    except Exception as exc:
        logger.error("[github]", exc_info=exc)
        return f"Error fetching open PRs: {exc}"


@tool("get_assigned_issues")
async def get_assigned_issues() -> str:
    """Get all open issues assigned to the user."""
    try:
        username = get_settings().GITHUB_USERNAME
        response = await get_client().get(
            "https://api.github.com/search/issues",
            params={"q": f"is:issue assignee:{username} state:open"},
            headers=await _headers(),
        )
        data = response.json()
        items = data.get("items") or []
        logger.info("[github] fetched %d assigned issues", len(items))
        return dumps([_summarize_search_item(item) for item in items])
    except Exception as exc:
        logger.error("[github]", exc_info=exc)
        return f"Error fetching assigned issues: {exc}"


class CreateIssueArgs(BaseModel):
    repo: str = Field(description='Repository name (e.g. "second-brain")')
    title: str = Field(description="Issue title")
    body: str | None = Field(default=None, description="Issue body / description (markdown)")
    labels: list[str] | None = Field(
        default=None, description='Labels to apply (e.g. ["bug", "enhancement"])'
    )
    owner: str | None = Field(
        default=None, description="Repo owner — omit to use your own username"
    )


@tool("create_issue", args_schema=CreateIssueArgs)
async def create_issue(
    repo: str,
    title: str,
    body: str | None = None,
    labels: list[str] | None = None,
    owner: str | None = None,
) -> str:
    """Open a new GitHub issue on a specified repository. Owner defaults to the authenticated user."""
    try:
        settings = get_settings()
        repo_owner = owner or settings.GITHUB_USERNAME
        payload: dict[str, Any] = {"title": title, "assignees": [settings.GITHUB_USERNAME]}
        if body:
            payload["body"] = body
        if labels:
            payload["labels"] = labels

        response = await get_client().post(
            f"https://api.github.com/repos/{repo_owner}/{repo}/issues",
            headers={**(await _headers()), "Content-Type": "application/json"},
            json=payload,
        )
        if response.is_error:
            return f"Failed to create issue ({response.status_code}): {response.text}"

        data = response.json()
        return f"Issue #{data['number']} created: {data['html_url']}"
    except Exception as exc:
        logger.error("[github]", exc_info=exc)
        return f"Error creating issue: {exc}"


class CloseIssueArgs(BaseModel):
    repo: str = Field(description='Repository name (e.g. "second-brain")')
    issue_number: int = Field(description="Issue number to close")
    owner: str | None = Field(
        default=None, description="Repo owner — omit to use your own username"
    )


@tool("close_issue", args_schema=CloseIssueArgs)
async def close_issue(repo: str, issue_number: int, owner: str | None = None) -> str:
    """Close an open GitHub issue by number. If you do not already have the issue number, call get_assigned_issues first to retrieve it."""
    try:
        repo_owner = owner or get_settings().GITHUB_USERNAME
        response = await get_client().patch(
            f"https://api.github.com/repos/{repo_owner}/{repo}/issues/{issue_number}",
            headers={**(await _headers()), "Content-Type": "application/json"},
            json={"state": "closed"},
        )
        if response.is_error:
            return f"Failed to close issue ({response.status_code}): {response.text}"
        return f"Issue #{issue_number} in {repo_owner}/{repo} closed."
    except Exception as exc:
        logger.error("[github]", exc_info=exc)
        return f"Error closing issue: {exc}"


class DeleteIssueArgs(BaseModel):
    repo: str = Field(description='Repository name (e.g. "second-brain")')
    issue_number: int = Field(description="Issue number to delete")
    owner: str | None = Field(
        default=None, description="Repo owner — omit to use your own username"
    )


@tool("delete_issue", args_schema=DeleteIssueArgs)
async def delete_issue(repo: str, issue_number: int, owner: str | None = None) -> str:
    """Permanently delete a GitHub issue by number. Requires admin access on the repository. If you do not already have the issue number, call get_assigned_issues first to retrieve it."""
    try:
        repo_owner = owner or get_settings().GITHUB_USERNAME
        headers = await _headers()

        id_response = await get_client().get(
            f"https://api.github.com/repos/{repo_owner}/{repo}/issues/{issue_number}",
            headers=headers,
        )
        if id_response.is_error:
            return f"Issue #{issue_number} not found in {repo_owner}/{repo}."
        node_id = id_response.json()["node_id"]

        del_response = await get_client().post(
            "https://api.github.com/graphql",
            headers={**headers, "Content-Type": "application/json"},
            json={"query": f'mutation {{ deleteIssue(input: {{ issueId: "{node_id}" }}) {{ repository {{ name }} }} }}'},
        )
        del_data = del_response.json()
        errors = del_data.get("errors") or []
        if errors:
            return f"GraphQL error: {errors[0]['message']}"

        return f"Issue #{issue_number} in {repo_owner}/{repo} deleted."
    except Exception as exc:
        logger.error("[github]", exc_info=exc)
        return f"Error deleting issue: {exc}"


class CreatePullRequestArgs(BaseModel):
    repo: str = Field(description='Repository name, e.g. "kron"')
    title: str = Field(description="Pull request title")
    head: str = Field(
        description='The branch containing changes. Example: "feature/jobs" or '
        '"winnerx0:feature/jobs" for forks.'
    )
    base: str = Field(
        default="main", description='The branch to merge into, usually "main" or "master".'
    )
    body: str | None = Field(default=None, description="Pull request body / description in markdown.")
    draft: bool | None = Field(default=None, description="Whether to create the pull request as a draft.")
    owner: str | None = Field(
        default=None, description="Repository owner. Omit to use your own username."
    )


@tool("create_pull_request", args_schema=CreatePullRequestArgs)
async def create_pull_request(
    repo: str,
    title: str,
    head: str,
    base: str = "main",
    body: str | None = None,
    draft: bool | None = None,
    owner: str | None = None,
) -> str:
    """Create a GitHub pull request from a head branch into a base branch. Use this after code has already been pushed to GitHub."""
    try:
        repo_owner = owner or get_settings().GITHUB_USERNAME
        payload: dict[str, Any] = {"title": title, "head": head, "base": base}
        if body:
            payload["body"] = body
        if draft is not None:
            payload["draft"] = draft

        response = await get_client().post(
            f"https://api.github.com/repos/{repo_owner}/{repo}/pulls",
            headers={**(await _headers()), "Content-Type": "application/json"},
            json=payload,
        )
        if response.is_error:
            return f"Failed to create pull request ({response.status_code}): {response.text}"

        data = response.json()
        return dumps(
            {
                "message": f"Pull request #{data['number']} created.",
                "number": data["number"],
                "title": data["title"],
                "state": data["state"],
                "draft": data.get("draft", False),
                "url": data["html_url"],
            }
        )
    except Exception as exc:
        logger.error("[github]", exc_info=exc)
        return f"Error creating pull request: {exc}"


class GetPullRequestArgs(BaseModel):
    repo: str = Field(description='Repository name, e.g. "kron"')
    pull_number: int = Field(description="Pull request number")
    owner: str | None = Field(
        default=None, description="Repository owner. Omit to use your own username."
    )


@tool("get_pull_request", args_schema=GetPullRequestArgs)
async def get_pull_request(repo: str, pull_number: int, owner: str | None = None) -> str:
    """Get details about a GitHub pull request, including mergeability, branch names, state, and URL."""
    try:
        repo_owner = owner or get_settings().GITHUB_USERNAME
        response = await get_client().get(
            f"https://api.github.com/repos/{repo_owner}/{repo}/pulls/{pull_number}",
            headers=await _headers(),
        )
        if response.is_error:
            return f"Failed to get pull request ({response.status_code}): {response.text}"

        data = response.json()
        return dumps(
            {
                "number": data["number"],
                "title": data["title"],
                "state": data["state"],
                "draft": data["draft"],
                "merged": data["merged"],
                "mergeable": data["mergeable"],
                "mergeableState": data.get("mergeable_state"),
                "base": data["base"]["ref"],
                "head": data["head"]["ref"],
                "headSha": data["head"]["sha"],
                "author": (data.get("user") or {}).get("login"),
                "url": data["html_url"],
            }
        )
    except Exception as exc:
        logger.error("[github]", exc_info=exc)
        return f"Error fetching pull request: {exc}"


MergeMethod = Literal["merge", "squash", "rebase"]


class MergePullRequestArgs(BaseModel):
    repo: str = Field(description='Repository name, e.g. "kron"')
    pull_number: int = Field(description="Pull request number to merge")
    commit_title: str | None = Field(default=None, description="Custom merge commit title.")
    commit_message: str | None = Field(default=None, description="Custom merge commit message.")
    merge_method: MergeMethod | None = Field(
        default=None,
        description='Merge strategy. Use "merge", "squash", or "rebase". Defaults to the '
        "repository default if omitted.",
    )
    expected_head_sha: str | None = Field(
        default=None,
        description="Optional expected head SHA. This prevents merging if the PR changed "
        "after it was checked.",
    )
    owner: str | None = Field(
        default=None, description="Repository owner. Omit to use your own username."
    )


@tool("merge_pull_request", args_schema=MergePullRequestArgs)
async def merge_pull_request(
    repo: str,
    pull_number: int,
    commit_title: str | None = None,
    commit_message: str | None = None,
    merge_method: MergeMethod | None = None,
    expected_head_sha: str | None = None,
    owner: str | None = None,
) -> str:
    """Merge an open GitHub pull request by number. If unsure whether it is mergeable, call get_pull_request first."""
    try:
        repo_owner = owner or get_settings().GITHUB_USERNAME
        payload: dict[str, Any] = {}
        if commit_title:
            payload["commit_title"] = commit_title
        if commit_message:
            payload["commit_message"] = commit_message
        if merge_method:
            payload["merge_method"] = merge_method
        if expected_head_sha:
            payload["sha"] = expected_head_sha

        response = await get_client().put(
            f"https://api.github.com/repos/{repo_owner}/{repo}/pulls/{pull_number}/merge",
            headers={**(await _headers()), "Content-Type": "application/json"},
            json=payload,
        )
        if response.is_error:
            return f"Failed to merge pull request ({response.status_code}): {response.text}"

        data = response.json()
        return dumps(
            {
                "message": data["message"],
                "merged": data["merged"],
                "sha": data["sha"],
                "pullNumber": pull_number,
                "repo": f"{repo_owner}/{repo}",
            }
        )
    except Exception as exc:
        logger.error("[github]", exc_info=exc)
        return f"Error merging pull request: {exc}"


class GetCommitsArgs(BaseModel):
    from_: str | None = Field(
        default=None,
        alias="from",
        description="Start of the range (inclusive) as an ISO 8601 date or datetime, e.g. "
        '"2026-06-01" or "2026-06-01T09:00:00+00:00". If both from and to are omitted, '
        "defaults to 24 hours ago.",
    )
    to: str | None = Field(
        default=None,
        description="End of the range (inclusive) as an ISO 8601 date or datetime, e.g. "
        '"2026-06-14" or "2026-06-14T17:30:00+00:00". Omit for no upper bound.',
    )
    repo: str | None = Field(
        default=None,
        description='Repository name to scope to (e.g. "second-brain"). Omit to search all '
        "of the user's repos.",
    )
    owner: str | None = Field(
        default=None, description='Repo owner — only used with "repo". Omit to use your own username.'
    )
    author: str | None = Field(
        default=None, description="Commit author username. Omit to use your own username."
    )

    model_config = {"populate_by_name": True}


@tool("get_commits", args_schema=GetCommitsArgs)
async def get_commits(
    from_: str | None = None,
    to: str | None = None,
    repo: str | None = None,
    owner: str | None = None,
    author: str | None = None,
) -> str:
    """Get commits authored by the user, with full commit messages, within a date/time range and optionally scoped to a single repo. Defaults to the user's commits across all their repos in the last 24 hours. Returns up to 100 commits, newest first."""
    try:
        settings = get_settings()
        commit_author = author or settings.GITHUB_USERNAME
        qualifiers = [f"author:{commit_author}"]

        start = from_ or (
            "*" if to else js_date(dt.datetime.now(dt.UTC) - dt.timedelta(hours=24))
        )
        end = to or "*"
        qualifiers.append(f"author-date:{start}..{end}")

        if repo:
            repo_owner = owner or settings.GITHUB_USERNAME
            qualifiers.append(f"repo:{repo_owner}/{repo}")

        response = await get_client().get(
            "https://api.github.com/search/commits",
            params={
                "q": " ".join(qualifiers),
                "sort": "author-date",
                "order": "desc",
                "per_page": 100,
            },
            headers=await _headers(),
        )
        if response.is_error:
            return f"Failed to fetch commits ({response.status_code}): {response.text}"

        data = response.json()
        items = data.get("items") or []
        logger.info("[github] fetched %d commits (total %d)", len(items), data.get("total_count", 0))

        return dumps(
            {
                "totalCount": data.get("total_count", len(items)),
                "commits": [
                    {
                        "sha": item["sha"][:7],
                        "message": item["commit"]["message"],
                        "repo": item["repository"]["full_name"],
                        "author": (item.get("author") or {}).get("login")
                        or item["commit"]["author"]["name"],
                        "date": item["commit"]["author"]["date"],
                        "url": item["html_url"],
                    }
                    for item in items
                ],
            }
        )
    except Exception as exc:
        logger.error("[github]", exc_info=exc)
        return f"Error fetching commits: {exc}"


github_tools = [
    get_open_prs,
    get_assigned_issues,
    create_issue,
    close_issue,
    delete_issue,
    create_pull_request,
    get_pull_request,
    merge_pull_request,
    get_commits,
]
