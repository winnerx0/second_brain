"""Structured logging and OpenTelemetry wiring.

Replaces `src/logger.ts` (winston) plus the Kivia and Oluso middleware that
`src/app.ts` installed. Oluso's request context and breadcrumbs become ordinary
span attributes and bound structlog context; its 5xx auto-reporting becomes a
recorded exception on the request span.

Log call sites keep the `[module.action]` prefix convention from the TypeScript
code, so `logger.info("[chat] received: %s", text)` reads the same in both.
"""

from __future__ import annotations

import logging
import os
import sys

import structlog
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

_configured = False


def _add_trace_context(_logger: object, _name: str, event_dict: dict) -> dict:
    """Stitch the active span's ids into every log line."""
    span = trace.get_current_span()
    context = span.get_span_context()
    if context.is_valid:
        event_dict["trace_id"] = format(context.trace_id, "032x")
        event_dict["span_id"] = format(context.span_id, "016x")
    return event_dict


def configure_logging() -> None:
    """Idempotent; safe to call from both app startup and test fixtures."""
    global _configured
    if _configured:
        return

    # Human-readable in a terminal, JSON once it is piped to a log collector.
    renderer: structlog.typing.Processor = (
        structlog.dev.ConsoleRenderer()
        if sys.stderr.isatty()
        else structlog.processors.JSONRenderer()
    )

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.stdlib.add_log_level,
            structlog.stdlib.add_logger_name,
            structlog.stdlib.PositionalArgumentsFormatter(),
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            _add_trace_context,
            renderer,
        ],
        wrapper_class=structlog.stdlib.BoundLogger,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )

    logging.basicConfig(
        format="%(message)s",
        stream=sys.stderr,
        level=getattr(logging, os.environ.get("LOG_LEVEL", "INFO").upper(), logging.INFO),
    )
    # uvicorn installs its own handlers; let them propagate into structlog instead.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logging.getLogger(name).handlers.clear()
        logging.getLogger(name).propagate = True

    _configured = True


def configure_tracing() -> None:
    """Set up the OTel tracer provider.

    No exporter is configured unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set, so local
    development pays nothing and a collector can be pointed at the service later
    without a code change.
    """
    if trace.get_tracer_provider().__class__ is TracerProvider:
        return

    provider = TracerProvider(
        resource=Resource.create(
            {
                "service.name": os.environ.get("OTEL_SERVICE_NAME", "aira-backend"),
                "service.version": os.environ.get("OTEL_SERVICE_VERSION", "0.1.0"),
            }
        )
    )
    if os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"):
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(provider)


def get_logger(name: str = "app") -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(name)


logger: structlog.stdlib.BoundLogger = structlog.get_logger("app")
