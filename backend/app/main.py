"""FastAPI application factory — port of `src/app.ts` plus `src/index.ts`'s wiring.

Three things that were module-level side effects in the TypeScript now run in the
lifespan, so importing the app no longer needs a reachable database (which is what
lets the route tests use `ASGITransport`):

* `await seedConnections()` at `src/app.ts:85`;
* the OAuth pending-state sweeper's bare `setInterval` in `src/oauth.ts`;
* the workflow worker, which `src/index.ts` started before `Bun.serve`.

The Kivia and Oluso middleware are replaced by OpenTelemetry instrumentation; the
global `app.onError` handler keeps returning the same opaque 500 body.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.config import get_settings
from app.connections import seed_connections
from app.db.engine import dispose_engine
from app.errors import AppError
from app.http import close_client
from app.json import JsonResponse
from app.logging import configure_logging, configure_tracing, get_logger
from app.oauth import prune_states
from app.routes import chat, graph, health, memories, oauth, sessions, workflows
from app.routes import connections as connections_routes
from app.workflows.worker import WorkflowWorker

logger = get_logger("http")


OAUTH_STATE_SWEEP_INTERVAL = 5 * 60


async def _sweep_oauth_states(stop: asyncio.Event) -> None:
    while not stop.is_set():
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=OAUTH_STATE_SWEEP_INTERVAL)
        if stop.is_set():
            return
        try:
            dropped = prune_states()
            if dropped:
                logger.info("[oauth] pruned %d expired state(s)", dropped)
        except Exception as exc:  # pragma: no cover - a sweep failure must not kill the task
            logger.warning("[oauth] state sweep failed: %s", exc)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None]:
    configure_logging()
    configure_tracing()
    logger.info("[startup] starting")
    await seed_connections()

    stop = asyncio.Event()
    sweeper = asyncio.create_task(_sweep_oauth_states(stop), name="oauth-state-sweeper")

    # The worker lives in this process, as src/index.ts did, which is why
    # /workflows/health reports worker liveness and compose allows a 17m stop grace
    # period. Run with a single uvicorn worker; see app/workflows/worker.py.
    worker = WorkflowWorker()
    await worker.start()

    try:
        yield
    finally:
        logger.info("[shutdown] stopping")
        # Stop the worker first and let in-flight runs settle; they record
        # themselves as queued so a restart resumes them.
        await worker.stop()
        stop.set()
        sweeper.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await sweeper
        await close_client()
        await dispose_engine()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Aira",
        default_response_class=JsonResponse,
        lifespan=lifespan,
        # The TypeScript service exposed no schema endpoints; keep the surface identical.
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.APP_URL],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    _register_exception_handlers(app)
    _instrument(app)

    app.include_router(health.router)
    app.include_router(sessions.router)
    app.include_router(memories.router)
    app.include_router(graph.router)
    app.include_router(connections_routes.router)
    app.include_router(oauth.router)
    app.include_router(chat.router)
    app.include_router(workflows.router)
    return app


def _register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(_request: Request, exc: AppError) -> JsonResponse:
        return JsonResponse({"error": str(exc)}, status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_request: Request, exc: RequestValidationError) -> JsonResponse:
        # FastAPI's default is a 422 with a different body. The TypeScript service
        # surfaced zod failures through Hono's error handler as a 400 carrying the
        # message, so match that.
        errors = exc.errors()
        message = errors[0].get("msg", "Invalid request") if errors else "Invalid request"
        return JsonResponse({"error": message}, status_code=400)

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_request: Request, exc: StarletteHTTPException) -> JsonResponse:
        detail = exc.detail if isinstance(exc.detail, str) else "Request failed"
        return JsonResponse({"error": detail}, status_code=exc.status_code)

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JsonResponse:
        logger.error("[http] %s %s", request.method, request.url.path, exc_info=exc)
        return JsonResponse({"error": "Internal server error"}, status_code=500)


_httpx_instrumented = False


def _instrument(app: FastAPI) -> None:
    """Attach OpenTelemetry, skipping the endpoints the healthcheck polls."""
    global _httpx_instrumented
    try:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

        FastAPIInstrumentor.instrument_app(app, excluded_urls="health,workflows/health")
    except Exception as exc:  # pragma: no cover - instrumentation must never block boot
        logger.warning("[startup] fastapi instrumentation unavailable: %s", exc)

    if _httpx_instrumented:
        return
    try:
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor

        HTTPXClientInstrumentor().instrument()
        _httpx_instrumented = True
    except Exception as exc:  # pragma: no cover
        logger.warning("[startup] httpx instrumentation unavailable: %s", exc)


app = create_app()
