from __future__ import annotations

from typing import Any

import httpx
import psycopg
import pytest

from tests.conftest import requires_test_db, resolve_test_database_url

DEFINITION: dict[str, Any] = {
    "name": "Briefing",
    "description": "Weekday summary",
    "instructions": "Summarize my open PRs every weekday",
    "trigger": {"kind": "cron", "cron": "0 8 * * 1-5", "at": None, "timezone": "Africa/Lagos"},
    "steps": [
        {
            "id": "summary",
            "title": "Summarize",
            "specialist": "synthesis",
            "instruction": "Summarize the evidence",
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


@requires_test_db
async def test_health_reports_workers_and_queue(api_client: httpx.AsyncClient) -> None:
    response = await api_client.get("/workflows/health")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"workers", "schedulerEnabled", "runs", "overdue"}
    # No worker is running in-process under ASGITransport.
    assert body["workers"] == 0
    assert body["overdue"] == 0
    assert body["runs"] == []


@requires_test_db
async def test_health_is_not_parsed_as_a_workflow_id(api_client: httpx.AsyncClient) -> None:
    """Route ordering: /health must win over /{workflow_id}."""
    assert (await api_client.get("/workflows/health")).status_code == 200
    # And a genuinely missing workflow still 404s.
    assert (await api_client.get("/workflows/999")).status_code == 404


@requires_test_db
async def test_create_list_and_read(api_client: httpx.AsyncClient) -> None:
    created = await api_client.post("/workflows", json={"definition": DEFINITION})
    assert created.status_code == 201, created.text
    workflow = created.json()
    assert workflow["name"] == "Briefing"
    assert workflow["activeRevision"] == 1
    assert workflow["lifecycle"] == "active"
    assert workflow["nextRunAt"] is not None
    assert len(workflow["preview"]) == 5

    listed = await api_client.get("/workflows")
    rows = listed.json()["workflows"]
    assert len(rows) == 1
    row = rows[0]
    # The mixed contract web/ depends on.
    for camel in ("activeRevision", "nextRunAt", "lastRunAt"):
        assert camel in row, camel
    for snake in ("active_revision", "next_run_at", "last_run_at", "last_status"):
        assert snake in row, snake
    assert row["last_status"] is None, "no runs yet"

    detail = await api_client.get(f"/workflows/{workflow['id']}")
    assert detail.status_code == 200
    assert detail.json()["definition"]["name"] == "Briefing"
    assert detail.json()["connectionIssues"] == [], "synthesis needs no connection"


@requires_test_db
async def test_invalid_definition_is_400(api_client: httpx.AsyncClient) -> None:
    bad = {**DEFINITION, "trigger": {**DEFINITION["trigger"], "cron": "* * * * * *"}}
    response = await api_client.post("/workflows", json={"definition": bad})
    assert response.status_code == 400
    assert "five-field cron" in response.json()["error"]


@requires_test_db
async def test_unported_specialist_is_rejected_clearly(api_client: httpx.AsyncClient) -> None:
    """A step naming a specialist whose tools are not available must not be saved."""
    definition = {
        **DEFINITION,
        "steps": [{**DEFINITION["steps"][0], "specialist": "github"}],
    }
    response = await api_client.post("/workflows", json={"definition": definition})
    assert response.status_code == 400
    assert "not available in this build yet" in response.json()["error"]


@requires_test_db
async def test_revision_conflict_is_409(api_client: httpx.AsyncClient) -> None:
    created = (await api_client.post("/workflows", json={"definition": DEFINITION})).json()

    # Correct expected revision succeeds and bumps to 2.
    ok = await api_client.patch(
        f"/workflows/{created['id']}",
        json={"definition": {**DEFINITION, "name": "Renamed"}, "expectedRevision": 1},
    )
    assert ok.status_code == 200
    assert ok.json()["activeRevision"] == 2
    assert ok.json()["name"] == "Renamed"

    # A stale editor must not overwrite the newer definition.
    stale = await api_client.patch(
        f"/workflows/{created['id']}",
        json={"definition": DEFINITION, "expectedRevision": 1},
    )
    assert stale.status_code == 409
    assert "Revision conflict" in stale.json()["error"]


@requires_test_db
async def test_patch_rejects_unexpected_fields(api_client: httpx.AsyncClient) -> None:
    created = (await api_client.post("/workflows", json={"definition": DEFINITION})).json()
    response = await api_client.patch(
        f"/workflows/{created['id']}", json={"nope": 1, "enabled": False}
    )
    assert response.status_code == 400
    assert "Unexpected field" in response.json()["error"]


@requires_test_db
async def test_pause_and_resume(api_client: httpx.AsyncClient) -> None:
    created = (await api_client.post("/workflows", json={"definition": DEFINITION})).json()

    paused = await api_client.patch(f"/workflows/{created['id']}", json={"enabled": False})
    assert paused.status_code == 200
    assert paused.json()["enabled"] is False
    assert paused.json()["lifecycle"] == "paused"
    assert paused.json()["nextRunAt"] is None, "a paused workflow is not scheduled"

    resumed = await api_client.patch(f"/workflows/{created['id']}", json={"enabled": True})
    assert resumed.json()["lifecycle"] == "active"
    assert resumed.json()["nextRunAt"] is not None


@requires_test_db
async def test_enqueue_is_idempotent_and_returns_202(api_client: httpx.AsyncClient) -> None:
    created = (await api_client.post("/workflows", json={"definition": DEFINITION})).json()

    first = await api_client.post(f"/workflows/{created['id']}/run")
    assert first.status_code == 202
    run_id = first.json()["runId"]

    # Repeating while the run is still queued returns the same run.
    again = await api_client.post(f"/workflows/{created['id']}/run")
    assert again.status_code == 202
    assert again.json()["runId"] == run_id

    # The partial unique index must also forbid a second active run directly.
    with pytest.raises(psycopg.errors.UniqueViolation):
        _sql(
            "INSERT INTO workflow_runs (workflow_id, status) VALUES (%s, 'queued')",
            (created["id"],),
        )


@requires_test_db
async def test_run_detail_and_history_shape(api_client: httpx.AsyncClient) -> None:
    created = (await api_client.post("/workflows", json={"definition": DEFINITION})).json()
    run_id = (await api_client.post(f"/workflows/{created['id']}/run")).json()["runId"]
    _sql(
        "INSERT INTO workflow_steps (run_id, step_id, status, output) "
        "VALUES (%s, 'summary', 'completed', 'done')",
        (run_id,),
    )

    detail = await api_client.get(f"/workflows/runs/{run_id}")
    assert detail.status_code == 200
    body = detail.json()
    # snake_case, straight from the row.
    for key in ("ran_at", "scheduled_for", "workflow_id", "cancel_requested"):
        assert key in body, key
    assert body["steps"][0]["step_id"] == "summary"
    assert body["definition"]["name"] == "Briefing"

    history = await api_client.get(f"/workflows/{created['id']}/runs")
    assert [r["id"] for r in history.json()["runs"]] == [run_id]


@requires_test_db
async def test_cancel_queued_run(api_client: httpx.AsyncClient) -> None:
    created = (await api_client.post("/workflows", json={"definition": DEFINITION})).json()
    run_id = (await api_client.post(f"/workflows/{created['id']}/run")).json()["runId"]

    cancelled = await api_client.post(f"/workflows/runs/{run_id}/cancel")
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "cancelled"
    assert cancelled.json()["cancel_requested"] is True


@requires_test_db
async def test_feedback_reopens_the_run_for_reflection(api_client: httpx.AsyncClient) -> None:
    created = (await api_client.post("/workflows", json={"definition": DEFINITION})).json()
    run_id = (await api_client.post(f"/workflows/{created['id']}/run")).json()["runId"]
    _sql("UPDATE workflow_runs SET learned = true WHERE id = %s", (run_id,))

    response = await api_client.post(
        f"/workflows/runs/{run_id}/feedback", json={"feedback": "too verbose"}
    )
    assert response.json() == {"success": True}
    assert _sql("SELECT feedback, learned FROM workflow_runs WHERE id = %s", (run_id,)) == [
        ("too verbose", False)
    ]

    assert (
        await api_client.post(f"/workflows/runs/{run_id}/feedback", json={"feedback": ""})
    ).status_code == 400


@requires_test_db
async def test_delete_is_refused_while_a_run_is_executing(
    api_client: httpx.AsyncClient,
) -> None:
    created = (await api_client.post("/workflows", json={"definition": DEFINITION})).json()
    run_id = (await api_client.post(f"/workflows/{created['id']}/run")).json()["runId"]
    _sql("UPDATE workflow_runs SET status = 'running' WHERE id = %s", (run_id,))

    blocked = await api_client.delete(f"/workflows/{created['id']}")
    assert blocked.status_code == 409
    assert "Cancel the active run" in blocked.json()["error"]

    _sql("UPDATE workflow_runs SET status = 'completed' WHERE id = %s", (run_id,))
    assert (await api_client.delete(f"/workflows/{created['id']}")).status_code == 200
    assert _sql("SELECT count(*) FROM workflows") == [(0,)]


@requires_test_db
async def test_learning_endpoint_shape(api_client: httpx.AsyncClient) -> None:
    created = (await api_client.post("/workflows", json={"definition": DEFINITION})).json()
    _sql(
        "INSERT INTO workflow_lessons (workflow_id, lesson, active) "
        "VALUES (%s, 'Be brief', true), (%s, 'Forgotten', false)",
        (created["id"], created["id"]),
    )
    _sql(
        "INSERT INTO workflow_proposals (workflow_id, base_revision, reason, definition) "
        "VALUES (%s, 1, 'tighter', %s)",
        (created["id"], "{}"),
    )

    body = (await api_client.get(f"/workflows/{created['id']}/learning")).json()
    assert [row["lesson"] for row in body["lessons"]] == ["Be brief"], "inactive excluded"
    assert body["proposals"][0]["base_revision"] == 1, "snake_case, as web/ expects"
    assert [row["version"] for row in body["revisions"]] == [1]


@requires_test_db
async def test_lesson_correction_pins_confidence(api_client: httpx.AsyncClient) -> None:
    created = (await api_client.post("/workflows", json={"definition": DEFINITION})).json()
    _sql(
        "INSERT INTO workflow_lessons (workflow_id, lesson, confidence) "
        "VALUES (%s, 'Original', 0.6)",
        (created["id"],),
    )
    lesson_id = _sql("SELECT id FROM workflow_lessons")[0][0]

    assert (
        await api_client.patch(f"/workflows/lessons/{lesson_id}", json={"lesson": "Edited"})
    ).json() == {"success": True}
    # A user edit is authoritative, so confidence goes to 1.
    assert _sql(
        "SELECT lesson, active, confidence FROM workflow_lessons WHERE id = %s", (lesson_id,)
    ) == [("Edited", True, 1.0)]

    await api_client.patch(f"/workflows/lessons/{lesson_id}", json={"active": False})
    assert _sql("SELECT active FROM workflow_lessons WHERE id = %s", (lesson_id,)) == [(False,)]


@requires_test_db
async def test_proposal_accept_and_reject(api_client: httpx.AsyncClient) -> None:
    import json as _json

    created = (await api_client.post("/workflows", json={"definition": DEFINITION})).json()
    improved = {**DEFINITION, "name": "Improved"}
    _sql(
        "INSERT INTO workflow_proposals (workflow_id, base_revision, reason, definition) "
        "VALUES (%s, 1, 'better', %s)",
        (created["id"], _json.dumps(improved)),
    )
    proposal_id = _sql("SELECT id FROM workflow_proposals")[0][0]

    accepted = await api_client.post(f"/workflows/proposals/{proposal_id}/accept")
    assert accepted.status_code == 200
    assert accepted.json()["name"] == "Improved"
    assert accepted.json()["activeRevision"] == 2
    assert _sql("SELECT status FROM workflow_proposals WHERE id = %s", (proposal_id,)) == [
        ("accepted",)
    ]

    # Accepting twice is refused; it is no longer pending.
    assert (await api_client.post(f"/workflows/proposals/{proposal_id}/accept")).status_code == 404


@requires_test_db
async def test_invalid_ids_are_400_not_422(api_client: httpx.AsyncClient) -> None:
    for path in ("/workflows/abc", "/workflows/0", "/workflows/-1", "/workflows/abc/runs"):
        response = await api_client.get(path)
        assert response.status_code == 400, f"{path} -> {response.status_code}"
        assert "Invalid id" in response.json()["error"]


@requires_test_db
async def test_run_events_stream_replays_and_terminates(
    api_client: httpx.AsyncClient,
) -> None:
    """Frames carry `id:` so EventSource can resume, and end with a `done` event."""
    created = (await api_client.post("/workflows", json={"definition": DEFINITION})).json()
    run_id = (await api_client.post(f"/workflows/{created['id']}/run")).json()["runId"]
    _sql(
        "INSERT INTO workflow_events (run_id, event) VALUES (%s, %s), (%s, %s)",
        (run_id, '{"type":"step_started"}', run_id, '{"type":"step_finished"}'),
    )
    # A terminal status lets the stream finish rather than poll forever.
    _sql("UPDATE workflow_runs SET status = 'completed' WHERE id = %s", (run_id,))

    async with api_client.stream("GET", f"/workflows/runs/{run_id}/events") as response:
        assert response.status_code == 200
        assert response.headers["content-type"] == "text/event-stream; charset=utf-8"
        assert response.headers["x-accel-buffering"] == "no"
        body = b"".join([chunk async for chunk in response.aiter_bytes()]).decode()

    assert 'data: {"type":"step_started"}' in body
    assert 'event: done\ndata: {"status":"completed"}' in body
    assert "id: " in body, "events must be resumable"

    # `?after` resumes past already-delivered events.
    first_id = _sql("SELECT min(id) FROM workflow_events")[0][0]
    async with api_client.stream(
        "GET", f"/workflows/runs/{run_id}/events", params={"after": first_id}
    ) as response:
        resumed = b"".join([chunk async for chunk in response.aiter_bytes()]).decode()
    assert "step_started" not in resumed
    assert "step_finished" in resumed
