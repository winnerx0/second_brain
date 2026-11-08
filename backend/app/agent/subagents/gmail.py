from __future__ import annotations

from functools import lru_cache
from typing import Any

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from app.agent.subagents.base import make_subagent, run_subagent
from app.tools.gmail import gmail_tools

GMAIL_SYSTEM_PROMPT = """You are an Email Assistant with access to the user's Gmail inbox.

You can:
- List and search emails using Gmail search syntax (from:, to:, is:unread, subject:, etc.)
- Read full email content
- Send new emails and reply to existing threads
- Archive emails and mark them as read

When helping:
- Always use list_emails first to find messages before reading or acting on them
- For send/reply/trash, draft or identify the target first and ask for confirmation before sending or trashing
- When archiving or marking read, find the correct message ID from list_emails then act
- Summarize emails concisely — subject, sender, date, and key points only
- Never fabricate email content; always read with get_email first
- If a tool returns an Error/Failed result, report that failure instead of treating it as success"""


@lru_cache(maxsize=1)
def _agent() -> Any:
    return make_subagent(gmail_tools)


class GmailArgs(BaseModel):
    query: str = Field(
        description=(
            "Natural language request for Gmail operations (e.g., 'Show my unread emails', "
            "'Send an email to alice@example.com about the meeting', 'Archive the email from Bob')"
        )
    )


@tool("gmail", args_schema=GmailArgs)
async def gmail_tool(query: str) -> str:
    """Read, search, send, reply, archive, and manage Gmail emails."""
    return await run_subagent(
        _agent(),
        [
            {"role": "system", "content": GMAIL_SYSTEM_PROMPT},
            {"role": "user", "content": query},
        ],
        "gmail",
    )
