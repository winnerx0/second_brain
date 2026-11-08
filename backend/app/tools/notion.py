from __future__ import annotations

import json
from typing import Any

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from app.config import get_settings
from app.http import get_client
from app.json import dumps
from app.logging import get_logger
from app.oauth import get_valid_token

logger = get_logger("notion")

NOTION_API = "https://api.notion.com/v1"


async def _token() -> str:
    token = await get_valid_token("notion")
    return token or get_settings().NOTION_TOKEN


async def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {await _token()}",
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
    }


def _rich_text(content: str) -> list[dict[str, Any]]:
    return [{"type": "text", "text": {"content": content}}]


def _extract_block_text(block: dict[str, Any]) -> str:
    block_type = block.get("type")
    inner = block.get(block_type) or {}
    return "".join(part.get("plain_text", "") for part in inner.get("rich_text") or [])


_BLOCK_PREFIXES = {
    "heading_1": "# ",
    "heading_2": "## ",
    "heading_3": "### ",
    "bulleted_list_item": "• ",
    "numbered_list_item": "1. ",
    "code": "```\n",
    "quote": "> ",
    "callout": "💡 ",
    "divider": "---",
}


def _flatten_blocks(blocks: list[dict[str, Any]]) -> str:
    lines = []
    for block in blocks:
        block_type = block.get("type")
        if block_type == "divider":
            lines.append("---")
            continue
        text = _extract_block_text(block)
        if block_type == "to_do":
            checked = (block.get("to_do") or {}).get("checked")
            prefix = f"[{'x' if checked else ' '}] "
        else:
            prefix = _BLOCK_PREFIXES.get(block_type, "")
        suffix = "\n```" if block_type == "code" else ""
        lines.append(f"{prefix}{text}{suffix}")
    return "\n".join(lines)


class SearchNotionArgs(BaseModel):
    query: str = Field(description="Search query")
    filterType: str | None = Field(
        default=None, description="Filter by object type (default: all)"
    )
    pageSize: int | None = Field(
        default=None, description="Number of results to return (default 20, max 100)"
    )


@tool("search_notion", args_schema=SearchNotionArgs)
async def search_notion(
    query: str, filterType: str | None = None, pageSize: int | None = None
) -> str:
    """Search for pages and databases in the Notion workspace by keyword."""
    try:
        body: dict[str, Any] = {"query": query, "page_size": pageSize or 20}
        if filterType and filterType != "all":
            body["filter"] = {"value": filterType, "property": "object"}

        response = await get_client().post(f"{NOTION_API}/search", headers=await _headers(), json=body)
        if response.is_error:
            return f"Search failed ({response.status_code}): {response.text}"
        data = response.json()

        results = []
        for item in data.get("results") or []:
            properties = item.get("properties")
            if properties:
                title = next(
                    (
                        (prop.get("title") or [{}])[0].get("plain_text")
                        for prop in properties.values()
                        if prop.get("title")
                    ),
                    None,
                )
            else:
                title = (item.get("title") or [{}])[0].get("plain_text")
            results.append(
                {
                    "id": item.get("id"),
                    "type": item.get("object"),
                    "title": title or "Untitled",
                    "url": item.get("url"),
                }
            )

        return dumps(
            {"results": results, "has_more": data.get("has_more"), "next_cursor": data.get("next_cursor")}
        )
    except Exception as exc:
        logger.error("[notion] searchNotion", exc_info=exc)
        return f"Error searching Notion: {exc}"


class GetNotionPageArgs(BaseModel):
    pageId: str = Field(description="Notion page ID (UUID)")


@tool("get_notion_page", args_schema=GetNotionPageArgs)
async def get_notion_page(pageId: str) -> str:
    """Retrieve a Notion page's properties and content. Returns flattened text content for easy reading."""
    try:
        headers = await _headers()
        page_response = await get_client().get(f"{NOTION_API}/pages/{pageId}", headers=headers)
        blocks_response = await get_client().get(
            f"{NOTION_API}/blocks/{pageId}/children", params={"page_size": 100}, headers=headers
        )
        if page_response.is_error:
            return f"Failed to get page ({page_response.status_code}): {page_response.text}"
        if blocks_response.is_error:
            return f"Failed to get blocks ({blocks_response.status_code}): {blocks_response.text}"

        page = page_response.json()
        blocks = blocks_response.json()

        properties = page.get("properties") or {}
        title_prop = next((prop for prop in properties.values() if "title" in prop), None)
        title = (
            (title_prop.get("title") or [{}])[0].get("plain_text") if title_prop else None
        ) or "Untitled"
        content = _flatten_blocks(blocks.get("results") or [])

        return dumps(
            {
                "id": page.get("id"),
                "title": title,
                "url": page.get("url"),
                "created": page.get("created_time"),
                "last_edited": page.get("last_edited_time"),
                "properties": properties,
                "content": content,
            }
        )
    except Exception as exc:
        logger.error("[notion] getNotionPage", exc_info=exc)
        return f"Error retrieving page: {exc}"


class CreateNotionPageArgs(BaseModel):
    title: str = Field(description="Page title")
    parentId: str = Field(description="Parent page or database ID (UUID)")
    parentType: str = Field(description="Whether the parent is a page or database (page_id or database_id)")
    icon: str | None = Field(default=None, description="Optional emoji icon (e.g. '📝', '✅')")
    children: str | None = Field(
        default=None, description="Optional JSON array of Notion block objects to include as page content"
    )


@tool(
    "create_notion_page",
    args_schema=CreateNotionPageArgs,
    description="""Create a new Notion page under a parent page or database, optionally with inline content.

If children are provided, the page is created with content in a single call.
Otherwise, use append_notion_blocks after creation to add content.

Common block shapes for children:
- paragraph:           {"type":"paragraph","paragraph":{"rich_text":[{"type":"text","text":{"content":"text"}}]}}
- heading_1/2/3:       {"type":"heading_1","heading_1":{"rich_text":[{"type":"text","text":{"content":"title"}}]}}
- bulleted_list_item:  {"type":"bulleted_list_item","bulleted_list_item":{"rich_text":[{"type":"text","text":{"content":"item"}}]}}
- numbered_list_item:  {"type":"numbered_list_item","numbered_list_item":{"rich_text":[{"type":"text","text":{"content":"item"}}]}}
- to_do:               {"type":"to_do","to_do":{"rich_text":[{"type":"text","text":{"content":"task"}}],"checked":false}}
- code:                {"type":"code","code":{"rich_text":[{"type":"text","text":{"content":"code"}}],"language":"typescript"}}
- quote:               {"type":"quote","quote":{"rich_text":[{"type":"text","text":{"content":"quote"}}]}}
- divider:             {"type":"divider","divider":{}}
- callout:             {"type":"callout","callout":{"rich_text":[{"type":"text","text":{"content":"note"}}],"icon":{"emoji":"💡"}}}""",
)
async def create_notion_page(
    title: str,
    parentId: str,
    parentType: str,
    icon: str | None = None,
    children: str | None = None,
) -> str:
    try:
        parent = {"database_id": parentId} if parentType == "database_id" else {"page_id": parentId}
        properties = (
            {"Name": {"title": [{"text": {"content": title}}]}}
            if parentType == "database_id"
            else {"title": {"title": [{"text": {"content": title}}]}}
        )

        parsed_children = None
        if children:
            try:
                parsed_children = json.loads(children)
            except ValueError:
                return "Invalid children JSON array"

        payload: dict[str, Any] = {"parent": parent, "properties": properties}
        if icon:
            payload["icon"] = {"type": "emoji", "emoji": icon}
        if parsed_children is not None:
            payload["children"] = parsed_children

        response = await get_client().post(f"{NOTION_API}/pages", headers=await _headers(), json=payload)
        if response.is_error:
            return f"Failed to create page ({response.status_code}): {response.text}"
        page = response.json()
        return dumps({"id": page["id"], "url": page["url"], "message": f'Page "{title}" created'})
    except Exception as exc:
        logger.error("[notion] createNotionPage", exc_info=exc)
        return f"Error creating page: {exc}"


class UpdateNotionPagePropertiesArgs(BaseModel):
    pageId: str = Field(description="Notion page ID (UUID)")
    properties: str | None = Field(
        default=None,
        description='JSON string of properties to update, e.g. \'{"Status":{"select":{"name":"Done"}}}\'',
    )
    icon: str | None = Field(default=None, description="New emoji icon")
    archived: bool | None = Field(
        default=None, description="Set to true to trash the page, false to restore"
    )


@tool("update_notion_page_properties", args_schema=UpdateNotionPagePropertiesArgs)
async def update_notion_page_properties(
    pageId: str, properties: str | None = None, icon: str | None = None, archived: bool | None = None
) -> str:
    """Update a Notion page's properties, icon, or archived state."""
    try:
        parsed = None
        if properties:
            try:
                parsed = json.loads(properties)
            except ValueError:
                return "Invalid properties JSON"

        body: dict[str, Any] = {}
        if parsed is not None:
            body["properties"] = parsed
        if icon:
            body["icon"] = {"type": "emoji", "emoji": icon}
        if archived is not None:
            body["archived"] = archived

        response = await get_client().patch(f"{NOTION_API}/pages/{pageId}", headers=await _headers(), json=body)
        if response.is_error:
            return f"Failed to update page ({response.status_code}): {response.text}"
        page = response.json()
        return f"Page updated — {page['url']}"
    except Exception as exc:
        logger.error("[notion] updateNotionPageProperties", exc_info=exc)
        return f"Error updating page: {exc}"


class TrashNotionPageArgs(BaseModel):
    pageId: str = Field(description="Notion page ID (UUID)")


@tool("trash_notion_page", args_schema=TrashNotionPageArgs)
async def trash_notion_page(pageId: str) -> str:
    """Move a Notion page to trash."""
    try:
        response = await get_client().patch(
            f"{NOTION_API}/pages/{pageId}", headers=await _headers(), json={"archived": True}
        )
        if response.is_error:
            return f"Failed to trash page ({response.status_code}): {response.text}"
        return f"Page {pageId} moved to trash"
    except Exception as exc:
        logger.error("[notion] trashNotionPage", exc_info=exc)
        return f"Error trashing page: {exc}"


class GetBlockChildrenArgs(BaseModel):
    blockId: str = Field(description="Page or block ID (UUID)")
    cursor: str | None = Field(
        default=None, description="Pagination cursor from a previous call's next_cursor"
    )


@tool("get_block_children", args_schema=GetBlockChildrenArgs)
async def get_block_children(blockId: str, cursor: str | None = None) -> str:
    """Get the child blocks of a page or block. Supports pagination for long pages."""
    try:
        params: dict[str, Any] = {"page_size": 100}
        if cursor:
            params["start_cursor"] = cursor
        response = await get_client().get(
            f"{NOTION_API}/blocks/{blockId}/children", params=params, headers=await _headers()
        )
        if response.is_error:
            return f"Failed to get block children ({response.status_code}): {response.text}"
        data = response.json()
        simplified = [
            {
                "id": block.get("id"),
                "type": block.get("type"),
                "text": _extract_block_text(block),
                "has_children": block.get("has_children"),
            }
            for block in data.get("results") or []
        ]
        return dumps(
            {"blocks": simplified, "has_more": data.get("has_more"), "next_cursor": data.get("next_cursor")}
        )
    except Exception as exc:
        logger.error("[notion] getBlockChildren", exc_info=exc)
        return f"Error getting block children: {exc}"


class AppendNotionBlocksArgs(BaseModel):
    blockId: str = Field(description="Page or block ID to append to (UUID)")
    blocks: str = Field(description="JSON array of Notion block objects")


@tool(
    "append_notion_blocks",
    args_schema=AppendNotionBlocksArgs,
    description="""Append blocks to a Notion page or block. Blocks must be a JSON array of Notion block objects.

Common block shapes:
- paragraph:           {"type":"paragraph","paragraph":{"rich_text":[{"type":"text","text":{"content":"text"}}]}}
- heading_1/2/3:       {"type":"heading_1","heading_1":{"rich_text":[{"type":"text","text":{"content":"title"}}]}}
- bulleted_list_item:  {"type":"bulleted_list_item","bulleted_list_item":{"rich_text":[{"type":"text","text":{"content":"item"}}]}}
- numbered_list_item:  {"type":"numbered_list_item","numbered_list_item":{"rich_text":[{"type":"text","text":{"content":"item"}}]}}
- to_do:               {"type":"to_do","to_do":{"rich_text":[{"type":"text","text":{"content":"task"}}],"checked":false}}
- code:                {"type":"code","code":{"rich_text":[{"type":"text","text":{"content":"code"}}],"language":"typescript"}}
- quote:               {"type":"quote","quote":{"rich_text":[{"type":"text","text":{"content":"quote"}}]}}
- divider:             {"type":"divider","divider":{}}
- callout:             {"type":"callout","callout":{"rich_text":[{"type":"text","text":{"content":"note"}}],"icon":{"emoji":"💡"}}}""",
)
async def append_notion_blocks(blockId: str, blocks: str) -> str:
    try:
        try:
            parsed = json.loads(blocks)
        except ValueError:
            return "Invalid blocks JSON array"

        response = await get_client().patch(
            f"{NOTION_API}/blocks/{blockId}/children", headers=await _headers(), json={"children": parsed}
        )
        if response.is_error:
            return f"Failed to append blocks ({response.status_code}): {response.text}"
        return f"Blocks appended to {blockId}"
    except Exception as exc:
        logger.error("[notion] appendNotionBlocks", exc_info=exc)
        return f"Error appending blocks: {exc}"


class UpdateBlockArgs(BaseModel):
    blockId: str = Field(description="Block ID (UUID)")
    block: str = Field(
        description='JSON block object, e.g. \'{"paragraph":{"rich_text":[{"type":"text","text":{"content":"updated text"}}]}}\''
    )


@tool("update_notion_block", args_schema=UpdateBlockArgs)
async def update_notion_block(blockId: str, block: str) -> str:
    """Update the content of an existing Notion block. The block JSON must include the block type and its content."""
    try:
        try:
            parsed = json.loads(block)
        except ValueError:
            return "Invalid block JSON"

        response = await get_client().patch(f"{NOTION_API}/blocks/{blockId}", headers=await _headers(), json=parsed)
        if response.is_error:
            return f"Failed to update block ({response.status_code}): {response.text}"
        return f"Block {blockId} updated"
    except Exception as exc:
        logger.error("[notion] updateBlock", exc_info=exc)
        return f"Error updating block: {exc}"


class DeleteBlockArgs(BaseModel):
    blockId: str = Field(description="Block ID to delete (UUID)")


@tool("delete_notion_block", args_schema=DeleteBlockArgs)
async def delete_notion_block(blockId: str) -> str:
    """Permanently delete a Notion block."""
    try:
        response = await get_client().delete(f"{NOTION_API}/blocks/{blockId}", headers=await _headers())
        if response.is_error:
            return f"Failed to delete block ({response.status_code}): {response.text}"
        return f"Block {blockId} deleted"
    except Exception as exc:
        logger.error("[notion] deleteBlock", exc_info=exc)
        return f"Error deleting block: {exc}"


class GetNotionDatabaseArgs(BaseModel):
    databaseId: str = Field(description="Notion database ID (UUID)")


@tool("get_notion_database", args_schema=GetNotionDatabaseArgs)
async def get_notion_database(databaseId: str) -> str:
    """Retrieve a Notion database's schema — its title and all property names with their types."""
    try:
        response = await get_client().get(f"{NOTION_API}/databases/{databaseId}", headers=await _headers())
        if response.is_error:
            return f"Failed to get database ({response.status_code}): {response.text}"
        db = response.json()
        title = (db.get("title") or [{}])[0].get("plain_text") or "Untitled"
        properties = {prop["name"]: prop["type"] for prop in (db.get("properties") or {}).values()}
        return dumps({"id": db.get("id"), "title": title, "url": db.get("url"), "properties": properties})
    except Exception as exc:
        logger.error("[notion] getNotionDatabase", exc_info=exc)
        return f"Error getting database: {exc}"


class CreateNotionDatabaseArgs(BaseModel):
    parentId: str = Field(description="Parent page ID (UUID)")
    title: str = Field(description="Database title")
    properties: str | None = Field(
        default=None,
        description='JSON array of property definitions, e.g. \'[{"name":"Status","type":"select","options":["Todo","In Progress","Done"]},{"name":"Due","type":"date"}]\'. Always has a default "Name" title column.',
    )


@tool("create_notion_database", args_schema=CreateNotionDatabaseArgs)
async def create_notion_database(parentId: str, title: str, properties: str | None = None) -> str:
    """Create a new Notion database (inline table) under a parent page."""
    try:
        db_properties: dict[str, Any] = {"Name": {"title": {}}}
        if properties:
            try:
                parsed = json.loads(properties)
            except ValueError:
                return "Invalid properties JSON array"
            for prop in parsed:
                if prop["type"] in ("select", "multi_select"):
                    db_properties[prop["name"]] = {
                        prop["type"]: {"options": [{"name": option} for option in prop.get("options") or []]}
                    }
                else:
                    db_properties[prop["name"]] = {prop["type"]: {}}

        response = await get_client().post(
            f"{NOTION_API}/databases",
            headers=await _headers(),
            json={
                "parent": {"page_id": parentId},
                "title": [{"text": {"content": title}}],
                "properties": db_properties,
            },
        )
        if response.is_error:
            return f"Failed to create database ({response.status_code}): {response.text}"
        db = response.json()
        return dumps({"id": db["id"], "url": db["url"], "message": f'Database "{title}" created'})
    except Exception as exc:
        logger.error("[notion] createNotionDatabase", exc_info=exc)
        return f"Error creating database: {exc}"


class UpdateNotionDatabaseArgs(BaseModel):
    databaseId: str = Field(description="Notion database ID (UUID)")
    title: str | None = Field(default=None, description="New database title")
    properties: str | None = Field(default=None, description="JSON object of property schema changes")


@tool("update_notion_database", args_schema=UpdateNotionDatabaseArgs)
async def update_notion_database(
    databaseId: str, title: str | None = None, properties: str | None = None
) -> str:
    """Update a Notion database's title or add/update its properties."""
    try:
        body: dict[str, Any] = {}
        if title:
            body["title"] = [{"text": {"content": title}}]
        if properties:
            try:
                body["properties"] = json.loads(properties)
            except ValueError:
                return "Invalid properties JSON"

        response = await get_client().patch(
            f"{NOTION_API}/databases/{databaseId}", headers=await _headers(), json=body
        )
        if response.is_error:
            return f"Failed to update database ({response.status_code}): {response.text}"
        return f"Database {databaseId} updated"
    except Exception as exc:
        logger.error("[notion] updateNotionDatabase", exc_info=exc)
        return f"Error updating database: {exc}"


_PROPERTY_EXTRACTORS: dict[str, Any] = {
    "title": lambda val: "".join(part.get("plain_text", "") for part in val.get("title") or []),
    "rich_text": lambda val: "".join(part.get("plain_text", "") for part in val.get("rich_text") or []),
    "select": lambda val: (val.get("select") or {}).get("name"),
    "status": lambda val: (val.get("status") or {}).get("name"),
    "multi_select": lambda val: [option.get("name") for option in val.get("multi_select") or []],
    "date": lambda val: val.get("date"),
    "checkbox": lambda val: val.get("checkbox"),
    "number": lambda val: val.get("number"),
    "url": lambda val: val.get("url"),
    "email": lambda val: val.get("email"),
    "phone_number": lambda val: val.get("phone_number"),
}


class QueryNotionDatabaseArgs(BaseModel):
    databaseId: str = Field(description="Database ID (UUID)")
    filter: str | None = Field(
        default=None,
        description='JSON Notion filter object, e.g. \'{"property":"Status","select":{"equals":"Done"}}\'',
    )
    sorts: str | None = Field(
        default=None,
        description='JSON sorts array, e.g. \'[{"property":"Due","direction":"ascending"}]\'',
    )
    pageSize: int | None = Field(default=None, description="Rows to return per page (default 50, max 100)")
    cursor: str | None = Field(default=None, description="Pagination cursor from a previous call")


@tool("query_notion_database", args_schema=QueryNotionDatabaseArgs)
async def query_notion_database(
    databaseId: str,
    filter: str | None = None,
    sorts: str | None = None,
    pageSize: int | None = None,
    cursor: str | None = None,
) -> str:
    """Query a Notion database. Returns flattened rows with property values. Always call get_notion_database first to understand the schema."""
    try:
        body: dict[str, Any] = {"page_size": pageSize or 50}
        if filter:
            try:
                body["filter"] = json.loads(filter)
            except ValueError:
                return "Invalid filter JSON"
        if sorts:
            try:
                body["sorts"] = json.loads(sorts)
            except ValueError:
                return "Invalid sorts JSON"
        if cursor:
            body["start_cursor"] = cursor

        response = await get_client().post(
            f"{NOTION_API}/databases/{databaseId}/query", headers=await _headers(), json=body
        )
        if response.is_error:
            return f"Failed to query database ({response.status_code}): {response.text}"
        data = response.json()

        rows = []
        for item in data.get("results") or []:
            props: dict[str, Any] = {"_id": item.get("id"), "_url": item.get("url")}
            for key, value in (item.get("properties") or {}).items():
                extractor = _PROPERTY_EXTRACTORS.get(value.get("type"))
                props[key] = extractor(value) if extractor else f"({value.get('type')})"
            rows.append(props)

        return dumps({"rows": rows, "has_more": data.get("has_more"), "next_cursor": data.get("next_cursor")})
    except Exception as exc:
        logger.error("[notion] queryNotionDatabase", exc_info=exc)
        return f"Error querying database: {exc}"


class CreateDatabaseEntryArgs(BaseModel):
    databaseId: str = Field(description="Database ID (UUID)")
    properties: str = Field(
        description='JSON properties matching the database schema. e.g. \'{"Name":{"title":[{"text":{"content":"My task"}}]},"Status":{"select":{"name":"Todo"}},"Due":{"date":{"start":"2026-04-15"}}}\''
    )


@tool("create_database_entry", args_schema=CreateDatabaseEntryArgs)
async def create_database_entry(databaseId: str, properties: str) -> str:
    """Add a new row to a Notion database. Always call get_notion_database first to get the exact property names and types."""
    try:
        try:
            parsed = json.loads(properties)
        except ValueError:
            return "Invalid properties JSON"

        response = await get_client().post(
            f"{NOTION_API}/pages",
            headers=await _headers(),
            json={"parent": {"database_id": databaseId}, "properties": parsed},
        )
        if response.is_error:
            return f"Failed to create entry ({response.status_code}): {response.text}"
        page = response.json()
        return dumps({"id": page["id"], "url": page["url"], "message": "Entry created"})
    except Exception as exc:
        logger.error("[notion] createDatabaseEntry", exc_info=exc)
        return f"Error creating entry: {exc}"


class GetNotionCommentsArgs(BaseModel):
    blockId: str = Field(description="Page or block ID (UUID)")


@tool("get_notion_comments", args_schema=GetNotionCommentsArgs)
async def get_notion_comments(blockId: str) -> str:
    """List all comments on a Notion page or block."""
    try:
        response = await get_client().get(
            f"{NOTION_API}/comments", params={"block_id": blockId}, headers=await _headers()
        )
        if response.is_error:
            return f"Failed to get comments ({response.status_code}): {response.text}"
        data = response.json()
        comments = [
            {
                "id": comment.get("id"),
                "author": (comment.get("created_by") or {}).get("name") or "Unknown",
                "created": comment.get("created_time"),
                "text": "".join(part.get("plain_text", "") for part in comment.get("rich_text") or []),
            }
            for comment in data.get("results") or []
        ]
        return dumps(comments)
    except Exception as exc:
        logger.error("[notion] getNotionComments", exc_info=exc)
        return f"Error getting comments: {exc}"


class CreateNotionCommentArgs(BaseModel):
    pageId: str = Field(description="Page ID to comment on (UUID)")
    text: str = Field(description="Comment text")


@tool("create_notion_comment", args_schema=CreateNotionCommentArgs)
async def create_notion_comment(pageId: str, text: str) -> str:
    """Add a comment to a Notion page."""
    try:
        response = await get_client().post(
            f"{NOTION_API}/comments",
            headers=await _headers(),
            json={"parent": {"page_id": pageId}, "rich_text": _rich_text(text)},
        )
        if response.is_error:
            return f"Failed to create comment ({response.status_code}): {response.text}"
        comment = response.json()
        return f"Comment created on page {pageId}. Comment ID: {comment['id']}"
    except Exception as exc:
        logger.error("[notion] createNotionComment", exc_info=exc)
        return f"Error creating comment: {exc}"


@tool("list_notion_users")
async def list_notion_users() -> str:
    """List all users in the Notion workspace. Useful for getting user IDs for mentions or assignments."""
    try:
        response = await get_client().get(f"{NOTION_API}/users", headers=await _headers())
        if response.is_error:
            return f"Failed to list users ({response.status_code}): {response.text}"
        data = response.json()
        return dumps(
            [{"id": user.get("id"), "name": user.get("name"), "type": user.get("type")} for user in data.get("results") or []]
        )
    except Exception as exc:
        logger.error("[notion] listNotionUsers", exc_info=exc)
        return f"Error listing users: {exc}"


notion_tools = [
    search_notion,
    get_notion_page,
    get_block_children,
    get_notion_database,
    get_notion_comments,
    create_notion_page,
    update_notion_page_properties,
    trash_notion_page,
    append_notion_blocks,
    update_notion_block,
    delete_notion_block,
    create_notion_database,
    update_notion_database,
    query_notion_database,
    create_database_entry,
    create_notion_comment,
    list_notion_users,
]
