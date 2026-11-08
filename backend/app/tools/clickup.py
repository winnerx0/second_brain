from __future__ import annotations

import datetime as dt
from typing import Any

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from app.http import get_client
from app.json import dumps, js_date
from app.logging import get_logger
from app.oauth import get_valid_token

logger = get_logger("clickup")

CLICKUP_API = "https://api.clickup.com/api/v2"


async def _token() -> str:
    token = await get_valid_token("clickup")
    if not token:
        raise RuntimeError("ClickUp is not connected. Go to Connections and add your API key.")
    return token


async def _headers() -> dict[str, str]:
    return {"Authorization": await _token(), "Content-Type": "application/json"}


def _ms_to_iso(value: str | None) -> str | None:
    return js_date(dt.datetime.fromtimestamp(int(value) / 1000, tz=dt.UTC)) if value else None


@tool("clickup_get_workspaces")
async def clickup_get_workspaces() -> str:
    """Get all ClickUp workspaces the user belongs to. Returns workspace IDs and names. Call this first to get the workspace_id needed by other tools."""
    try:
        response = await get_client().get(f"{CLICKUP_API}/team", headers=await _headers())
        if response.is_error:
            return f"Failed to get workspaces ({response.status_code}): {response.text}"
        teams = response.json().get("teams") or []
        return dumps([{"id": team["id"], "name": team["name"]} for team in teams])
    except Exception as exc:
        logger.error("[clickup] getWorkspaces", exc_info=exc)
        return f"Error: {exc}"


class ClickupGetSpacesArgs(BaseModel):
    workspaceId: str = Field(description="Workspace (team) ID")


@tool("clickup_get_spaces", args_schema=ClickupGetSpacesArgs)
async def clickup_get_spaces(workspaceId: str) -> str:
    """Get all spaces in a ClickUp workspace."""
    try:
        response = await get_client().get(
            f"{CLICKUP_API}/team/{workspaceId}/space",
            params={"archived": "false"},
            headers=await _headers(),
        )
        if response.is_error:
            return f"Failed to get spaces ({response.status_code}): {response.text}"
        spaces = response.json().get("spaces") or []
        return dumps([{"id": s["id"], "name": s["name"], "private": s["private"]} for s in spaces])
    except Exception as exc:
        logger.error("[clickup] getSpaces", exc_info=exc)
        return f"Error: {exc}"


class ClickupGetListsArgs(BaseModel):
    spaceId: str = Field(description="Space ID")


@tool("clickup_get_lists", args_schema=ClickupGetListsArgs)
async def clickup_get_lists(spaceId: str) -> str:
    """Get all lists in a ClickUp space (both foldered and folderless). Returns list IDs needed to get or create tasks."""
    try:
        headers = await _headers()
        foldered_response = await get_client().get(
            f"{CLICKUP_API}/space/{spaceId}/folder", params={"archived": "false"}, headers=headers
        )
        folderless_response = await get_client().get(
            f"{CLICKUP_API}/space/{spaceId}/list", params={"archived": "false"}, headers=headers
        )

        results: list[dict[str, Any]] = []
        if not foldered_response.is_error:
            for folder in foldered_response.json().get("folders") or []:
                for lst in folder.get("lists") or []:
                    results.append(
                        {"id": lst["id"], "name": lst["name"], "folder": folder["name"], "taskCount": lst["task_count"]}
                    )
        if not folderless_response.is_error:
            for lst in folderless_response.json().get("lists") or []:
                results.append({"id": lst["id"], "name": lst["name"], "taskCount": lst["task_count"]})

        return dumps(results)
    except Exception as exc:
        logger.error("[clickup] getLists", exc_info=exc)
        return f"Error: {exc}"


class ClickupGetTasksArgs(BaseModel):
    listId: str = Field(description="List ID")
    status: str | None = Field(default=None, description='Filter by status name (e.g. "in progress", "complete")')
    assignee: str | None = Field(default=None, description="Filter by assignee user ID")
    dueDateLte: float | None = Field(default=None, description="Filter tasks due on or before this Unix timestamp (ms)")
    dueDateGte: float | None = Field(default=None, description="Filter tasks due on or after this Unix timestamp (ms)")
    page: int | None = Field(default=None, description="Page number for pagination (default 0)")
    includeSubtasks: bool | None = Field(default=None, description="Include subtasks in results")


def _summarize_task(task: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": task["id"],
        "name": task["name"],
        "status": task["status"]["status"],
        "priority": (task.get("priority") or {}).get("priority"),
        "dueDate": _ms_to_iso(task.get("due_date")),
        "assignees": [a["username"] for a in task.get("assignees") or []],
        "description": task.get("description"),
        "url": task["url"],
    }


@tool("clickup_get_tasks", args_schema=ClickupGetTasksArgs)
async def clickup_get_tasks(
    listId: str,
    status: str | None = None,
    assignee: str | None = None,
    dueDateLte: float | None = None,
    dueDateGte: float | None = None,
    page: int | None = None,
    includeSubtasks: bool | None = None,
) -> str:
    """Get tasks in a ClickUp list. Supports filtering by status, assignee, and due date range."""
    try:
        params: dict[str, Any] = {"archived": "false"}
        if status:
            params["statuses[]"] = status
        if assignee:
            params["assignees[]"] = assignee
        if dueDateLte is not None:
            params["due_date_lte"] = str(int(dueDateLte))
        if dueDateGte is not None:
            params["due_date_gte"] = str(int(dueDateGte))
        if page is not None:
            params["page"] = str(page)
        if includeSubtasks:
            params["subtasks"] = "true"

        response = await get_client().get(f"{CLICKUP_API}/list/{listId}/task", params=params, headers=await _headers())
        if response.is_error:
            return f"Failed to get tasks ({response.status_code}): {response.text}"
        data = response.json()
        tasks = [_summarize_task(task) for task in data.get("tasks") or []]
        return dumps({"tasks": tasks, "lastPage": data.get("last_page")})
    except Exception as exc:
        logger.error("[clickup] getTasks", exc_info=exc)
        return f"Error: {exc}"


class ClickupGetTaskArgs(BaseModel):
    taskId: str = Field(description="Task ID")


@tool("clickup_get_task", args_schema=ClickupGetTaskArgs)
async def clickup_get_task(taskId: str) -> str:
    """Get full details of a single ClickUp task by ID."""
    try:
        response = await get_client().get(f"{CLICKUP_API}/task/{taskId}", headers=await _headers())
        if response.is_error:
            return f"Failed to get task ({response.status_code}): {response.text}"
        task = response.json()
        subtasks = task.get("subtasks")
        return dumps(
            {
                "id": task["id"],
                "name": task["name"],
                "description": task.get("description"),
                "status": task["status"]["status"],
                "priority": (task.get("priority") or {}).get("priority"),
                "dueDate": _ms_to_iso(task.get("due_date")),
                "assignees": [
                    {"id": a["id"], "username": a["username"], "email": a["email"]}
                    for a in task.get("assignees") or []
                ],
                "tags": [tag["name"] for tag in task.get("tags") or []],
                "list": task.get("list"),
                "parent": task.get("parent"),
                "subtasks": (
                    [{"id": s["id"], "name": s["name"], "status": s["status"]["status"]} for s in subtasks]
                    if subtasks
                    else None
                ),
                "url": task["url"],
            }
        )
    except Exception as exc:
        logger.error("[clickup] getTask", exc_info=exc)
        return f"Error: {exc}"


class ClickupCreateTaskArgs(BaseModel):
    listId: str = Field(description="List ID to create the task in")
    name: str = Field(description="Task name")
    description: str | None = Field(default=None, description="Task description (plain text)")
    status: str | None = Field(default=None, description="Status name (must match an existing status in the list)")
    priority: int | None = Field(default=None, description="Priority: 1=urgent, 2=high, 3=normal, 4=low")
    dueDate: str | None = Field(default=None, description='Due date as ISO 8601 string (e.g. "2026-05-10T00:00:00Z")')
    assignees: list[int] | None = Field(default=None, description="Array of user IDs to assign")
    tags: list[str] | None = Field(default=None, description="Array of tag names")
    parentId: str | None = Field(default=None, description="Parent task ID to create this as a subtask")


@tool("clickup_create_task", args_schema=ClickupCreateTaskArgs)
async def clickup_create_task(
    listId: str,
    name: str,
    description: str | None = None,
    status: str | None = None,
    priority: int | None = None,
    dueDate: str | None = None,
    assignees: list[int] | None = None,
    tags: list[str] | None = None,
    parentId: str | None = None,
) -> str:
    """Create a new task in a ClickUp list."""
    try:
        body: dict[str, Any] = {"name": name}
        if description:
            body["description"] = description
        if status:
            body["status"] = status
        if priority is not None:
            body["priority"] = priority
        if dueDate:
            body["due_date"] = int(dt.datetime.fromisoformat(dueDate.replace("Z", "+00:00")).timestamp() * 1000)
        if assignees:
            body["assignees"] = assignees
        if tags:
            body["tags"] = tags
        if parentId:
            body["parent"] = parentId

        response = await get_client().post(f"{CLICKUP_API}/list/{listId}/task", headers=await _headers(), json=body)
        if response.is_error:
            return f"Failed to create task ({response.status_code}): {response.text}"
        task = response.json()
        return dumps({"id": task["id"], "name": task["name"], "url": task["url"]})
    except Exception as exc:
        logger.error("[clickup] createTask", exc_info=exc)
        return f"Error: {exc}"


class ClickupUpdateTaskArgs(BaseModel):
    taskId: str = Field(description="Task ID to update")
    name: str | None = Field(default=None, description="New task name")
    description: str | None = Field(default=None, description="New description (plain text)")
    status: str | None = Field(default=None, description="New status name")
    priority: int | None = Field(default=None, description="New priority: 1=urgent, 2=high, 3=normal, 4=low")
    dueDate: str | None = Field(default=None, description="New due date as ISO 8601, or empty string to clear it")
    assigneesAdd: list[int] | None = Field(default=None, description="User IDs to add as assignees")
    assigneesRemove: list[int] | None = Field(default=None, description="User IDs to remove from assignees")


@tool("clickup_update_task", args_schema=ClickupUpdateTaskArgs)
async def clickup_update_task(
    taskId: str,
    name: str | None = None,
    description: str | None = None,
    status: str | None = None,
    priority: int | None = None,
    dueDate: str | None = None,
    assigneesAdd: list[int] | None = None,
    assigneesRemove: list[int] | None = None,
) -> str:
    """Update an existing ClickUp task. Only include fields you want to change."""
    try:
        body: dict[str, Any] = {}
        if name:
            body["name"] = name
        if description is not None:
            body["description"] = description
        if status:
            body["status"] = status
        if priority is not None:
            body["priority"] = priority
        if dueDate is not None:
            body["due_date"] = (
                int(dt.datetime.fromisoformat(dueDate.replace("Z", "+00:00")).timestamp() * 1000) if dueDate else None
            )
        if assigneesAdd or assigneesRemove:
            body["assignees"] = {"add": assigneesAdd or [], "rem": assigneesRemove or []}

        response = await get_client().put(f"{CLICKUP_API}/task/{taskId}", headers=await _headers(), json=body)
        if response.is_error:
            return f"Failed to update task ({response.status_code}): {response.text}"
        task = response.json()
        return dumps({"id": task["id"], "name": task["name"], "status": task["status"]["status"], "url": task["url"]})
    except Exception as exc:
        logger.error("[clickup] updateTask", exc_info=exc)
        return f"Error: {exc}"


class ClickupDeleteTaskArgs(BaseModel):
    taskId: str = Field(description="Task ID to delete")


@tool("clickup_delete_task", args_schema=ClickupDeleteTaskArgs)
async def clickup_delete_task(taskId: str) -> str:
    """Permanently delete a ClickUp task."""
    try:
        response = await get_client().delete(f"{CLICKUP_API}/task/{taskId}", headers=await _headers())
        if response.is_error:
            return f"Failed to delete task ({response.status_code}): {response.text}"
        return f"Task {taskId} deleted"
    except Exception as exc:
        logger.error("[clickup] deleteTask", exc_info=exc)
        return f"Error: {exc}"


class ClickupSearchTasksArgs(BaseModel):
    workspaceId: str = Field(description="Workspace (team) ID")
    query: str | None = Field(default=None, description="Keyword to search in task names and descriptions")
    status: str | None = Field(default=None, description="Filter by status name")
    assignee: str | None = Field(default=None, description="Filter by assignee user ID")
    dueDateLte: float | None = Field(default=None, description="Due on or before Unix timestamp (ms)")
    dueDateGte: float | None = Field(default=None, description="Due on or after Unix timestamp (ms)")


@tool("clickup_search_tasks", args_schema=ClickupSearchTasksArgs)
async def clickup_search_tasks(
    workspaceId: str,
    query: str | None = None,
    status: str | None = None,
    assignee: str | None = None,
    dueDateLte: float | None = None,
    dueDateGte: float | None = None,
) -> str:
    """Search tasks across an entire ClickUp workspace by keyword, status, assignee, or due date."""
    try:
        params: dict[str, Any] = {}
        if query:
            params["search"] = query
        if status:
            params["statuses[]"] = status
        if assignee:
            params["assignees[]"] = assignee
        if dueDateLte is not None:
            params["due_date_lte"] = str(int(dueDateLte))
        if dueDateGte is not None:
            params["due_date_gte"] = str(int(dueDateGte))

        response = await get_client().get(f"{CLICKUP_API}/team/{workspaceId}/task", params=params, headers=await _headers())
        if response.is_error:
            return f"Failed to search tasks ({response.status_code}): {response.text}"
        tasks = response.json().get("tasks") or []
        return dumps(
            [
                {
                    "id": task["id"],
                    "name": task["name"],
                    "status": task["status"]["status"],
                    "priority": (task.get("priority") or {}).get("priority"),
                    "dueDate": _ms_to_iso(task.get("due_date")),
                    "list": task["list"]["name"],
                    "url": task["url"],
                }
                for task in tasks
            ]
        )
    except Exception as exc:
        logger.error("[clickup] searchTasks", exc_info=exc)
        return f"Error: {exc}"


class ClickupGetCommentsArgs(BaseModel):
    taskId: str = Field(description="Task ID")


@tool("clickup_get_comments", args_schema=ClickupGetCommentsArgs)
async def clickup_get_comments(taskId: str) -> str:
    """Get all comments on a ClickUp task."""
    try:
        response = await get_client().get(f"{CLICKUP_API}/task/{taskId}/comment", headers=await _headers())
        if response.is_error:
            return f"Failed to get comments ({response.status_code}): {response.text}"
        comments = response.json().get("comments") or []
        return dumps(
            [
                {
                    "id": comment["id"],
                    "text": comment["comment_text"],
                    "author": comment["user"]["username"],
                    "date": _ms_to_iso(comment["date"]),
                }
                for comment in comments
            ]
        )
    except Exception as exc:
        logger.error("[clickup] getComments", exc_info=exc)
        return f"Error: {exc}"


class ClickupCreateCommentArgs(BaseModel):
    taskId: str = Field(description="Task ID")
    text: str = Field(description="Comment text")


@tool("clickup_create_comment", args_schema=ClickupCreateCommentArgs)
async def clickup_create_comment(taskId: str, text: str) -> str:
    """Add a comment to a ClickUp task."""
    try:
        response = await get_client().post(
            f"{CLICKUP_API}/task/{taskId}/comment", headers=await _headers(), json={"comment_text": text}
        )
        if response.is_error:
            return f"Failed to create comment ({response.status_code}): {response.text}"
        data = response.json()
        return f"Comment created on task {taskId}. Comment ID: {data['id']}"
    except Exception as exc:
        logger.error("[clickup] createComment", exc_info=exc)
        return f"Error: {exc}"


clickup_tools = [
    clickup_get_workspaces,
    clickup_get_spaces,
    clickup_get_lists,
    clickup_get_tasks,
    clickup_get_task,
    clickup_create_task,
    clickup_update_task,
    clickup_delete_task,
    clickup_search_tasks,
    clickup_get_comments,
    clickup_create_comment,
]
