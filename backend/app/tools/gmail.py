from __future__ import annotations

import base64
import re
from typing import Any

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from app.config import get_settings
from app.http import get_client
from app.json import dumps
from app.logging import get_logger
from app.tools.google_auth import google_access_token

logger = get_logger("gmail")

GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me"


async def _headers() -> dict[str, str]:
    token = await google_access_token("gmail", get_settings().GMAIL_REFRESH_TOKEN)
    return {"Authorization": f"Bearer {token}"}


def _get_header(headers: list[dict[str, Any]], name: str) -> str:
    for header in headers:
        if (header.get("name") or "").lower() == name.lower():
            return header.get("value") or ""
    return ""


def _decode_part(data: str) -> str:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)).decode("utf-8", "replace")


def _decode_body(payload: dict[str, Any]) -> str:
    body_data = (payload.get("body") or {}).get("data")
    if body_data:
        return _decode_part(body_data)
    parts = payload.get("parts") or []
    for part in parts:
        if part.get("mimeType") == "text/plain" and (part.get("body") or {}).get("data"):
            return _decode_part(part["body"]["data"])
    for part in parts:
        if part.get("mimeType") == "text/html" and (part.get("body") or {}).get("data"):
            return _decode_part(part["body"]["data"])
    return "(no body)"


def _build_raw(
    to: str,
    subject: str,
    body: str,
    cc: str | None = None,
    reply_message_id: str | None = None,
    reply_references: str | None = None,
) -> str:
    lines = [
        f"To: {to}",
        f"Subject: {subject}",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
    ]
    if cc:
        lines.append(f"Cc: {cc}")
    if reply_message_id is not None:
        lines.append(f"In-Reply-To: {reply_message_id}")
        lines.append(f"References: {reply_references}")
    lines.append("")
    lines.append(body)
    raw = "\r\n".join(lines).encode("utf-8")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


class ListEmailsArgs(BaseModel):
    query: str | None = Field(
        default=None, description="Gmail search query. Omit to list recent inbox messages."
    )
    maxResults: int | None = Field(default=None, description="Max number of results (default 10).")


@tool("list_emails", args_schema=ListEmailsArgs)
async def list_emails(query: str | None = None, maxResults: int | None = None) -> str:
    """List or search emails in Gmail. Supports Gmail search syntax (e.g. 'is:unread from:alice@example.com label:inbox')."""
    try:
        headers = await _headers()
        params: dict[str, Any] = {"maxResults": maxResults or 10}
        if query:
            params["q"] = query
        list_response = await get_client().get(f"{GMAIL_API}/messages", params=params, headers=headers)
        if list_response.is_error:
            return f"Error listing emails: {list_response.text}"
        messages = list_response.json().get("messages") or []
        if not messages:
            return "No messages found."

        details = []
        for message in messages:
            detail_response = await get_client().get(
                f"{GMAIL_API}/messages/{message['id']}",
                params={
                    "format": "metadata",
                    "metadataHeaders": ["From", "Subject", "Date"],
                },
                headers=headers,
            )
            details.append(detail_response.json())

        return dumps(
            [
                {
                    "id": detail.get("id"),
                    "from": _get_header((detail.get("payload") or {}).get("headers") or [], "from"),
                    "subject": _get_header(
                        (detail.get("payload") or {}).get("headers") or [], "subject"
                    ),
                    "date": _get_header((detail.get("payload") or {}).get("headers") or [], "date"),
                    "snippet": detail.get("snippet") or "",
                }
                for detail in details
            ]
        )
    except Exception as exc:
        logger.error("[gmail] listEmails", exc_info=exc)
        return f"Error listing emails: {exc}"


class GetEmailArgs(BaseModel):
    messageId: str = Field(description="Gmail message ID (from list_emails).")


@tool("get_email", args_schema=GetEmailArgs)
async def get_email(messageId: str) -> str:
    """Fetch the full content of an email by its message ID."""
    try:
        headers = await _headers()
        response = await get_client().get(
            f"{GMAIL_API}/messages/{messageId}", params={"format": "full"}, headers=headers
        )
        if response.is_error:
            return f"Error fetching email: {response.text}"
        data = response.json()
        payload = data.get("payload") or {}
        hdrs = payload.get("headers") or []
        body = _decode_body(payload) if payload else "(no body)"
        return dumps(
            {
                "id": data.get("id"),
                "threadId": data.get("threadId"),
                "from": _get_header(hdrs, "from"),
                "to": _get_header(hdrs, "to"),
                "subject": _get_header(hdrs, "subject"),
                "date": _get_header(hdrs, "date"),
                "messageId": _get_header(hdrs, "message-id"),
                "body": body,
            }
        )
    except Exception as exc:
        logger.error("[gmail] getEmail", exc_info=exc)
        return f"Error fetching email: {exc}"


class SendEmailArgs(BaseModel):
    to: str = Field(description="Recipient email address.")
    subject: str = Field(description="Email subject.")
    body: str = Field(description="Plain text email body.")
    cc: str | None = Field(default=None, description="CC email address.")


@tool("send_email", args_schema=SendEmailArgs)
async def send_email(to: str, subject: str, body: str, cc: str | None = None) -> str:
    """Compose and send a new email."""
    try:
        headers = await _headers()
        raw = _build_raw(to, subject, body, cc)
        response = await get_client().post(
            f"{GMAIL_API}/messages/send",
            headers={**headers, "Content-Type": "application/json"},
            json={"raw": raw},
        )
        if response.is_error:
            return f"Error sending email: {response.text}"
        return f"Email sent. Message ID: {response.json().get('id')}"
    except Exception as exc:
        logger.error("[gmail] sendEmail", exc_info=exc)
        return f"Error sending email: {exc}"


class ReplyToEmailArgs(BaseModel):
    messageId: str = Field(description="Gmail message ID of the email to reply to.")
    body: str = Field(description="Reply body text.")


@tool("reply_to_email", args_schema=ReplyToEmailArgs)
async def reply_to_email(messageId: str, body: str) -> str:
    """Reply to an existing email thread."""
    try:
        headers = await _headers()
        original_response = await get_client().get(
            f"{GMAIL_API}/messages/{messageId}", params={"format": "full"}, headers=headers
        )
        if original_response.is_error:
            return f"Error replying: {original_response.text}"
        original = original_response.json()
        hdrs = (original.get("payload") or {}).get("headers") or []
        to = _get_header(hdrs, "from")
        subject = "Re: " + re.sub(r"^Re:\s*", "", _get_header(hdrs, "subject"), flags=re.IGNORECASE)
        orig_message_id = _get_header(hdrs, "message-id")
        references = " ".join(
            value for value in (_get_header(hdrs, "references"), orig_message_id) if value
        )
        raw = _build_raw(to, subject, body, reply_message_id=orig_message_id, reply_references=references)

        send_response = await get_client().post(
            f"{GMAIL_API}/messages/send",
            headers={**headers, "Content-Type": "application/json"},
            json={"raw": raw, "threadId": original.get("threadId")},
        )
        if send_response.is_error:
            return f"Error replying: {send_response.text}"
        return f"Reply sent. Message ID: {send_response.json().get('id')}"
    except Exception as exc:
        logger.error("[gmail] replyToEmail", exc_info=exc)
        return f"Error replying: {exc}"


class ArchiveEmailArgs(BaseModel):
    messageId: str = Field(description="Gmail message ID to archive.")


@tool("archive_email", args_schema=ArchiveEmailArgs)
async def archive_email(messageId: str) -> str:
    """Archive an email (remove from inbox without deleting)."""
    try:
        headers = await _headers()
        response = await get_client().post(
            f"{GMAIL_API}/messages/{messageId}/modify",
            headers={**headers, "Content-Type": "application/json"},
            json={"removeLabelIds": ["INBOX"]},
        )
        if response.is_error:
            return f"Error archiving: {response.text}"
        return f"Email {messageId} archived."
    except Exception as exc:
        logger.error("[gmail] archiveEmail", exc_info=exc)
        return f"Error archiving: {exc}"


class MarkEmailReadArgs(BaseModel):
    messageId: str = Field(description="Gmail message ID to mark as read.")


@tool("mark_email_read", args_schema=MarkEmailReadArgs)
async def mark_email_read(messageId: str) -> str:
    """Mark an email as read."""
    try:
        headers = await _headers()
        response = await get_client().post(
            f"{GMAIL_API}/messages/{messageId}/modify",
            headers={**headers, "Content-Type": "application/json"},
            json={"removeLabelIds": ["UNREAD"]},
        )
        if response.is_error:
            return f"Error marking as read: {response.text}"
        return f"Email {messageId} marked as read."
    except Exception as exc:
        logger.error("[gmail] markEmailRead", exc_info=exc)
        return f"Error marking as read: {exc}"


class TrashEmailArgs(BaseModel):
    messageId: str = Field(description="Gmail message ID to trash.")


@tool("trash_email", args_schema=TrashEmailArgs)
async def trash_email(messageId: str) -> str:
    """Move an email to trash."""
    try:
        headers = await _headers()
        response = await get_client().post(f"{GMAIL_API}/messages/{messageId}/trash", headers=headers)
        if response.is_error:
            return f"Error trashing email: {response.text}"
        return f"Email {messageId} moved to trash."
    except Exception as exc:
        logger.error("[gmail] trashEmail", exc_info=exc)
        return f"Error trashing email: {exc}"


@tool("list_gmail_labels")
async def list_gmail_labels() -> str:
    """List all Gmail labels (inbox, sent, custom labels, etc)."""
    try:
        headers = await _headers()
        response = await get_client().get(f"{GMAIL_API}/labels", headers=headers)
        if response.is_error:
            return f"Error listing labels: {response.text}"
        labels = response.json().get("labels") or []
        return dumps(
            [{"id": label.get("id"), "name": label.get("name"), "type": label.get("type")} for label in labels]
        )
    except Exception as exc:
        logger.error("[gmail] listLabels", exc_info=exc)
        return f"Error listing labels: {exc}"


class ApplyGmailLabelArgs(BaseModel):
    messageId: str = Field(description="Gmail message ID.")
    addLabelIds: list[str] | None = Field(default=None, description="Label IDs to add.")
    removeLabelIds: list[str] | None = Field(default=None, description="Label IDs to remove.")


@tool("apply_gmail_label", args_schema=ApplyGmailLabelArgs)
async def apply_gmail_label(
    messageId: str, addLabelIds: list[str] | None = None, removeLabelIds: list[str] | None = None
) -> str:
    """Add or remove labels on an email. Use list_gmail_labels to get label IDs."""
    try:
        headers = await _headers()
        payload: dict[str, Any] = {}
        if addLabelIds:
            payload["addLabelIds"] = addLabelIds
        if removeLabelIds:
            payload["removeLabelIds"] = removeLabelIds
        response = await get_client().post(
            f"{GMAIL_API}/messages/{messageId}/modify",
            headers={**headers, "Content-Type": "application/json"},
            json=payload,
        )
        if response.is_error:
            return f"Error updating labels: {response.text}"
        return f"Labels updated on message {messageId}."
    except Exception as exc:
        logger.error("[gmail] applyLabel", exc_info=exc)
        return f"Error updating labels: {exc}"


class GetEmailThreadArgs(BaseModel):
    threadId: str = Field(description="Gmail thread ID (from get_email's threadId field).")


@tool("get_email_thread", args_schema=GetEmailThreadArgs)
async def get_email_thread(threadId: str) -> str:
    """Fetch all messages in an email thread."""
    try:
        headers = await _headers()
        response = await get_client().get(
            f"{GMAIL_API}/threads/{threadId}", params={"format": "metadata"}, headers=headers
        )
        if response.is_error:
            return f"Error fetching thread: {response.text}"
        data = response.json()
        messages = [
            {
                "id": message.get("id"),
                "from": _get_header((message.get("payload") or {}).get("headers") or [], "from"),
                "subject": _get_header((message.get("payload") or {}).get("headers") or [], "subject"),
                "date": _get_header((message.get("payload") or {}).get("headers") or [], "date"),
                "snippet": message.get("snippet"),
            }
            for message in data.get("messages") or []
        ]
        return dumps({"threadId": threadId, "messageCount": len(messages), "messages": messages})
    except Exception as exc:
        logger.error("[gmail] getThreadEmails", exc_info=exc)
        return f"Error fetching thread: {exc}"


gmail_tools = [
    list_emails,
    get_email,
    send_email,
    reply_to_email,
    archive_email,
    mark_email_read,
    trash_email,
    list_gmail_labels,
    apply_gmail_label,
    get_email_thread,
]
