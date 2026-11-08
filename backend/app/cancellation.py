from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator, Iterable


class CancelledByCaller(Exception):
    """Raised by `raise_if_cancelled()`. Deliberately not `asyncio.CancelledError`.

    Subclassing `CancelledError` would make these indistinguishable from a real task
    cancellation and would be swallowed by asyncio's own machinery.
    """


class ShutdownRequested(CancelledByCaller):
    """The process is stopping; in-flight work should be re-queued, not failed."""


class TimedOut(CancelledByCaller):
    """The run exceeded its time budget."""


class Cancellation:
    """A one-way latch that many awaiters can observe."""

    def __init__(self) -> None:
        self._event = asyncio.Event()
        self._reason: BaseException | None = None

    def cancel(self, reason: BaseException | None = None) -> None:
        """Latch the signal. The first reason wins, as with `AbortController`."""
        if self._event.is_set():
            return
        self._reason = reason or CancelledByCaller("aborted")
        self._event.set()

    @property
    def aborted(self) -> bool:
        return self._event.is_set()

    @property
    def reason(self) -> BaseException | None:
        return self._reason

    def raise_if_cancelled(self) -> None:
        """`signal.throwIfAborted()`."""
        if self._event.is_set():
            raise self._reason or CancelledByCaller("aborted")

    async def wait(self) -> None:
        await self._event.wait()

    async def sleep(self, seconds: float) -> bool:
        """Sleep, waking early if cancelled. Returns True if it was cancelled.

        Used by the worker loop and the SSE heartbeats.
        """
        try:
            await asyncio.wait_for(self._event.wait(), timeout=seconds)
        except TimeoutError:
            return False
        return True

    @classmethod
    def any(cls, *signals: Cancellation) -> Cancellation:
        """`AbortSignal.any()` — a signal that latches when any input does.

        The returned object owns a background task; use `composed()` when the
        lifetime is scoped, so the watcher is always cleaned up.
        """
        combined = cls()
        for signal in signals:
            if signal.aborted:
                combined.cancel(signal.reason)
                return combined

        async def watch(source: Cancellation) -> None:
            await source.wait()
            combined.cancel(source.reason)

        combined._watchers = [  # type: ignore[attr-defined]
            asyncio.create_task(watch(signal)) for signal in signals
        ]
        return combined

    def close(self) -> None:
        """Cancel any watcher tasks created by `any()`."""
        for task in getattr(self, "_watchers", []):
            task.cancel()


@contextlib.asynccontextmanager
async def composed(*signals: Cancellation) -> AsyncIterator[Cancellation]:
    """Scoped `Cancellation.any()` that always tears its watchers down."""
    combined = Cancellation.any(*signals)
    try:
        yield combined
    finally:
        combined.close()


@contextlib.asynccontextmanager
async def timeout_signal(seconds: float) -> AsyncIterator[Cancellation]:
    """`AbortSignal.timeout(ms)` as a scoped signal."""
    signal = Cancellation()

    async def expire() -> None:
        await asyncio.sleep(seconds)
        signal.cancel(TimedOut(f"timed out after {seconds:g}s"))

    task = asyncio.create_task(expire())
    try:
        yield signal
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


async def shielded(coro: Iterable[object] | object) -> object:
    """`asyncio.shield` with a clearer name at the call sites that need it.

    Used where a cancellation path must still persist state — without the shield the
    write is cancelled along with the task and the run is left stranded.
    """
    return await asyncio.shield(coro)  # type: ignore[arg-type]
