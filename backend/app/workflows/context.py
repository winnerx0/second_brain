"""The ambient workflow-execution context.

Shared between `app/agent/subagents/base.py` (which injects an authorization notice
into a subagent's prompt while a workflow step is running) and
`app/workflows/policy.py` (which enforces permissions and the write ledger). It lives
in its own module so the subagents do not import the workflow engine.

`AsyncLocalStorage` in `src/workflows/policy.ts`; a `ContextVar` here. The dataclass
is mutable on purpose — the TypeScript does `ctx.toolCalls++` and
`ctx.failures.push(...)`, and `executeStep` reads both afterwards to decide whether
the step really succeeded.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any

from app.cancellation import Cancellation


@dataclass
class ExecutionContext:
    run_id: int
    #: The frozen step definition from the run's revision.
    step: dict[str, Any]
    signal: Cancellation
    #: Lease owner id; a tool call aborts if the lease has moved on.
    owner: str
    failures: list[str] = field(default_factory=list)
    tool_calls: int = 0


_execution_context: ContextVar[ExecutionContext | None] = ContextVar(
    "workflow_execution_context", default=None
)


@contextmanager
def execution_context(ctx: ExecutionContext) -> Iterator[ExecutionContext]:
    token = _execution_context.set(ctx)
    try:
        yield ctx
    finally:
        _execution_context.reset(token)


def current_execution() -> ExecutionContext | None:
    """`executionContext.getStore()` — None outside a workflow run."""
    return _execution_context.get()
