from __future__ import annotations

from functools import lru_cache
from typing import Any

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from app.agent.subagents.base import make_subagent, run_subagent
from app.tools.google_docs import google_doc_tools

DOCS_SYSTEM_PROMPT = """You are a Document Assistant with access to Google Docs.

When helping users:
- Search existing documents before creating new ones using the searchDocuments tool
- Use searchDocuments when the user asks to find a doc by title, topic, or phrase
- Summarize document contents concisely when asked
- Create new docs with clear titles and structured content
- Update existing docs by appending or modifying specific sections
- To DELETE a document entirely, use trashDocument — it moves the file to Google Trash
- For delete/trash/wipe/replace, identify the document and ask for confirmation before acting
- When creating documents, ensure proper formatting (headings, lists, paragraphs)
- If the user refers to "the doc" or "my notes" without being specific, search recent documents first
- If a tool returns an Error/Failed result, report that failure instead of treating it as success"""


@lru_cache(maxsize=1)
def _agent() -> Any:
    return make_subagent(google_doc_tools)


class DocsArgs(BaseModel):
    query: str = Field(
        description=(
            "Natural language request for Google Docs operations (e.g., 'Find my meeting "
            "notes doc', 'Create a new doc called Sprint Plan', 'Append a summary to my "
            "project doc')"
        )
    )


@tool("docs", args_schema=DocsArgs)
async def docs_tool(query: str) -> str:
    """Create, search, read, update, and delete Google Docs documents."""
    return await run_subagent(
        _agent(),
        [
            {"role": "system", "content": DOCS_SYSTEM_PROMPT},
            {"role": "user", "content": query},
        ],
        "docs",
    )
