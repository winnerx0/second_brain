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
