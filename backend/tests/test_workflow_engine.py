from __future__ import annotations

import datetime as dt
import json
from typing import Any

import psycopg
import pytest

from app.workflows.engine import claim_run, schedule_due
from tests.conftest import requires_test_db, resolve_test_database_url

CRON_DEFINITION: dict[str, Any] = {
    "name": "Daily",
    "description": "",
    "instructions": "Summarize each weekday",
    "trigger": {"kind": "cron", "cron": "0 8 * * 1-5", "at": None, "timezone": "Africa/Lagos"},
    "steps": [
        {
            "id": "summary",
            "title": "Summarize",
            "specialist": "synthesis",
            "instruction": "Summarize",
            "dependsOn": [],
            "permissions": [],
        }
    ],
}


def _sql(query: str, params: tuple = ()) -> list[tuple]:
    url = resolve_test_database_url()
    assert url is not None
    with psycopg.connect(url, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute(query, params)
        return cur.fetchall() if cur.description else []


def _seed_workflow(*, next_run_at: str | None, enabled: bool = True) -> int:
    _sql(
        "INSERT INTO workflows (id, name, description, plan, enabled, active_revision, "
        "next_run_at, lifecycle) "
        "VALUES (1, 'Daily', '', 'Summarize each weekday', %s, 1, %s, 'active')",
        (enabled, next_run_at),
    )
    _sql(
        "INSERT INTO workflow_revisions (id, workflow_id, version, definition) "
        "VALUES (1, 1, 1, %s)",
        (json.dumps(CRON_DEFINITION),),
    )
    return 1


@requires_test_db
async def test_schedule_due_enqueues_and_advances_next_run(api_client: Any) -> None:
    _seed_workflow(next_run_at="2020-01-01T00:00:00+00:00")

    await schedule_due(dt.datetime(2026, 10, 6, 12, 0, tzinfo=dt.UTC))

    runs = _sql("SELECT status, trigger, scheduled_for FROM workflow_runs")
    assert len(runs) == 1
    status, trigger, scheduled_for = runs[0]
    assert (status, trigger) == ("queued", "schedule")
    # Coalesced to the latest past occurrence, not the original stale one.
    assert scheduled_for == dt.datetime(2026, 10, 6, 7, 0, tzinfo=dt.UTC)

    # next_run_at has moved forward, so the same occurrence is not re-enqueued.
    assert _sql("SELECT next_run_at FROM workflows WHERE id = 1")[0][0] > scheduled_for


@requires_test_db
async def test_schedule_due_is_idempotent(api_client: Any) -> None:
    """A second pass must not create a second run for the same occurrence."""
    _seed_workflow(next_run_at="2020-01-01T00:00:00+00:00")
    now = dt.datetime(2026, 10, 6, 12, 0, tzinfo=dt.UTC)

    await schedule_due(now)
    await schedule_due(now)

    assert _sql("SELECT count(*) FROM workflow_runs")[0][0] == 1


@requires_test_db
async def test_schedule_due_skips_a_workflow_with_a_live_run(api_client: Any) -> None:
    _seed_workflow(next_run_at="2020-01-01T00:00:00+00:00")
    _sql("INSERT INTO workflow_runs (workflow_id, revision_id, status) VALUES (1, 1, 'running')")

    await schedule_due(dt.datetime(2026, 10, 6, 12, 0, tzinfo=dt.UTC))

    assert _sql("SELECT count(*) FROM workflow_runs")[0][0] == 1, "no new run queued"


@requires_test_db
async def test_schedule_due_respects_the_scheduler_flag(
    api_client: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """SCHEDULER_ENABLED=false stops new occurrences; queued runs still execute."""
    _seed_workflow(next_run_at="2020-01-01T00:00:00+00:00")
    monkeypatch.setenv("SCHEDULER_ENABLED", "false")
    from app.config import get_settings

    get_settings.cache_clear()

    await schedule_due(dt.datetime(2026, 10, 6, 12, 0, tzinfo=dt.UTC))
    assert _sql("SELECT count(*) FROM workflow_runs")[0][0] == 0


@requires_test_db
async def test_claim_run_takes_the_lease(api_client: Any) -> None:
    _seed_workflow(next_run_at=None)
    _sql(
        "INSERT INTO workflow_runs (id, workflow_id, revision_id, status) VALUES (1, 1, 1, 'queued')"
    )

    claimed = await claim_run("worker-a")
    assert claimed is not None
    assert claimed["id"] == 1

    status, owner = _sql("SELECT status, lease_owner FROM workflow_runs WHERE id = 1")[0]
    assert (status, owner) == ("running", "worker-a")

    # Nothing left to claim.
    assert await claim_run("worker-b") is None


@requires_test_db
async def test_claim_run_enforces_the_global_concurrency_cap(api_client: Any) -> None:
    _seed_workflow(next_run_at=None)
    # Four runs already executing, across any workflows.
    for i in range(2, 6):
        _sql(
            "INSERT INTO workflows (id, name, description, plan, active_revision) "
            "VALUES (%s, 'w', '', 'p', 0)",
            (i,),
        )
        _sql(
            "INSERT INTO workflow_runs (workflow_id, status, lease_owner, heartbeat_at) "
            "VALUES (%s, 'running', 'other', now())",
            (i,),
        )
    _sql("INSERT INTO workflow_runs (workflow_id, revision_id, status) VALUES (1, 1, 'queued')")

    assert await claim_run("worker-a") is None, "the cap is four concurrent runs"


@requires_test_db
async def test_expired_lease_with_an_unknown_write_needs_attention(api_client: Any) -> None:
    """An expired lease is never permission to repeat a write of unknown outcome."""
    _seed_workflow(next_run_at=None)
    _sql(
        "INSERT INTO workflow_runs (id, workflow_id, revision_id, status, lease_owner, "
        "heartbeat_at) VALUES (1, 1, 1, 'running', 'dead-worker', "
        "now() - interval '120 seconds')"
    )
    _sql(
        "INSERT INTO workflow_actions (run_id, step_id, tool, fingerprint, status) "
        "VALUES (1, 'send', 'send_email', 'fp', 'started')"
    )

    await claim_run("worker-a")

    status, error, owner = _sql(
        "SELECT status, error, lease_owner FROM workflow_runs WHERE id = 1"
    )[0]
    assert status == "needs_attention"
    assert "lease expired" in error
    assert owner is None


@requires_test_db
async def test_expired_lease_without_an_unknown_write_is_requeued(api_client: Any) -> None:
    _seed_workflow(next_run_at=None)
    _sql(
        "INSERT INTO workflow_runs (id, workflow_id, revision_id, status, lease_owner, "
        "heartbeat_at) VALUES (1, 1, 1, 'running', 'dead-worker', "
        "now() - interval '120 seconds')"
    )
    _sql(
        "INSERT INTO workflow_steps (run_id, step_id, status, output) "
        "VALUES (1, 'summary', 'completed', 'done')"
    )

    claimed = await claim_run("worker-a")
    # Recovered and immediately re-claimed by this worker.
    assert claimed is not None and claimed["id"] == 1
    assert _sql("SELECT status FROM workflow_runs WHERE id = 1")[0][0] == "running"
    # The completed step survives, so the run resumes rather than restarting.
    assert _sql("SELECT status FROM workflow_steps WHERE run_id = 1")[0][0] == "completed"


@requires_test_db
async def test_queued_scheduled_run_is_cancelled_when_paused(api_client: Any) -> None:
    _seed_workflow(next_run_at=None, enabled=False)
    _sql(
        "INSERT INTO workflow_runs (id, workflow_id, revision_id, status, trigger) "
        "VALUES (1, 1, 1, 'queued', 'schedule')"
    )

    assert await claim_run("worker-a") is None
    status, error = _sql("SELECT status, error FROM workflow_runs WHERE id = 1")[0]
    assert status == "cancelled"
    assert "paused or superseded" in error


@requires_test_db
async def test_manual_run_survives_a_paused_workflow(api_client: Any) -> None:
    """Pausing stops the schedule; an explicit manual run is still honoured."""
    _seed_workflow(next_run_at=None, enabled=False)
    _sql(
        "INSERT INTO workflow_runs (id, workflow_id, revision_id, status, trigger) "
        "VALUES (1, 1, 1, 'queued', 'manual')"
    )

    claimed = await claim_run("worker-a")
    assert claimed is not None and claimed["id"] == 1


@requires_test_db
async def test_cancel_requested_run_is_not_claimed(api_client: Any) -> None:
    _seed_workflow(next_run_at=None)
    _sql(
        "INSERT INTO workflow_runs (workflow_id, revision_id, status, cancel_requested) "
        "VALUES (1, 1, 'queued', true)"
    )
    assert await claim_run("worker-a") is None


@requires_test_db
async def test_running_steps_are_reset_to_pending_on_claim(api_client: Any) -> None:
    """A step left mid-flight by a crashed worker is retried, not abandoned."""
    _seed_workflow(next_run_at=None)
    _sql(
        "INSERT INTO workflow_runs (id, workflow_id, revision_id, status) VALUES (1, 1, 1, 'queued')"
    )
    _sql("INSERT INTO workflow_steps (run_id, step_id, status) VALUES (1, 'summary', 'running')")

    await claim_run("worker-a")
    assert _sql("SELECT status FROM workflow_steps WHERE run_id = 1")[0][0] == "pending"
