from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Request, Response
from fastapi.responses import StreamingResponse
from sqlalchemy import text

from app.config import get_settings
from app.db.engine import fetch_all, session_scope
from app.errors import BadRequestError
from app.json import JsonResponse, dumps
from app.logging import get_logger
from app.sse import SSE_HEADERS, SSE_MEDIA_TYPE, frame
from app.workflows.planner import plan_workflow
from app.workflows.service import (
    accept_proposal,
    enqueue,
    get_run,
    get_workflow,
    save_workflow,
    set_enabled,
)

router = APIRouter(prefix="/workflows", tags=["workflows"])
logger = get_logger("workflows")

#: `LIMIT 30` on run history, and `LIMIT 100` per SSE poll.
RUN_PAGE_SIZE = 30
EVENT_PAGE_SIZE = 100
#: The run-events stream polls once a second.
EVENT_POLL_SECONDS = 1.0
#: Postgres' int4 max, the default `before` cursor.
INT4_MAX = 2_147_483_647


def id_of(value: str) -> int:
    """`z.coerce.number().int().positive().parse(...)`, which produced a 400.

    Path parameters are declared as `str` and parsed here because a FastAPI `int`
    parameter would return 422 with a different body for a non-numeric segment.
    """
    try:
        parsed = int(value)
    except ValueError:
        raise BadRequestError(f"Invalid id: {value}") from None
    if parsed <= 0:
        raise BadRequestError(f"Invalid id: {value}")
    return parsed


async def _json_body(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except Exception:
        raise BadRequestError("A JSON body is required") from None
    if not isinstance(body, dict):
        raise BadRequestError("A JSON body is required")
    return body


# ─── literal paths: must precede /{workflow_id} ─────────────────────────────


@router.get("/health")
async def workflows_health() -> Response:
    """Worker liveness and queue depth. The container healthcheck reads this."""
    workers = (
        await fetch_all(
            "SELECT count(*)::int AS workers FROM workflow_workers "
            "WHERE heartbeat_at > now() - interval '45 seconds'"
        )
    )[0].workers
    counts = await fetch_all(
        "SELECT status, count(*)::int AS count FROM workflow_runs GROUP BY status"
    )
    overdue = (
        await fetch_all(
            "SELECT count(*)::int AS count FROM workflows WHERE enabled AND next_run_at < now()"
        )
    )[0].count

    return JsonResponse(
        {
            "workers": workers,
            "schedulerEnabled": get_settings().SCHEDULER_ENABLED,
            # Raw rows: each is {status, count}.
            "runs": [{"status": row.status, "count": row.count} for row in counts],
            "overdue": overdue,
        }
    )


@router.post("/plan")
async def plan(request: Request) -> Response:
    body = await _json_body(request)
    instructions = body.get("instructions")
    if not isinstance(instructions, str) or not instructions:
        raise BadRequestError("instructions is required")
    return JsonResponse(await plan_workflow(instructions))


@router.get("")
@router.get("/")
async def list_workflows() -> Response:
    """All workflows with their active definition and last run status.

    `last_status` stays snake_case while `activeRevision`/`nextRunAt`/`lastRunAt` are
    camelCase — that mix is what the web client declares.
    """
    rows = await fetch_all(
        "SELECT w.*, r.definition, "
        "(SELECT status FROM workflow_runs WHERE workflow_id = w.id "
        " ORDER BY id DESC LIMIT 1) AS last_status "
        "FROM workflows w "
        "LEFT JOIN workflow_revisions r "
        "  ON r.workflow_id = w.id AND r.version = w.active_revision "
        "ORDER BY w.updated_at DESC"
    )
    return JsonResponse(
        {
            "workflows": [
                {
                    **dict(row._mapping),
                    "activeRevision": row.active_revision,
                    "nextRunAt": row.next_run_at,
                    "lastRunAt": row.last_run_at,
                }
                for row in rows
            ]
        }
    )


@router.post("", status_code=201)
@router.post("/", status_code=201)
async def create_workflow(request: Request) -> Response:
    body = await _json_body(request)
    enabled = body.get("enabled", True)
    workflow_id = await save_workflow(
        body.get("definition"), None, None, bool(enabled) if enabled is not None else True
    )
    return JsonResponse(await get_workflow(workflow_id), status_code=201)


@router.get("/runs/{run_id}")
async def read_run(run_id: str) -> Response:
    return JsonResponse(await get_run(id_of(run_id)))


@router.post("/runs/{run_id}/cancel")
async def cancel_run(run_id: str) -> Response:
    """Request cancellation.

    Only flips a queued run straight to `cancelled`; a running one is asked to stop
    via `cancel_requested` and the executor notices on its next checkpoint. An
    external call already issued cannot be undone.
    """
    identifier = id_of(run_id)
    async with session_scope() as session:
        await session.execute(
            text(
                "UPDATE workflow_runs SET cancel_requested = true, "
                "status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END "
                "WHERE id = :id AND status IN ('queued', 'running')"
            ),
            {"id": identifier},
        )
    return JsonResponse(await get_run(identifier))


@router.post("/runs/{run_id}/feedback")
async def run_feedback(run_id: str, request: Request) -> Response:
    """Attach feedback and re-open the run for reflection."""
    body = await _json_body(request)
    feedback = body.get("feedback")
    if not isinstance(feedback, str) or not 1 <= len(feedback) <= 4000:
        raise BadRequestError("feedback must be between 1 and 4000 characters")

    async with session_scope() as session:
        await session.execute(
            text("UPDATE workflow_runs SET feedback = :feedback, learned = false WHERE id = :id"),
            {"id": id_of(run_id), "feedback": feedback},
        )
    return JsonResponse({"success": True})


@router.get("/runs/{run_id}/events")
async def run_events(run_id: str, request: Request) -> Response:
    """Live run events as SSE, resumable via `Last-Event-ID` or `?after=`.

    Frames carry `id:` so EventSource resumes automatically after a reconnect. The
    terminal condition requires both a non-active status *and* a short final page —
    ending the stream on status alone would truncate a burst of events that had not
    been drained yet.
    """
    identifier = id_of(run_id)
    # 404 before the stream starts if the run does not exist; once the response has
    # begun, no status code can be sent.
    await get_run(identifier)

    raw_cursor = request.headers.get("last-event-id") or request.query_params.get("after") or "0"
    try:
        cursor = int(raw_cursor)
    except ValueError:
        raise BadRequestError(f"Invalid cursor: {raw_cursor}") from None
    if cursor < 0:
        raise BadRequestError(f"Invalid cursor: {raw_cursor}")

    async def generate():
        position = cursor
        while not await request.is_disconnected():
            rows = await fetch_all(
                "SELECT id, event FROM workflow_events "
                "WHERE run_id = :id AND id > :cursor ORDER BY id LIMIT :limit",
                {"id": identifier, "cursor": position, "limit": EVENT_PAGE_SIZE},
            )
            for row in rows:
                yield frame(dumps(row.event), event_id=str(row.id))
                position = row.id

            status = (
                await fetch_all(
                    "SELECT status FROM workflow_runs WHERE id = :id", {"id": identifier}
                )
            )[0].status

            if status not in ("queued", "running") and len(rows) < EVENT_PAGE_SIZE:
                yield frame(dumps({"status": status}), event="done")
                return

            # A *named* heartbeat event, not a comment — a client may be
            # listening for it.
            yield frame("{}", event="heartbeat")
            await asyncio.sleep(EVENT_POLL_SECONDS)

    return StreamingResponse(generate(), media_type=SSE_MEDIA_TYPE, headers=SSE_HEADERS)


@router.post("/proposals/{proposal_id}/accept")
async def accept(proposal_id: str) -> Response:
    return JsonResponse(await get_workflow(await accept_proposal(id_of(proposal_id))))


@router.post("/proposals/{proposal_id}/reject")
async def reject(proposal_id: str) -> Response:
    async with session_scope() as session:
        await session.execute(
            text(
                "UPDATE workflow_proposals SET status = 'rejected' "
                "WHERE id = :id AND status = 'pending'"
            ),
            {"id": id_of(proposal_id)},
        )
    return JsonResponse({"success": True})


@router.patch("/lessons/{lesson_id}")
async def update_lesson(lesson_id: str, request: Request) -> Response:
    """Correct a lesson, or forget it with `{"active": false}`.

    A user edit is authoritative, so confidence is pinned to 1.
    """
    body = await _json_body(request)
    lesson = body.get("lesson")
    active = body.get("active")
    if lesson is not None and (not isinstance(lesson, str) or not 1 <= len(lesson) <= 4000):
        raise BadRequestError("lesson must be between 1 and 4000 characters")
    if active is not None and not isinstance(active, bool):
        raise BadRequestError("active must be a boolean")

    async with session_scope() as session:
        await session.execute(
            text(
                "UPDATE workflow_lessons "
                "SET lesson = COALESCE(:lesson, lesson), "
                "    active = COALESCE(:active, active), "
                "    confidence = 1 "
                "WHERE id = :id"
            ),
            {"id": id_of(lesson_id), "lesson": lesson, "active": active},
        )
    return JsonResponse({"success": True})


# ─── parameterised paths ────────────────────────────────────────────────────


@router.get("/{workflow_id}")
async def read_workflow(workflow_id: str) -> Response:
    return JsonResponse(await get_workflow(id_of(workflow_id)))


@router.patch("/{workflow_id}")
async def patch_workflow(workflow_id: str, request: Request) -> Response:
    """Either revise the definition, or just toggle `enabled`."""
    identifier = id_of(workflow_id)
    body = await _json_body(request)

    allowed = {"definition", "expectedRevision", "enabled"}
    unexpected = set(body) - allowed
    if unexpected:
        # Strict: unknown fields are rejected.
        raise BadRequestError(f"Unexpected field(s): {', '.join(sorted(unexpected))}")

    if body.get("definition") is not None:
        enabled = body.get("enabled")
        if enabled is None:
            enabled = (await get_workflow(identifier))["enabled"]
        await save_workflow(
            body["definition"], identifier, body.get("expectedRevision"), bool(enabled)
        )
    elif body.get("enabled") is not None:
        await set_enabled(identifier, bool(body["enabled"]))

    return JsonResponse(await get_workflow(identifier))


@router.delete("/{workflow_id}")
async def delete_workflow(workflow_id: str) -> Response:
    """Delete a workflow and its history. Refused while a run is executing."""
    from app.db.engine import sql_transaction
    from app.errors import ConflictError

    identifier = id_of(workflow_id)
    async with sql_transaction() as conn:
        await conn.execute(
            text("SELECT id FROM workflows WHERE id = :id FOR UPDATE"), {"id": identifier}
        )
        active = (
            await conn.execute(
                text("SELECT id FROM workflow_runs WHERE workflow_id = :id AND status = 'running'"),
                {"id": identifier},
            )
        ).scalar_one_or_none()
        if active is not None:
            raise ConflictError("Cancel the active run before deleting this workflow")
        await conn.execute(text("DELETE FROM workflows WHERE id = :id"), {"id": identifier})
    return JsonResponse({"success": True})


@router.post("/{workflow_id}/run", status_code=202)
async def run_workflow(workflow_id: str) -> Response:
    """Queue a run. 202, not 200 — the work has not happened yet."""
    return JsonResponse({"runId": await enqueue(id_of(workflow_id))}, status_code=202)


@router.get("/{workflow_id}/runs")
async def list_runs(workflow_id: str, before: str | None = None) -> Response:
    """Run history, newest first, paginated by descending id."""
    try:
        cursor = int(before) if before else INT4_MAX
    except ValueError:
        raise BadRequestError(f"Invalid cursor: {before}") from None
    if cursor <= 0:
        raise BadRequestError(f"Invalid cursor: {before}")

    rows = await fetch_all(
        "SELECT * FROM workflow_runs WHERE workflow_id = :id AND id < :before "
        "ORDER BY id DESC LIMIT :limit",
        {"id": id_of(workflow_id), "before": cursor, "limit": RUN_PAGE_SIZE},
    )
    return JsonResponse({"runs": [dict(row._mapping) for row in rows]})


@router.get("/{workflow_id}/learning")
async def workflow_learning(workflow_id: str) -> Response:
    """Active lessons, every proposal, and the full revision history."""
    identifier = id_of(workflow_id)
    lessons, proposals, revisions = await asyncio.gather(
        fetch_all(
            "SELECT * FROM workflow_lessons WHERE workflow_id = :id AND active ORDER BY id DESC",
            {"id": identifier},
        ),
        fetch_all(
            "SELECT * FROM workflow_proposals WHERE workflow_id = :id ORDER BY id DESC",
            {"id": identifier},
        ),
        fetch_all(
            "SELECT * FROM workflow_revisions WHERE workflow_id = :id ORDER BY version DESC",
            {"id": identifier},
        ),
    )
    return JsonResponse(
        {
            "lessons": [dict(row._mapping) for row in lessons],
            "proposals": [dict(row._mapping) for row in proposals],
            "revisions": [dict(row._mapping) for row in revisions],
        }
    )
