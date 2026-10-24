"""Typed errors replacing Hono's message-regex status mapping.

`src/workflows/routes.ts` derived the status code by matching the error *message*:

    /not found/i      -> 404
    /conflict|active run/i -> 409
    otherwise         -> 400

Carrying that forward as regexes would mean a reworded message silently changes an
HTTP status, so the ported code raises these instead. The response body stays
`{"error": "<message>"}`, which is what `web/`'s `workflowApi()` reads.
"""

from __future__ import annotations


class AppError(Exception):
    """Base for errors that map to a 4xx with the message passed through."""

    status_code = 400


class BadRequestError(AppError):
    status_code = 400


class NotFoundError(AppError):
    status_code = 404


class ConflictError(AppError):
    status_code = 409


class UnauthorizedError(AppError):
    status_code = 401


class ForbiddenError(AppError):
    status_code = 403
