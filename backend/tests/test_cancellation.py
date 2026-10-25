"""Tests for the AbortSignal stand-in.

These matter because `engine.py` decides a run's terminal status from *which* signal
fired — a shutdown re-queues the run, a timeout fails it — so reason propagation
through a composed signal has to be right.
"""

from __future__ import annotations

import asyncio

import pytest

from app.cancellation import (
    Cancellation,
    CancelledByCaller,
    ShutdownRequested,
    TimedOut,
    composed,
    timeout_signal,
)


def test_raise_if_cancelled_is_a_noop_until_latched() -> None:
    signal = Cancellation()
    signal.raise_if_cancelled()
    assert not signal.aborted

    signal.cancel(ShutdownRequested("stopping"))
    assert signal.aborted
    with pytest.raises(ShutdownRequested, match="stopping"):
        signal.raise_if_cancelled()


def test_first_reason_wins() -> None:
    """`AbortController` keeps its first reason; later aborts are ignored."""
    signal = Cancellation()
    signal.cancel(ShutdownRequested("first"))
    signal.cancel(TimedOut("second"))
    assert isinstance(signal.reason, ShutdownRequested)


def test_default_reason() -> None:
    signal = Cancellation()
    signal.cancel()
    with pytest.raises(CancelledByCaller):
        signal.raise_if_cancelled()


async def test_sleep_wakes_early_when_cancelled() -> None:
    signal = Cancellation()

    async def cancel_soon() -> None:
        await asyncio.sleep(0.05)
        signal.cancel()

    canceller = asyncio.create_task(cancel_soon())
    loop = asyncio.get_running_loop()
    started = loop.time()
    # A 30s sleep must return as soon as the signal latches, not 30s later.
    was_cancelled = await signal.sleep(30)
    assert was_cancelled is True
    assert loop.time() - started < 1.0
    await canceller


async def test_sleep_returns_false_on_timeout() -> None:
    signal = Cancellation()
    assert await signal.sleep(0.01) is False
    assert not signal.aborted


async def test_composed_propagates_the_firing_reason() -> None:
    shutdown, per_run = Cancellation(), Cancellation()
    async with composed(shutdown, per_run) as combined:
        assert not combined.aborted
        per_run.cancel(TimedOut("run budget"))
        await asyncio.sleep(0)  # let the watcher run
        assert combined.aborted
        # engine.py branches on this type to choose the terminal status.
        assert isinstance(combined.reason, TimedOut)


async def test_composed_is_already_aborted_if_an_input_is() -> None:
    already = Cancellation()
    already.cancel(ShutdownRequested("late join"))
    async with composed(already, Cancellation()) as combined:
        assert combined.aborted
        assert isinstance(combined.reason, ShutdownRequested)


async def test_composed_cleans_up_its_watchers() -> None:
    before = len(asyncio.all_tasks())
    async with composed(Cancellation(), Cancellation()):
        pass
    await asyncio.sleep(0)
    assert len(asyncio.all_tasks()) <= before, "watcher tasks must not leak"


async def test_timeout_signal_fires_and_is_cancellable() -> None:
    async with timeout_signal(0.05) as signal:
        assert not signal.aborted
        await asyncio.sleep(0.1)
        assert signal.aborted
        assert isinstance(signal.reason, TimedOut)

    # Leaving the block early must not leave a pending timer task behind.
    before = len(asyncio.all_tasks())
    async with timeout_signal(30):
        pass
    await asyncio.sleep(0)
    assert len(asyncio.all_tasks()) <= before


def test_cancellation_is_not_an_asyncio_cancelled_error() -> None:
    """Subclassing CancelledError would let asyncio swallow these silently."""
    assert not issubclass(CancelledByCaller, asyncio.CancelledError)
