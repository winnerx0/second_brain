"""Per-tool-call authorization and the write-idempotency ledger.

Port of `src/workflows/policy.ts`. This middleware wraps every tool call a
specialist makes while a workflow step is executing, and is the only thing standing
between a lost worker lease and a duplicated real-world side effect — a second email,
a second merged pull request.

Outside a workflow run (ordinary chat) it is a pass-through.

Four jobs, in order:
  1. refuse a call the step is not authorized to make;
  2. refuse to continue if the run has been cancelled or the lease has moved on;
  3. for writes, claim a ledger row before acting, and replay a previously completed
     write from its recorded result instead of repeating it;
  4. retry a *read* once on a transient failure; never blind-retry a write.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents.middleware import AgentMiddleware, ToolCallRequest
from langchain_core.messages import ToolMessage
from sqlalchemy import text

from app.db.engine import session_scope
from app.logging import get_logger
from app.workflows.context import current_execution
from app.workflows.service import record_event
from app.workflows.types import check_permission, is_read_tool, is_target

logger = get_logger("workflow.policy")

#: Failure text that justifies retrying a read once.
_TRANSIENT = ("429", "502", "503", "504", "timeout", "network", "fetch")

#: Tool output that reads as a failure even though nothing was raised.
_FAILURE_PREFIXES = ("error", "failed")


def fingerprint(tool: str, args: dict[str, Any]) -> str:
    """Identify one logical write: the tool plus its *target* arguments.

    Content arguments are excluded, so re-sending the same message to the same
    recipient is recognised as the same write while a different recipient is not.

    The digest must match the TypeScript's byte-for-byte or every ledger row written
    before this migration becomes unmatchable, and a recovered run would re-send.
    Specifically: `JSON.stringify` emits no whitespace, and `Object.entries` yields
    two-element arrays rather than objects. Pinned against digests captured from the
    Node implementation in `tests/test_workflow_policy.py`.
    """
    targets = sorted(
        ([key, value] for key, value in args.items() if is_target(key)),
        key=lambda entry: entry[0],
    )
    payload = json.dumps([tool, targets], separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _looks_like_failure(content: Any) -> bool:
    text_value = str(content).strip().lower()
    return text_value.startswith(_FAILURE_PREFIXES) or '"success":false' in text_value.replace(
        " ", ""
    )


def _is_transient(error: BaseException) -> bool:
    message = str(error).lower()
    return any(hint in message for hint in _TRANSIENT)


async def _claim_write(run_id: int, step_id: str, tool: str, print_: str) -> str | None:
    """Insert a `started` ledger row.

    Returns None when the claim succeeded. Otherwise returns the existing row's
    status: `completed` means replay it, `started` means a previous attempt's outcome
    is unknown and must not be repeated.
    """
    async with session_scope() as session:
        inserted = (
            await session.execute(
                text(
                    "INSERT INTO workflow_actions "
                    "(run_id, step_id, tool, fingerprint, status) "
                    "VALUES (:run_id, :step_id, :tool, :fingerprint, 'started') "
                    "ON CONFLICT DO NOTHING RETURNING id"
                ),
                {
                    "run_id": run_id,
                    "step_id": step_id,
                    "tool": tool,
                    "fingerprint": print_,
                },
            )
        ).scalar_one_or_none()
        if inserted is not None:
            return None

        return (
            await session.execute(
                text(
                    "SELECT status FROM workflow_actions WHERE run_id = :run_id "
                    "AND step_id = :step_id AND fingerprint = :fingerprint"
                ),
                {"run_id": run_id, "step_id": step_id, "fingerprint": print_},
            )
        ).scalar_one_or_none()


async def _recorded_output(run_id: int, step_id: str, print_: str) -> str:
    async with session_scope() as session:
        output = (
            await session.execute(
                text(
                    "SELECT output FROM workflow_actions WHERE run_id = :run_id "
                    "AND step_id = :step_id AND fingerprint = :fingerprint"
                ),
                {"run_id": run_id, "step_id": step_id, "fingerprint": print_},
            )
        ).scalar_one_or_none()
    if isinstance(output, dict):
        content = output.get("content", "")
        return content if isinstance(content, str) else json.dumps(content)
    return "" if output is None else str(output)


async def _complete_write(run_id: int, step_id: str, print_: str, content: Any) -> None:
    async with session_scope() as session:
        await session.execute(
            text(
                "UPDATE workflow_actions SET status = 'completed', output = :output "
                "WHERE run_id = :run_id AND step_id = :step_id "
                "AND fingerprint = :fingerprint"
            ),
            {
                "output": json.dumps(
                    {"content": content if isinstance(content, str) else ""},
                    separators=(",", ":"),
                    ensure_ascii=False,
                ),
                "run_id": run_id,
                "step_id": step_id,
                "fingerprint": print_,
            },
        )


class WorkflowPolicyMiddleware(AgentMiddleware):
    """Enforces step authorization and write idempotency during a workflow run."""

    name = "workflow-permissions-and-checkpoints"

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[Any]],
    ) -> Any:
        ctx = current_execution()
        if ctx is None:
            # Not inside a workflow run: ordinary chat, nothing to enforce.
            return await handler(request)

        call = request.tool_call
        tool = call["name"]
        args = call.get("args") or {}
        call_id = call.get("id")

        ctx.tool_calls += 1
        ctx.signal.raise_if_cancelled()

        try:
            check_permission(ctx.step_model, tool, args)
        except Exception as error:
            ctx.failures.append(str(error))
            raise

        # The lease may have expired, or the user may have cancelled, since the step
        # began. Acting now would be acting without authority.
        async with session_scope() as session:
            state = (
                (
                    await session.execute(
                        text(
                            "SELECT status, cancel_requested, lease_owner "
                            "FROM workflow_runs WHERE id = :id"
                        ),
                        {"id": ctx.run_id},
                    )
                )
                .mappings()
                .one_or_none()
            )
        if (
            state is None
            or state["status"] != "running"
            or state["cancel_requested"]
            or state["lease_owner"] != ctx.owner
        ):
            ctx.failures.append("Run is no longer active")
            raise RuntimeError("Run is no longer active")

        read = is_read_tool(tool)
        print_ = fingerprint(tool, args)

        if not read:
            existing = await _claim_write(ctx.run_id, ctx.step.get("id", ""), tool, print_)
            if existing == "completed":
                # Already done in an earlier attempt: replay the recorded result
                # rather than performing the write twice.
                return ToolMessage(
                    content=await _recorded_output(ctx.run_id, ctx.step.get("id", ""), print_),
                    tool_call_id=call_id or "",
                    name=tool,
                )
            if existing is not None:
                message = f"Needs attention: previous {tool} outcome is uncertain"
                ctx.failures.append(message)
                raise RuntimeError(message)

        await record_event(
            ctx.run_id,
            {
                "type": "tool_start",
                "stepId": ctx.step.get("id"),
                "toolCallId": call_id,
                "tool": tool,
            },
        )

        try:
            result: Any = None
            attempts = 2 if read else 1
            for attempt in range(attempts):
                try:
                    result = await handler(request)
                    if isinstance(result, ToolMessage) and (
                        getattr(result, "status", None) == "error"
                        or _looks_like_failure(result.content)
                    ):
                        # A tool that returns an error string rather than raising
                        # must still count as a failure.
                        raise RuntimeError(str(result.content))
                    break
                except Exception as error:
                    if not read or attempt == attempts - 1 or not _is_transient(error):
                        raise
                    logger.warning("[workflow.policy] transient read failure on %s; retrying", tool)

            if result is None:
                raise RuntimeError("Tool returned no result")

            if not read:
                await _complete_write(
                    ctx.run_id,
                    ctx.step.get("id", ""),
                    print_,
                    result.content if isinstance(result, ToolMessage) else "",
                )

            await record_event(
                ctx.run_id,
                {
                    "type": "tool_end",
                    "stepId": ctx.step.get("id"),
                    "toolCallId": call_id,
                    "tool": tool,
                    "success": True,
                },
            )
            return result
        except Exception as error:
            ctx.failures.append(str(error))
            await record_event(
                ctx.run_id,
                {
                    "type": "tool_end",
                    "stepId": ctx.step.get("id"),
                    "toolCallId": call_id,
                    "tool": tool,
                    "success": False,
                    "error": str(error),
                },
            )
            raise


def workflow_policy() -> WorkflowPolicyMiddleware:
    return WorkflowPolicyMiddleware()
