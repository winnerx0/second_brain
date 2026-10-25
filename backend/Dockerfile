FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim AS build
WORKDIR /app
# UV_HTTP_TIMEOUT: the 30s default is not enough for the larger wheels
# (google-api-python-client is 16MiB) on a slow link.
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_HTTP_TIMEOUT=180

# Dependencies first, so a source change does not invalidate the dependency layer.
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

COPY . .
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-dev

FROM python:3.13-slim-bookworm AS final
WORKDIR /app

# Every timestamp this service reads or writes is treated as UTC. The schema mixes
# naive `timestamp` and `timestamptz` columns, so a non-UTC container clock would
# shift workflow schedules.
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    TZ=UTC

COPY --from=build /app /app

EXPOSE 3005

CMD ["sh", "-c", "python -m app.scripts.bootstrap_db && exec uvicorn app.main:app --host 0.0.0.0 --port 3005 --workers 1 --timeout-graceful-shutdown 80"]
