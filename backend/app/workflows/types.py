from __future__ import annotations

import datetime as dt
import re
from typing import Annotated, Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from croniter import CroniterBadCronError, croniter
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.errors import BadRequestError
from app.json import js_date

SPECIALIST_NAMES = (
    "github",
    "calendar",
    "gmail",
    "docs",
    "notion",
    "clickup",
    "spotify",
    "twitter",
    "anilist",
    "knowledge_graph",
    "web_search",
    "synthesis",
    "telegram",
)

Specialist = Literal[
    "github",
    "calendar",
    "gmail",
    "docs",
    "notion",
    "clickup",
    "spotify",
    "twitter",
    "anilist",
    "knowledge_graph",
    "web_search",
    "synthesis",
    "telegram",
]

TriggerKind = Literal["manual", "once", "cron"]

#: A constraint value: string, number or boolean, mirroring the JSON the web client sends.
ConstraintValue = str | int | float | bool

STEP_ID_PATTERN = r"^[a-z][a-z0-9_-]{0,63}$"

#: `once` triggers must carry an explicit UTC offset, so the instant is unambiguous.
_HAS_OFFSET = re.compile(r"(Z|[+-]\d{2}:\d{2})$")


class Permission(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tool: str
    #: Argument name -> the exact values that argument may take.
    constraints: dict[str, list[ConstraintValue]] = Field(default_factory=dict)


class Trigger(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: TriggerKind
    cron: str | None = None
    at: str | None = None
    timezone: str


class StepModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: Annotated[str, Field(pattern=STEP_ID_PATTERN)]
    title: str = Field(min_length=1)
    specialist: Specialist
    instruction: str = Field(min_length=1)
    dependsOn: list[str] = Field(default_factory=list)
    permissions: list[Permission] = Field(default_factory=list)


class Definition(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=160)
    description: str = Field(max_length=2000)
    instructions: str = Field(min_length=1, max_length=20000)
    trigger: Trigger
    steps: list[StepModel] = Field(min_length=1, max_length=30)


def _valid_timezone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, KeyError) as exc:
                raise BadRequestError(f"Invalid timezone: {name}") from exc


def validate_definition(value: Any) -> Definition:
    """Parse and fully validate a definition, or raise `BadRequestError`.

    Checks run in a fixed order so the first failure reported for
    a given input is stable: schema, timezone, cron, one-time instant, duplicate
    step ids, then dependency cycles.
    """
    try:
        definition = Definition.model_validate(value)
    except ValidationError as exc:
        first = exc.errors()[0]
        location = ".".join(str(part) for part in first.get("loc", ()))
        raise BadRequestError(
            f"{location}: {first.get('msg', 'invalid definition')}"
            if location
            else first.get("msg", "invalid definition")
        ) from exc

    _valid_timezone(definition.trigger.timezone)

    if definition.trigger.kind == "cron":
        cron = (definition.trigger.cron or "").strip()
        if len(cron.split()) != 5:
            raise BadRequestError("Use a five-field cron expression")
        try:
            croniter(cron)
        except (CroniterBadCronError, ValueError) as exc:
            raise BadRequestError("Use a five-field cron expression") from exc

    if definition.trigger.kind == "once":
        at = definition.trigger.at
        if not at or not _HAS_OFFSET.search(at) or _parse_instant(at) is None:
            raise BadRequestError("A valid one-time date is required")

    ids = {step.id for step in definition.steps}
    if len(ids) != len(definition.steps):
        raise BadRequestError("Step IDs must be unique")

    # Topological peeling: repeatedly take the steps whose dependencies are all
    # satisfied. If a pass finds none, something is cyclic or names a step that does
    # not exist.
    visited: set[str] = set()
    while len(visited) < len(ids):
        ready = [
            step
            for step in definition.steps
            if step.id not in visited and all(dep in visited for dep in step.dependsOn)
        ]
        if not ready:
            raise BadRequestError("Step dependencies contain a cycle or unknown step")
        visited.update(step.id for step in ready)

    return definition


def _parse_instant(value: str) -> dt.datetime | None:
    """Parse an ISO-8601 instant, accepting the `Z` suffix."""
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def next_occurrence(trigger: Trigger, after: dt.datetime | None = None) -> dt.datetime | None:
    """The next fire time strictly after `after`, or None if there is none.

    Manual triggers never fire. A one-time trigger fires only if its instant is still
    in the future. Returned datetimes are timezone-aware UTC.
    """
    moment = after or dt.datetime.now(dt.UTC)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=dt.UTC)

    if trigger.kind == "manual":
        return None

    if trigger.kind == "once":
        if not trigger.at:
            return None
        instant = _parse_instant(trigger.at)
        if instant is None:
            return None
        if instant.tzinfo is None:
            instant = instant.replace(tzinfo=dt.UTC)
        return instant if instant > moment else None

    zone = _valid_timezone(trigger.timezone)
    # croniter evaluates the expression in whatever zone its start time carries, so
    # the cursor is converted into the workflow's zone first and the result back to
    # UTC. Doing this in UTC would fire at the wrong local hour after a DST change.
    local = moment.astimezone(zone)
    upcoming = croniter(trigger.cron or "", local).get_next(dt.datetime)
    return upcoming.astimezone(dt.UTC)


def latest_occurrence(trigger: Trigger, now: dt.datetime | None = None) -> dt.datetime:
    """The most recent fire time at or before `now`.

    Used to coalesce a backlog: if several occurrences were missed while the worker
    was down, only the newest one is enqueued.
    """
    moment = now or dt.datetime.now(dt.UTC)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=dt.UTC)

    if trigger.kind == "once":
        instant = _parse_instant(trigger.at or "")
        if instant is None:
            raise BadRequestError("A valid one-time date is required")
        return instant if instant.tzinfo else instant.replace(tzinfo=dt.UTC)

    zone = _valid_timezone(trigger.timezone)
    # The +1ms makes an occurrence landing exactly on
    # `now` count as past rather than future.
    local = (moment + dt.timedelta(milliseconds=1)).astimezone(zone)
    previous = croniter(trigger.cron or "", local).get_prev(dt.datetime)
    return previous.astimezone(dt.UTC)


def preview(trigger: Trigger) -> list[str]:
    """The next five fire times, as ISO strings, for the UI's schedule preview."""
    dates: list[str] = []
    cursor = dt.datetime.now(dt.UTC)
    for _ in range(5):
        upcoming = next_occurrence(trigger, cursor)
        if upcoming is None:
            break
        dates.append(js_date(upcoming))
        cursor = upcoming
    return dates


_READ_TOOL_PREFIXES = re.compile(
    r"^(get_|list_|search_|discover_|fetch_|recall_|calculate|twitter_get_|"
    r"twitter_search_|spotify_get_|spotify_search|clickup_get_|clickup_search)"
)

_READ_TOOL_NAMES = frozenset(
    {
        "tavily_search",
        "tavily_extract",
        "readDocument",
        "searchDocuments",
        "query_notion_database",
    }
)


def is_read_tool(name: str) -> bool:
    """Whether a tool only reads, and so needs no explicit authorization."""
    return bool(_READ_TOOL_PREFIXES.match(name)) or name in _READ_TOOL_NAMES


#: Argument names that name an external target. A write to one of these must be
#: explicitly constrained, or the workflow could be steered somewhere new.
_IS_TARGET = re.compile(
    r"(^to$|^cc$|^bcc$|id$|ids$|^repo$|^owner$|^username$|^url$|number$|"
    r"^attendees$|^recipients$|^parent$)",
    re.IGNORECASE,
)


def is_target(key: str) -> bool:
    return bool(_IS_TARGET.search(key))


def _allowed_contains(allowed: list[ConstraintValue], value: Any) -> bool:
    """Type-aware membership, matching JavaScript's `Array.prototype.includes`.

    Python's `in` would accept `True` against `[1]` because `True == 1`, and `1`
    against `[1.0]`. JavaScript treats `true` and `1` as distinct, so a permission
    constrained to `[1]` must not authorize `true`. Numbers are compared across
    int/float because JSON has a single number type.
    """
    for candidate in allowed:
        if isinstance(candidate, bool) != isinstance(value, bool):
            continue
        if isinstance(candidate, bool):
            if candidate is value:
                return True
            continue
        if isinstance(candidate, (int, float)) and isinstance(value, (int, float)):
            if candidate == value:
                return True
            continue
        if type(candidate) is type(value) and candidate == value:
            return True
    return False


def check_permission(step: StepModel, tool: str, args: dict[str, Any]) -> None:
    """Raise unless `step` authorizes calling `tool` with `args`.

    Three rules, in order:
      1. reads are always allowed;
      2. a write needs a permission naming the tool;
      3. every constrained argument must hold only allowed values, and any
         target-looking argument that is *not* constrained is refused — an
         unconstrained target is exactly how a workflow would silently acquire a new
         recipient or repository.
    """
    if is_read_tool(tool):
        return

    permission = next((p for p in step.permissions if p.tool == tool), None)
    if permission is None:
        raise BadRequestError(f"Action {tool} is outside this workflow's authorization")

    for key, allowed in permission.constraints.items():
        actual = args.get(key)
        values = actual if isinstance(actual, list) else [actual]
        if not values or any(not _allowed_contains(allowed, item) for item in values):
            raise BadRequestError(f"Unauthorized target: {tool}.{key}")

    for key, value in args.items():
        if is_target(key) and value is not None and key not in permission.constraints:
            raise BadRequestError(
                f"Missing authorization for target {tool}.{key}; clarify the workflow first"
            )
