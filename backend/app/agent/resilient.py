"""Uniform tool-failure handling — port of `src/tools/resilient.ts`.

`src/agent.ts` wrapped every top-level tool with `resilientTool(t, {retries: 0})`.
With `retries: 0` the retry loop runs exactly once, so the only behaviour that was
ever live is the error path: a thrown exception becomes the string

    Error: <tool name> failed: <message>

returned to the model, rather than propagating and halting the graph. That is what
`ToolErrorMiddleware` does natively, so the 20 tools are no longer re-wrapped
individually — re-wrapping in LangChain rebuilds the tool's schema from the wrapper's
signature, which is a needless risk.

The transient-detection helpers are ported anyway: they are pure, they are the only
part with interesting behaviour, and `app/workflows/policy.py` applies the same
"does this result string look like a retryable failure?" judgement when deciding
whether to retry a read once.

Note `retries` is still accepted so the original semantics can be restored by
composing `ToolRetryMiddleware` inside this one.
"""

from __future__ import annotations

from langchain.agents.middleware import (
    AgentMiddleware,
    ToolCallRequest,
    ToolErrorMiddleware,
    ToolRetryMiddleware,
)

from app.logging import get_logger

logger = get_logger("resilient")

#: Substrings that mark a failure as worth retrying. Ported verbatim — the list is
#: matched against lower-cased text, so entries must stay lower-case.
TRANSIENT_HINTS: tuple[str, ...] = (
    "timeout",
    "timed out",
    "rate limit",
    "rate-limit",
    "429",
    "500",
    "502",
    "503",
    "504",
    "econnreset",
    "etimedout",
    "socket hang up",
    "network",
    "temporarily",
    "try again",
    "overloaded",
)


def is_transient_result(output: object) -> bool:
    """Whether a tool's *return value* looks like a retryable soft failure.

    Requires both that the string reads as a failure and that it carries a transient
    hint, so a deterministic "Error: no such repo" is not retried.
    """
    if not isinstance(output, str):
        return False
    text = output.lower()
    looks_like_error = text.startswith("error") or "failed" in text
    return looks_like_error and any(hint in text for hint in TRANSIENT_HINTS)


def is_transient_error(error: BaseException | str) -> bool:
    """Whether a raised exception looks retryable.

    `fetch` is included because Bun surfaced network faults as bare `fetch failed`;
    the Python equivalents are matched by the hints above plus httpx's own wording.
    """
    text = (str(error) if not isinstance(error, str) else error).lower()
    return any(hint in text for hint in TRANSIENT_HINTS) or "fetch" in text


def format_tool_error(tool_name: str, error: BaseException) -> str:
    """The exact string `resilientTool` returned, which the agent prompt expects."""
    return f"Error: {tool_name} failed: {error}"


def resilient_middleware(retries: int = 0) -> list[AgentMiddleware]:
    """Middleware stack replacing `resilientTool`.

    Ordering note: the retry middleware must sit *inside* the error middleware, so a
    genuinely transient failure is retried before its final failure is converted into
    a message for the model.
    """

    async def aon_error(exc: Exception, request: ToolCallRequest) -> str:
        name = request.tool_call["name"]
        logger.error("[resilient] %s error (no further retries)", name, exc_info=exc)
        return format_tool_error(name, exc)

    def on_error(exc: Exception, request: ToolCallRequest) -> str:
        name = request.tool_call["name"]
        logger.error("[resilient] %s error (no further retries)", name, exc_info=exc)
        return format_tool_error(name, exc)

    stack: list[AgentMiddleware] = [
        ToolErrorMiddleware(on_error, aon_error=aon_error),
    ]
    if retries > 0:
        # `baseDelayMs * (attempt + 1)` in the TypeScript — linear, 400 ms step.
        stack.append(
            ToolRetryMiddleware(
                max_retries=retries,
                backoff_factor=1.0,
                initial_delay=0.4,
                on_failure="return_message",
            )
        )
    return stack
