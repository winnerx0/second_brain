"""Port of `src/workflows/types.test.ts`, plus cases the TypeScript did not cover.

The scheduling assertions carry the literal ISO strings from the original test. They
are the proof that `croniter` agrees with `cron-parser`, including across both US
daylight-saving transitions — a disagreement would silently reschedule every cron
workflow, and because `workflow_occurrence` is unique on
`(workflow_id, scheduled_for)`, a shifted instant would also let a duplicate
occurrence be enqueued.
"""

from __future__ import annotations

import datetime as dt

import pytest

from app.errors import BadRequestError
from app.json import js_date
from app.workflows.types import (
    Definition,
    StepModel,
    Trigger,
    check_permission,
    is_read_tool,
    is_target,
    latest_occurrence,
    next_occurrence,
    preview,
    validate_definition,
)

DEFINITION: dict = {
    "name": "Briefing",
    "description": "",
    "instructions": "Summarize every weekday",
    "trigger": {
        "kind": "cron",
        "cron": "0 8 * * 1-5",
        "at": None,
        "timezone": "Africa/Lagos",
    },
    "steps": [
        {
            "id": "summary",
            "title": "Summarize",
            "specialist": "synthesis",
            "instruction": "Summarize evidence",
            "dependsOn": [],
            "permissions": [],
        }
    ],
}


def _at(value: str) -> dt.datetime:
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def _trigger(**overrides: object) -> Trigger:
    return Trigger.model_validate({**DEFINITION["trigger"], **overrides})


# ─── workflow schedules ──────────────────────────────────────────────────────


def test_weekday_schedule_respects_lagos_timezone_and_skips_weekends() -> None:
    upcoming = next_occurrence(_trigger(), _at("2026-10-02T07:01:00Z"))
    assert upcoming is not None
    # 07:01Z is 08:01 in Lagos, so Friday's 08:00 has passed; Monday is next.
    assert js_date(upcoming) == "2026-10-05T07:00:00.000Z"


def test_coalesces_a_missed_schedule_to_the_latest_occurrence() -> None:
    assert js_date(latest_occurrence(_trigger(), _at("2026-10-06T12:00:00Z"))) == (
        "2026-10-06T07:00:00.000Z"
    )


def test_daily_schedules_adjust_utc_offset_across_daylight_saving() -> None:
    trigger = _trigger(timezone="America/New_York", cron="0 8 * * *")

    spring = next_occurrence(trigger, _at("2026-03-07T14:00:00Z"))
    assert spring is not None
    # 2026-03-08 is spring-forward: 08:00 EDT is 12:00Z.
    assert js_date(spring) == "2026-03-08T12:00:00.000Z"

    autumn = next_occurrence(trigger, _at("2026-10-31T13:00:00Z"))
    assert autumn is not None
    # 2026-11-01 is fall-back: 08:00 EST is 13:00Z.
    assert js_date(autumn) == "2026-11-01T13:00:00.000Z"


def test_one_time_schedules_finish_and_manual_schedules_never_enqueue() -> None:
    assert next_occurrence(Trigger(kind="manual", cron=None, at=None, timezone="UTC")) is None
    assert (
        next_occurrence(Trigger(kind="once", cron=None, at="2020-01-01T00:00:00Z", timezone="UTC"))
        is None
    )


def test_future_one_time_schedule_returns_its_instant() -> None:
    trigger = Trigger(kind="once", cron=None, at="2099-01-01T00:00:00Z", timezone="UTC")
    upcoming = next_occurrence(trigger)
    assert upcoming is not None
    assert js_date(upcoming) == "2099-01-01T00:00:00.000Z"


def test_preview_returns_five_future_occurrences() -> None:
    dates = preview(_trigger())
    assert len(dates) == 5
    assert dates == sorted(dates), "occurrences must be in ascending order"
    assert all(d.endswith("Z") for d in dates)


def test_preview_of_a_manual_trigger_is_empty() -> None:
    assert preview(Trigger(kind="manual", cron=None, at=None, timezone="UTC")) == []


@pytest.mark.parametrize(
    ("label", "overrides"),
    [
        ("six-field cron", {"trigger": {**DEFINITION["trigger"], "cron": "* * * * * *"}}),
        ("unknown timezone", {"trigger": {**DEFINITION["trigger"], "timezone": "Mars/Base"}}),
        ("duplicate step ids", {"steps": DEFINITION["steps"] * 2}),
        (
            "self-dependency cycle",
            {"steps": [{**DEFINITION["steps"][0], "dependsOn": ["summary"]}]},
        ),
    ],
)
def test_rejects_invalid_definitions(label: str, overrides: dict) -> None:
    with pytest.raises(BadRequestError):
        validate_definition({**DEFINITION, **overrides})


def test_accepts_a_valid_definition() -> None:
    definition = validate_definition(DEFINITION)
    assert isinstance(definition, Definition)
    assert definition.steps[0].id == "summary"


def test_rejects_unknown_step_dependency() -> None:
    with pytest.raises(BadRequestError, match="cycle or unknown step"):
        validate_definition(
            {**DEFINITION, "steps": [{**DEFINITION["steps"][0], "dependsOn": ["nope"]}]}
        )


def test_rejects_mutual_cycle() -> None:
    steps = [
        {**DEFINITION["steps"][0], "id": "a", "dependsOn": ["b"]},
        {**DEFINITION["steps"][0], "id": "b", "dependsOn": ["a"]},
    ]
    with pytest.raises(BadRequestError, match="cycle or unknown step"):
        validate_definition({**DEFINITION, "steps": steps})


def test_one_time_trigger_requires_an_explicit_offset() -> None:
    """Without an offset the instant is ambiguous, so it is refused."""
    for at in (None, "2099-01-01T00:00:00", "not a date", ""):
        with pytest.raises(BadRequestError, match="one-time date"):
            validate_definition(
                {
                    **DEFINITION,
                    "trigger": {"kind": "once", "cron": None, "at": at, "timezone": "UTC"},
                }
            )
    # With an offset it is accepted.
    validate_definition(
        {
            **DEFINITION,
            "trigger": {
                "kind": "once",
                "cron": None,
                "at": "2099-01-01T00:00:00Z",
                "timezone": "UTC",
            },
        }
    )


@pytest.mark.parametrize("step_id", ["Summary", "1step", "has space", "a" * 65, ""])
def test_rejects_malformed_step_ids(step_id: str) -> None:
    with pytest.raises(BadRequestError):
        validate_definition({**DEFINITION, "steps": [{**DEFINITION["steps"][0], "id": step_id}]})


def test_rejects_too_many_steps_and_no_steps() -> None:
    with pytest.raises(BadRequestError):
        validate_definition({**DEFINITION, "steps": []})
    many = [{**DEFINITION["steps"][0], "id": f"s{i}"} for i in range(31)]
    with pytest.raises(BadRequestError):
        validate_definition({**DEFINITION, "steps": many})


def test_rejects_unknown_specialist() -> None:
    with pytest.raises(BadRequestError):
        validate_definition(
            {**DEFINITION, "steps": [{**DEFINITION["steps"][0], "specialist": "nope"}]}
        )


# ─── workflow action scope ───────────────────────────────────────────────────


def test_recognizes_specialist_read_operations() -> None:
    for name in ("readDocument", "spotify_get_profile", "clickup_get_tasks", "get_calendar_events"):
        assert is_read_tool(name) is True, name
    assert is_read_tool("send_email") is False


@pytest.mark.parametrize(
    ("key", "expected"),
    [
        ("to", True),
        ("cc", True),
        ("bcc", True),
        ("repo", True),
        ("owner", True),
        ("url", True),
        ("parent", True),
        ("issueNumber", True),  # matches `number$`
        ("taskId", True),  # matches `id$`
        ("listIds", True),  # matches `ids$`
        ("body", False),
        ("title", False),
    ],
)
def test_is_target(key: str, expected: bool) -> None:
    assert is_target(key) is expected


def _step_with(permissions: list[dict]) -> StepModel:
    return StepModel.model_validate({**DEFINITION["steps"][0], "permissions": permissions})


def test_denies_unapproved_actions_and_mismatched_or_unconstrained_targets() -> None:
    step = _step_with([{"tool": "send_email", "constraints": {"to": ["alice@example.com"]}}])

    # Authorized recipient, plus an unconstrained non-target argument.
    check_permission(step, "send_email", {"to": "alice@example.com", "body": "Hello"})

    with pytest.raises(BadRequestError, match="Unauthorized target"):
        check_permission(step, "send_email", {"to": "bob@example.com"})

    # `bcc` is a target and is not constrained, so it must be refused even though
    # `to` is authorized — this is how a workflow would silently gain a recipient.
    with pytest.raises(BadRequestError, match="Missing authorization for target"):
        check_permission(step, "send_email", {"to": "alice@example.com", "bcc": "bob@example.com"})

    with pytest.raises(BadRequestError, match="outside this workflow's authorization"):
        check_permission(step, "delete_issue", {"issueNumber": 3})


def test_a_constrained_argument_must_be_present() -> None:
    """A missing constrained key yields `[undefined]`, which is unauthorized."""
    step = _step_with([{"tool": "send_email", "constraints": {"to": ["alice@example.com"]}}])
    with pytest.raises(BadRequestError, match="Unauthorized target"):
        check_permission(step, "send_email", {"body": "Hello"})


def test_list_valued_arguments_require_every_element_authorized() -> None:
    step = _step_with([{"tool": "send_email", "constraints": {"to": ["a@x.com", "b@x.com"]}}])
    check_permission(step, "send_email", {"to": ["a@x.com", "b@x.com"]})
    with pytest.raises(BadRequestError, match="Unauthorized target"):
        check_permission(step, "send_email", {"to": ["a@x.com", "c@x.com"]})
    # An empty list is refused rather than treated as "nothing to check".
    with pytest.raises(BadRequestError, match="Unauthorized target"):
        check_permission(step, "send_email", {"to": []})


def test_boolean_is_not_interchangeable_with_one() -> None:
    """Python's `True in [1]` is True; JavaScript's `[1].includes(true)` is false.

    A permission constrained to the number 1 must not authorize the boolean `true`,
    or a numeric allow-list would silently accept booleans.
    """
    step = _step_with([{"tool": "set_flag", "constraints": {"value": [1]}}])
    check_permission(step, "set_flag", {"value": 1})
    with pytest.raises(BadRequestError, match="Unauthorized target"):
        check_permission(step, "set_flag", {"value": True})

    boolean_step = _step_with([{"tool": "set_flag", "constraints": {"value": [True]}}])
    check_permission(boolean_step, "set_flag", {"value": True})
    with pytest.raises(BadRequestError, match="Unauthorized target"):
        check_permission(boolean_step, "set_flag", {"value": 1})


def test_numbers_compare_across_int_and_float() -> None:
    """JSON has one number type, so 2 and 2.0 are the same value."""
    step = _step_with([{"tool": "set_count", "constraints": {"value": [2]}}])
    check_permission(step, "set_count", {"value": 2.0})


def test_read_tools_bypass_permissions_entirely() -> None:
    step = _step_with([])
    check_permission(step, "get_calendar_events", {"calendarId": "primary"})
    check_permission(step, "readDocument", {"documentId": "abc"})
