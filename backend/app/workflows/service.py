"""Workflow persistence — port of `src/workflows/service.ts`.

Every mutation runs in a transaction that takes `SELECT ... FOR UPDATE` on the
workflow row first, which is what serialises concurrent edits, enqueues and
pause/resume against each other.

Revision model: editing a workflow writes a new `workflow_revisions` row and bumps
`workflows.active_revision`. A run freezes the revision it started with, so an edit
mid-flight cannot change what an in-progress run does. Queued *scheduled* runs from
the old revision are cancelled; an explicit manual run is not.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from app.db.engine import session_scope, sql_transaction
from app.errors import ConflictError, NotFoundError
from app.json import dumps
from app.workflows.catalog import validate_capabilities
from app.workflows.connections import connection_issues
from app.workflows.types import (
    Definition,
    next_occurrence,
    preview,
    validate_definition,
)


def _utcnow_naive() -> dt.datetime:
    """`workflows.updated_at` and `workflow_runs.ran_at` are naive columns."""
    return dt.datetime.now(dt.UTC).replace(tzinfo=None)


async def record_event(run_id: int, data: dict[str, Any]) -> None:
    """Append to `workflow_events`, which drives the run-events SSE stream."""
    async with session_scope() as session:
        await session.execute(
            text("INSERT INTO workflow_events (run_id, event) VALUES (:run_id, :event)"),
            {"run_id": run_id, "event": dumps(data)},
        )


async def _active_definition(
    conn: AsyncConnection, workflow_id: int, active_revision: int
) -> dict[str, Any] | None:
    if not active_revision:
        return None
    return (
        await conn.execute(
            text(
                "SELECT definition FROM workflow_revisions "
                "WHERE workflow_id = :id AND version = :version"
            ),
            {"id": workflow_id, "version": active_revision},
        )
    ).scalar_one_or_none()


async def get_workflow(workflow_id: int) -> dict[str, Any]:
    """A workflow plus its active definition, schedule preview and connection issues.

    The response carries the raw snake_case row *and* three camelCase aliases,
    because `web/src/lib/workflows.ts` reads both conventions from this endpoint.
    """
    async with sql_transaction() as conn:
        row = (
            (
                await conn.execute(
                    text("SELECT * FROM workflows WHERE id = :id"), {"id": workflow_id}
                )
            )
            .mappings()
            .one_or_none()
        )
        if row is None:
            raise NotFoundError("Workflow not found")
        raw_definition = await _active_definition(conn, workflow_id, row["active_revision"])

    definition = Definition.model_validate(raw_definition) if raw_definition else None
    return {
        **dict(row),
        "definition": raw_definition,
        "activeRevision": row["active_revision"],
        "nextRunAt": row["next_run_at"],
        "lastRunAt": row["last_run_at"],
        "preview": preview(definition.trigger) if definition else [],
        "connectionIssues": await connection_issues(definition),
    }


async def save_workflow(
    payload: Any,
    workflow_id: int | None = None,
    expected_revision: int | None = None,
    enabled: bool = True,
    conn: AsyncConnection | None = None,
) -> int:
    """Create or revise a workflow. Returns its id.

    `expected_revision` is optimistic concurrency: it must match the stored
    `active_revision`, so a stale editor cannot overwrite a newer definition. That is
    also how `accept_proposal` refuses a proposal built on an outdated revision.
    """
    definition = validate_definition(payload)
    validate_capabilities(definition)

    if (
        enabled
        and definition.trigger.kind == "once"
        and next_occurrence(definition.trigger) is None
    ):
        raise ConflictError("One-time execution must be in the future")

    if conn is not None:
        return await _save(conn, definition, workflow_id, expected_revision, enabled)
    async with sql_transaction() as owned:
        return await _save(owned, definition, workflow_id, expected_revision, enabled)


async def _save(
    conn: AsyncConnection,
    definition: Definition,
    workflow_id: int | None,
    expected_revision: int | None,
    enabled: bool,
) -> int:
    version = 1

    if workflow_id:
        existing = (
            (
                await conn.execute(
                    text("SELECT active_revision FROM workflows WHERE id = :id FOR UPDATE"),
                    {"id": workflow_id},
                )
            )
            .mappings()
            .one_or_none()
        )
        if existing is None:
            raise NotFoundError("Workflow not found")
        if expected_revision != existing["active_revision"]:
            raise ConflictError("Revision conflict; reload before editing")
        version = existing["active_revision"] + 1

        # Queued *scheduled* runs belong to the superseded revision. A manual run is
        # an explicit user action and is left alone.
        await conn.execute(
            text(
                "UPDATE workflow_runs SET status = 'cancelled', finished_at = now(), "
                "error = 'Superseded workflow revision' "
                "WHERE workflow_id = :id AND status = 'queued' AND trigger = 'schedule'"
            ),
            {"id": workflow_id},
        )
    else:
        workflow_id = (
            await conn.execute(
                text(
                    "INSERT INTO workflows (name, description, plan) "
                    "VALUES (:name, :description, :plan) RETURNING id"
                ),
                {
                    "name": definition.name,
                    "description": definition.description,
                    "plan": definition.instructions,
                },
            )
        ).scalar_one()

    serialized = definition.model_dump(mode="json")
    await conn.execute(
        text(
            "INSERT INTO workflow_revisions (workflow_id, version, definition) "
            "VALUES (:id, :version, :definition)"
        ),
        {"id": workflow_id, "version": version, "definition": dumps(serialized)},
    )

    await conn.execute(
        text(
            "UPDATE workflows SET name = :name, description = :description, "
            "plan = :plan, enabled = :enabled, active_revision = :version, "
            "next_run_at = :next_run_at, lifecycle = :lifecycle, updated_at = :now "
            "WHERE id = :id"
        ),
        {
            "name": definition.name,
            "description": definition.description,
            "plan": definition.instructions,
            "enabled": enabled,
            "version": version,
            "next_run_at": next_occurrence(definition.trigger) if enabled else None,
            "lifecycle": _lifecycle(definition, enabled),
            "now": _utcnow_naive(),
            "id": workflow_id,
        },
    )
    return workflow_id


def _lifecycle(definition: Definition | None, enabled: bool) -> str:
    """`manual` | `active` | `paused` — what the UI badges the workflow with."""
    if not enabled:
        return "paused"
    if definition is None or definition.trigger.kind == "manual":
        return "manual"
    return "active"


async def set_enabled(workflow_id: int, enabled: bool) -> None:
    """Pause or resume. Pausing cancels queued scheduled runs but not an active one."""
    async with sql_transaction() as conn:
        row = (
            (
                await conn.execute(
                    text("SELECT active_revision FROM workflows WHERE id = :id FOR UPDATE"),
                    {"id": workflow_id},
                )
            )
            .mappings()
            .one_or_none()
        )
        if row is None:
            raise NotFoundError("Workflow not found")

        raw_definition = await _active_definition(conn, workflow_id, row["active_revision"])
        definition = Definition.model_validate(raw_definition) if raw_definition else None

        if (
            enabled
            and definition is not None
            and definition.trigger.kind == "once"
            and next_occurrence(definition.trigger) is None
        ):
            raise ConflictError("Update the past one-time date before resuming")

        await conn.execute(
            text(
                "UPDATE workflows SET enabled = :enabled, next_run_at = :next_run_at, "
                "lifecycle = :lifecycle, updated_at = :now WHERE id = :id"
            ),
            {
                "enabled": enabled,
                "next_run_at": (
                    next_occurrence(definition.trigger)
                    if enabled and definition is not None
                    else None
                ),
                "lifecycle": _lifecycle(definition, enabled),
                "now": _utcnow_naive(),
                "id": workflow_id,
            },
        )

        if not enabled:
            await conn.execute(
                text(
                    "UPDATE workflow_runs SET status = 'cancelled', "
                    "finished_at = now(), error = 'Workflow paused' "
                    "WHERE workflow_id = :id AND status = 'queued' "
                    "AND trigger = 'schedule'"
                ),
                {"id": workflow_id},
            )


async def enqueue(workflow_id: int) -> int:
    """Queue a manual run, or return the id of the run already in flight.

    Repeating the request is therefore idempotent, which is what lets
    `POST /:id/run` be safely retried.
    """
    async with sql_transaction() as conn:
        row = (
            (
                await conn.execute(
                    text("SELECT active_revision FROM workflows WHERE id = :id FOR UPDATE"),
                    {"id": workflow_id},
                )
            )
            .mappings()
            .one_or_none()
        )
        if row is None:
            raise NotFoundError("Workflow not found")

        revision_id = (
            await conn.execute(
                text(
                    "SELECT id FROM workflow_revisions "
                    "WHERE workflow_id = :id AND version = :version"
                ),
                {"id": workflow_id, "version": row["active_revision"]},
            )
        ).scalar_one_or_none()
        if revision_id is None:
            raise ConflictError("Convert this legacy text plan before running it")

        active = (
            await conn.execute(
                text(
                    "SELECT id FROM workflow_runs WHERE workflow_id = :id "
                    "AND status IN ('queued', 'running')"
                ),
                {"id": workflow_id},
            )
        ).scalar_one_or_none()
        if active is not None:
            return active

        return (
            await conn.execute(
                text(
                    "INSERT INTO workflow_runs (workflow_id, revision_id, status) "
                    "VALUES (:id, :revision_id, 'queued') RETURNING id"
                ),
                {"id": workflow_id, "revision_id": revision_id},
            )
        ).scalar_one()


async def get_run(run_id: int) -> dict[str, Any]:
    """A run with its frozen definition and step results, in execution order."""
    async with sql_transaction() as conn:
        row = (
            (
                await conn.execute(
                    text(
                        "SELECT r.*, v.definition FROM workflow_runs r "
                        "LEFT JOIN workflow_revisions v ON v.id = r.revision_id "
                        "WHERE r.id = :id"
                    ),
                    {"id": run_id},
                )
            )
            .mappings()
            .one_or_none()
        )
        if row is None:
            raise NotFoundError("Run not found")

        steps = (
            (
                await conn.execute(
                    text(
                        "SELECT * FROM workflow_steps WHERE run_id = :id "
                        "ORDER BY started_at ASC, step_id ASC"
                    ),
                    {"id": run_id},
                )
            )
            .mappings()
            .all()
        )

    return {**dict(row), "steps": [dict(step) for step in steps]}


async def accept_proposal(proposal_id: int) -> int:
    """Adopt a learned proposal as a new revision. Returns the workflow id.

    `save_workflow` is called with the proposal's `base_revision` as the expected
    revision, so a proposal built on an older revision is rejected rather than
    silently overwriting a newer definition.
    """
    async with sql_transaction() as conn:
        proposal = (
            (
                await conn.execute(
                    text(
                        "SELECT * FROM workflow_proposals "
                        "WHERE id = :id AND status = 'pending' FOR UPDATE"
                    ),
                    {"id": proposal_id},
                )
            )
            .mappings()
            .one_or_none()
        )
        if proposal is None:
            raise NotFoundError("Pending proposal not found")

        enabled = (
            await conn.execute(
                text("SELECT enabled FROM workflows WHERE id = :id"),
                {"id": proposal["workflow_id"]},
            )
        ).scalar_one()

        await save_workflow(
            proposal["definition"],
            proposal["workflow_id"],
            proposal["base_revision"],
            bool(enabled),
            conn=conn,
        )
        await conn.execute(
            text("UPDATE workflow_proposals SET status = 'accepted' WHERE id = :id"),
            {"id": proposal_id},
        )
        return proposal["workflow_id"]
