from __future__ import annotations

import re
from typing import Any

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from app.http import get_client
from app.json import dumps
from app.logging import get_logger
from app.tools.google_auth import google_access_token

logger = get_logger("google-docs")

DOCS_API = "https://docs.googleapis.com/v1/documents"
DRIVE_API = "https://www.googleapis.com/drive/v3/files"


async def _headers() -> dict[str, str]:
    # Only the google_docs token — never fall back to gmail's token. Gmail's token
    # only carries gmail.modify scope and is rejected by the Docs/Drive APIs.
    token = await google_access_token("google_docs", None)
    return {"Authorization": f"Bearer {token}"}


def _escape_drive_query_value(value: str) -> str:
    return value.replace("\\", "\\\\").replace("'", "\\'")


async def _get_document(document_id: str) -> dict[str, Any]:
    response = await get_client().get(f"{DOCS_API}/{document_id}", headers=await _headers())
    response.raise_for_status()
    return response.json()


async def _batch_update(document_id: str, requests: list[dict[str, Any]]) -> dict[str, Any]:
    response = await get_client().post(
        f"{DOCS_API}/{document_id}:batchUpdate",
        headers={**(await _headers()), "Content-Type": "application/json"},
        json={"requests": requests},
    )
    response.raise_for_status()
    return response.json()


async def _end_index(document_id: str) -> int:
    doc = await _get_document(document_id)
    content = (doc.get("body") or {}).get("content") or []
    return content[-1].get("endIndex", 1) if content else 1


class ReadDocumentArgs(BaseModel):
    documentId: str = Field(description="Google Docs document ID (from the URL)")


@tool("readDocument", args_schema=ReadDocumentArgs)
async def read_document(documentId: str) -> str:
    """Read the full text content of a Google Doc."""
    try:
        doc = await _get_document(documentId)
        text = "".join(
            element.get("textRun", {}).get("content", "")
            for block in (doc.get("body") or {}).get("content") or []
            for element in block.get("paragraph", {}).get("elements") or []
        )
        return dumps({"documentId": doc.get("documentId"), "title": doc.get("title"), "text": text.strip()})
    except Exception as exc:
        logger.error("[google-docs] readDocument", exc_info=exc)
        return f"Error reading document: {exc}"


class SearchDocumentsArgs(BaseModel):
    query: str = Field(description="Search text for the document title or body")
    limit: int | None = Field(default=None, description="Maximum number of matches to return")


@tool("searchDocuments", args_schema=SearchDocumentsArgs)
async def search_documents(query: str, limit: int | None = None) -> str:
    """Search Google Docs by title or document content and return matching document links."""
    try:
        escaped = _escape_drive_query_value(query.strip())
        q = " and ".join(
            [
                "mimeType='application/vnd.google-apps.document'",
                "trashed=false",
                f"(name contains '{escaped}' or fullText contains '{escaped}')",
            ]
        )
        response = await get_client().get(
            DRIVE_API,
            params={
                "q": q,
                "pageSize": min(max(limit or 10, 1), 25),
                "fields": "files(id, name, webViewLink, modifiedTime, owners(displayName))",
                "orderBy": "modifiedTime desc",
                "supportsAllDrives": "true",
                "includeItemsFromAllDrives": "true",
            },
            headers=await _headers(),
        )
        if response.is_error:
            return f"Error searching documents: {response.text}"
        files = response.json().get("files") or []
        return dumps(
            [
                {
                    "documentId": file.get("id"),
                    "title": file.get("name"),
                    "url": file.get("webViewLink"),
                    "modifiedTime": file.get("modifiedTime"),
                    "owner": (file.get("owners") or [{}])[0].get("displayName"),
                }
                for file in files
            ]
        )
    except Exception as exc:
        logger.error("[google-docs] searchDocuments", exc_info=exc)
        return f"Error searching documents: {exc}"


class AppendTextArgs(BaseModel):
    documentId: str = Field(description="Google Docs document ID")
    text: str = Field(description="Text to append")


@tool("appendText", args_schema=AppendTextArgs)
async def append_text(documentId: str, text: str) -> str:
    """Append text to the end of a Google Doc."""
    try:
        insert_index = max(1, await _end_index(documentId) - 1)
        await _batch_update(
            documentId,
            [{"insertText": {"location": {"index": insert_index}, "text": f"\n{text}"}}],
        )
        return f"Text appended to document {documentId}."
    except Exception as exc:
        logger.error("[google-docs] appendText", exc_info=exc)
        return f"Error appending text: {exc}"


class InsertTextArgs(BaseModel):
    documentId: str = Field(description="Google Docs document ID")
    text: str = Field(description="Text to insert")
    index: int = Field(description="Character index to insert at (1-based)")


@tool("insertText", args_schema=InsertTextArgs)
async def insert_text(documentId: str, text: str, index: int) -> str:
    """Insert text at a specific character index in a Google Doc."""
    try:
        await _batch_update(documentId, [{"insertText": {"location": {"index": index}, "text": text}}])
        return f"Text inserted at index {index} in document {documentId}."
    except Exception as exc:
        logger.error("[google-docs] insertText", exc_info=exc)
        return f"Error inserting text: {exc}"


class FindAndReplaceArgs(BaseModel):
    documentId: str = Field(description="Google Docs document ID")
    find: str = Field(description="Text to find")
    replaceWith: str = Field(description="Replacement text")


@tool("findAndReplace", args_schema=FindAndReplaceArgs)
async def find_and_replace(documentId: str, find: str, replaceWith: str) -> str:
    """Find and replace all occurrences of a string in a Google Doc."""
    try:
        await _batch_update(
            documentId,
            [
                {
                    "replaceAllText": {
                        "containsText": {"text": find, "matchCase": True},
                        "replaceText": replaceWith,
                    }
                }
            ],
        )
        return f'Replaced all occurrences of "{find}" with "{replaceWith}" in document {documentId}.'
    except Exception as exc:
        logger.error("[google-docs] findAndReplace", exc_info=exc)
        return f"Error replacing text: {exc}"


class DeleteRangeArgs(BaseModel):
    documentId: str = Field(description="Google Docs document ID")
    startIndex: int = Field(description="Start index (inclusive)")
    endIndex: int = Field(description="End index (exclusive)")


@tool("deleteRange", args_schema=DeleteRangeArgs)
async def delete_range(documentId: str, startIndex: int, endIndex: int) -> str:
    """Delete a range of content in a Google Doc by character indices."""
    try:
        await _batch_update(
            documentId,
            [{"deleteContentRange": {"range": {"startIndex": startIndex, "endIndex": endIndex}}}],
        )
        return f"Deleted content from index {startIndex} to {endIndex} in document {documentId}."
    except Exception as exc:
        logger.error("[google-docs] deleteRange", exc_info=exc)
        return f"Error deleting range: {exc}"


def _markdown_to_plain(markdown: str) -> str:
    plain = re.sub(r"^#{1,6}\s+", "", markdown, flags=re.MULTILINE)
    plain = re.sub(r"\*\*(.*?)\*\*", r"\1", plain)
    plain = re.sub(r"\*(.*?)\*", r"\1", plain)
    plain = re.sub(r"`(.*?)`", r"\1", plain)
    plain = re.sub(r"\[(.*?)\]\(.*?\)", r"\1", plain)
    return plain


class AppendMarkdownArgs(BaseModel):
    documentId: str = Field(description="Google Docs document ID")
    markdown: str = Field(description="Markdown text to append")


@tool("appendMarkdown", args_schema=AppendMarkdownArgs)
async def append_markdown(documentId: str, markdown: str) -> str:
    """Append markdown-formatted text to the end of a Google Doc (converted to plain text)."""
    plain = _markdown_to_plain(markdown)
    try:
        insert_index = max(1, await _end_index(documentId) - 1)
        await _batch_update(
            documentId,
            [{"insertText": {"location": {"index": insert_index}, "text": f"\n{plain}"}}],
        )
        return f"Markdown appended to document {documentId}."
    except Exception as exc:
        logger.error("[google-docs] appendMarkdown", exc_info=exc)
        return f"Error appending markdown: {exc}"


class CreateDocumentArgs(BaseModel):
    title: str = Field(description="Title of the new document")
    content: str | None = Field(default=None, description="Optional initial text content for the document")


@tool("createDocument", args_schema=CreateDocumentArgs)
async def create_document(title: str, content: str | None = None) -> str:
    """Create a new Google Doc with the given title and optional initial content."""
    try:
        response = await get_client().post(
            DOCS_API,
            headers={**(await _headers()), "Content-Type": "application/json"},
            json={"title": title},
        )
        if response.is_error:
            return f"Error creating document: {response.text}"
        created = response.json()
        document_id = created["documentId"]

        if content:
            await _batch_update(document_id, [{"insertText": {"location": {"index": 1}, "text": content}}])

        return dumps(
            {
                "documentId": document_id,
                "title": created.get("title"),
                "url": f"https://docs.google.com/document/d/{document_id}/edit",
            }
        )
    except Exception as exc:
        logger.error("[google-docs] createDocument", exc_info=exc)
        return f"Error creating document: {exc}"


class TrashDocumentArgs(BaseModel):
    documentId: str = Field(description="Google Docs document ID (from the URL)")


@tool("trashDocument", args_schema=TrashDocumentArgs)
async def trash_document(documentId: str) -> str:
    """Move a Google Doc to the trash (equivalent to deleting it). The file can be restored from Trash within 30 days."""
    try:
        response = await get_client().patch(
            f"{DRIVE_API}/{documentId}",
            headers={**(await _headers()), "Content-Type": "application/json"},
            json={"trashed": True},
        )
        if response.is_error:
            return f"Error trashing document: {response.text}"
        return f"Document {documentId} moved to trash."
    except Exception as exc:
        logger.error("[google-docs] trashDocument", exc_info=exc)
        return f"Error trashing document: {exc}"


google_doc_tools = [
    search_documents,
    read_document,
    create_document,
    append_text,
    insert_text,
    find_and_replace,
    delete_range,
    append_markdown,
    trash_document,
]
