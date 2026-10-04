# Scheduled workflows

Create an automation in chat, Telegram, or the Workflows dashboard: “Every weekday at 8am, summarize my GitHub PRs and calendar, then send it to Telegram.” Clear requests activate immediately; unresolved schedules, destinations, or connections produce clarification questions. The timezone is always visible and defaults to `USER_TIMEZONE` (`Africa/Lagos`).

## Run locally

From `backend/`, install dependencies and run `bun run db:migrate`, then start `bun run dev` and `bun run worker` in separate terminals. Start the frontend with `bun --cwd ../web run dev`. Backend port: 3005. Frontend port: 3001. Existing text-only workflows are retained; use “Edit instructions” to convert them before execution.

`docker compose up -d --build` starts the backend and a separate worker. The backend applies migrations before starting; the worker waits for backend health. The database remains the externally configured Postgres instance. No live deployment or production migration is performed by the source-code change itself.

The backend is bound to `127.0.0.1:3005` on the host. Configure your existing external proxy to forward to it, terminate HTTPS, enforce access control for this single-user application, disable SSE buffering, and support WebSocket upgrades. Set `APP_URL`, `OAUTH_REDIRECT_BASE_URL`, `PUBLIC_API_URL`, and frontend `VITE_API_BASE_URL` to the appropriate public URLs. Nginx and Certbot are no longer included. Existing certificate/data volumes are not deleted.

## Execution rules

- Manual, one-time, and five-field recurring cron triggers are supported. Schedules retain their IANA timezone; instants are stored as UTC.
- The worker polls every 15 seconds. Postgres row locks, unique occurrence keys and a partial unique active-run index coordinate multiple workers.
- Four runs may execute globally, with one active run per workflow and up to four ready specialist steps per run. Overdue occurrences coalesce to the latest occurrence, including while the previous run is still active.
- Each run freezes its revision. Editing changes future runs and cancels queued scheduled runs from older revisions. Pausing cancels queued scheduled runs, but does not cancel an active run or prevent explicit manual runs.
- Runs time out after 15 minutes. Cancellation prevents subsequent actions; an already-issued external request cannot be undone.
- A 90-second expired lease recovers safe work from persisted step checkpoints. Unknown write outcomes become `needs_attention`; the worker does not automatically repeat them. This is not an exactly-once guarantee for external services.
- Writes are constrained by tool name and exact target arguments. One logical write per tool/target per step is replayed from its recorded result after recovery; use separate steps for intentional repeated writes to the same target. Unknown dynamic write targets require clarification. Read operations may retry a transient failure once; specialist agents are never blindly retried as a whole.
- `SCHEDULER_ENABLED=false` stops scheduling new occurrences; queued/manual runs still execute. `WORKFLOW_LEARNING_ENABLED=false` disables background run reflection.

## Learning

Conversation memory retains durable user facts and corrections. Run reflection learns from persisted step states, failures and explicit feedback. Lessons are scoped to their workflow, show confidence and source run, and can be corrected or forgotten.

Suggested workflow changes remain pending proposals. Review the current/proposed definitions before acceptance. A stale proposal cannot overwrite a newer revision. Restoring an old revision creates a new one; past one-time schedules must be updated before reactivation. This feature does not fine-tune model weights or rewrite application code.

## API

All paths below are under `/workflows`:

| Method/path | Behavior |
| --- | --- |
| `POST /plan` | `{instructions}` → `{definition, clarifications, preview}` |
| `GET /`, `GET /:id` | List/load workflows |
| `POST /` | `{definition, enabled?}` → created workflow |
| `PATCH /:id` | `{definition, expectedRevision, enabled?}` or `{enabled}` |
| `DELETE /:id` | Delete workflow/history; rejects while a run is active |
| `POST /:id/run` | Enqueue; `202 {runId}`; repeated requests return the active run |
| `GET /:id/runs?before=ID` | Paginated run history |
| `GET /runs/:id` | Frozen definition, step results and final status |
| `GET /runs/:id/events` | Live SSE; supports `Last-Event-ID` or `?after=ID` |
| `POST /runs/:id/cancel` | Request cancellation |
| `POST /runs/:id/feedback` | `{feedback}`; enqueue reflection |
| `GET /:id/learning` | Lessons, proposals and revisions |
| `PATCH /lessons/:id` | `{lesson}` correction or `{active:false}` to forget |
| `POST /proposals/:id/accept` or `/reject` | Review a suggested revision |
| `GET /health` | Recent worker count, scheduling flag, overdue count and run counts |

`POST /:id/run` now returns JSON immediately instead of buffered SSE; clients must use the run-events endpoint. Existing `/cron/briefing` and `/cron/maintenance` endpoints retain bearer-secret authorization and are not automatically duplicated as schedules.

## Validation

Run `bun test src/workflows/types.test.ts`, `bun run typecheck`, and `bun run build` in `backend/`; run `bun run typecheck` and `bun run build` in `web/`. Build the worker with `bun build --target=bun --outfile=dist/worker.js src/workflows/worker.ts`.

Integration tests require a disposable local Postgres database named `workflow_test` with pgvector. They intentionally recreate only that database's public schema. Pass its URL explicitly as `WORKFLOW_TEST_DATABASE_URL` when running `bun test src/workflows`; they never fall back to the application's `DATABASE_URL`. Tests exercise migration preservation, duplicate claims, catch-up, revision conflicts, cancellation, uncertain writes, run persistence and proposal acceptance.
