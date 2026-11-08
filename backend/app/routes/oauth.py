from __future__ import annotations

from urllib.parse import quote

from fastapi import APIRouter, Response
from fastapi.responses import RedirectResponse

from app.config import get_settings
from app.oauth import handle_callback

router = APIRouter(tags=["oauth"])


@router.get("/oauth/callback")
async def oauth_callback(
    code: str | None = None, state: str | None = None, error: str | None = None
) -> Response:
    app_url = get_settings().app_url

    if error:
        return RedirectResponse(
            f"{app_url}/connections?oauth_error={quote(error, safe='')}", status_code=302
        )
    if not code or not state:
        return RedirectResponse(
            f"{app_url}/connections?oauth_error=missing_params", status_code=302
        )

    result = await handle_callback(code, state)
    if "error" in result:
        return RedirectResponse(
            f"{app_url}/connections?oauth_error={quote(result['error'], safe='')}",
            status_code=302,
        )
    return RedirectResponse(
        f"{app_url}/connections?oauth_connected={result['connectionName']}", status_code=302
    )
