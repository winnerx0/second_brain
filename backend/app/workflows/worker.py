from __future__ import annotations

import asyncio
import contextlib
from typing import Any

from sqlalchemy import text

from app.cancellation import Cancellation, ShutdownRequested
from app.config import get_settings
from app.db.engine import session_scope
from app.logging import get_logger
from app.workflows.engine import (
    MAX_CONCURRENT_RUNS,
    WORKER_ID,
    claim_run,
    execute_run,
    schedule_due,
)
from app.workflows.learning import learn_one_run

logger = get_logger("workflows")

#: Poll cadence. `/workflows/health` treats a heartbeat older than 45s as dead.
POLL_SECONDS = 15.0


class WorkflowWorker:
    """Polls for due schedules and queued runs until stopped."""

    def __init__(self, worker_id: str = WORKER_ID) -> None:
        self.worker_id = worker_id
        self.shutdown = Cancellation()
        self._active: set[asyncio.Task[Any]] = set()
        self._learning: asyncio.Task[Any] | None = None
        self._loop: asyncio.Task[Any] | None = None

    async def start(self) -> None:
        self._loop = asyncio.create_task(self._run(), name="workflow-worker")

    async def stop(self) -> None:
        """Stop polling, let in-flight work settle, then drop the heartbeat.

        In-flight runs are *not* cancelled outright: `execute_run` sees the shutdown
        signal, records the run as `queued` rather than `failed`, and a restart
        resumes it from its step checkpoints.
        """
        self.shutdown.cancel(ShutdownRequested("worker stopping"))
        if self._loop is not None:
            await self._loop

    async def _heartbeat(self) -> None:
        async with session_scope() as session:
            await session.execute(
                text(
                    "INSERT INTO workflow_workers (id) VALUES (:id) "
                    "ON CONFLICT (id) DO UPDATE SET heartbeat_at = now()"
                ),
                {"id": self.worker_id},
            )

    async def _remove_heartbeat(self) -> None:
        with contextlib.suppress(Exception):
            async with session_scope() as session:
                await session.execute(
                    text("DELETE FROM workflow_workers WHERE id = :id"),
                    {"id": self.worker_id},
                )

    def _spawn_run(self, run: dict[str, Any]) -> None:
        async def guarded() -> None:
            try:
                await execute_run(run, self.worker_id, self.shutdown)
            except Exception as error:
                # One bad run must never take the loop down, nor its siblings.
                logger.error("[workflow.execute] %s", error, exc_info=error)

        task = asyncio.create_task(guarded(), name=f"workflow-run-{run['id']}")
        self._active.add(task)
        task.add_done_callback(self._active.discard)

    def _maybe_start_learning(self) -> None:
        if not get_settings().WORKFLOW_LEARNING_ENABLED:
            return
        if self._learning is not None and not self._learning.done():
            return

        async def guarded() -> None:
            try:
                await learn_one_run()
            except Exception as error:
                logger.error("[workflow.learn] %s", error, exc_info=error)

        self._learning = asyncio.create_task(guarded(), name="workflow-learning")

    async def _run(self) -> None:
        logger.info("[workflows] worker %s started", self.worker_id)
        try:
            while not self.shutdown.aborted:
                try:
                    await self._heartbeat()
                    await schedule_due()

                    while len(self._active) < MAX_CONCURRENT_RUNS and not self.shutdown.aborted:
                        run = await claim_run(self.worker_id)
                        if run is None:
                            break
                        self._spawn_run(run)

                    self._maybe_start_learning()
                except Exception as error:
                    logger.error("[workflow.worker] %s", error, exc_info=error)

                await self.shutdown.sleep(POLL_SECONDS)
        finally:
            # Settle rather than cancel, so each run records its own outcome.
            if self._active:
                await asyncio.gather(*self._active, return_exceptions=True)
            if self._learning is not None:
                await asyncio.gather(self._learning, return_exceptions=True)
            await self._remove_heartbeat()
            logger.info("[workflows] worker %s stopped", self.worker_id)
