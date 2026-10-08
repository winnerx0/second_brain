# Task List: Run Workflow Worker in the Backend Process

## Task 1: Extract the worker loop as a startable backend service

**Description:** Move the polling loop from the standalone worker entry point into an exported lifecycle function that can be started by the API process without blocking server startup.

**Acceptance criteria:**

- [x] Worker heartbeat, scheduling, run claiming/execution, and learning behavior are preserved.
- [x] The service exposes a stop mechanism that aborts polling and active work, waits for active tasks, and removes its heartbeat.
- [x] Poll errors remain logged and retried on the existing interval.

**Verification:**

- [x] Run focused workflow tests, `bun run typecheck`, and `bun run build`.
- [ ] Run the lifecycle integration check with `WORKFLOW_TEST_DATABASE_URL` set; the test is present but skipped without an isolated Postgres database.

**Dependencies:** None

**Files likely touched:**

- `src/workflows/worker.ts`
- `src/workflows/worker.test.ts` (if lifecycle tests are added)

**Estimated scope:** Small

## Task 2: Start and stop the worker with the backend process

**Description:** Start the workflow service from the backend entry point and connect its shutdown lifecycle to process termination while keeping the HTTP server startup responsive.

**Acceptance criteria:**

- [x] A normal `bun run dev` or `bun start` starts one embedded worker loop.
- [x] Startup does not wait for a polling cycle or long workflow execution.
- [x] SIGTERM and SIGINT stop polling and drain the worker cleanly.

**Verification:**

- [x] Run `bun run typecheck` and `bun run build`.
- [ ] Start the backend and confirm `/workflows/health` reports its live heartbeat; not run against a live database in this workspace.

**Dependencies:** Task 1

**Files likely touched:**

- `src/index.ts`
- `src/workflows/worker.ts`

**Estimated scope:** Small

## Checkpoint: After Tasks 1-2

- [x] Focused workflow tests, typecheck, and build pass.
- [ ] A queued/manual workflow is claimed and run by the API process; requires the isolated Postgres integration setup.
- [ ] Shutdown leaves no fresh heartbeat for the stopped process; the integration check requires the isolated Postgres setup.

## Task 3: Remove separate worker build and command wiring

**Description:** Remove the standalone worker npm script and worker bundle, and run only the backend service in the Docker deployment while preserving health checks and environment settings.

**Acceptance criteria:**

- [x] Backend image builds only the backend entry point.
- [x] Docker Compose no longer starts a separate worker container.
- [x] The worker command is no longer presented as a supported startup requirement.

**Verification:**

- [x] Run `bun run build`.
- [x] Inspect the Compose configuration and confirm a single backend service owns API and worker behavior.

**Dependencies:** Task 2

**Files likely touched:**

- `package.json`
- `Dockerfile`
- `../docker-compose.yaml`

**Estimated scope:** Medium

## Task 4: Update backend workflow setup and validation documentation

**Description:** Align workflow setup, worker health semantics, and validation instructions with the embedded worker design.

**Acceptance criteria:**

- [x] `WORKFLOWS.md` describes one backend process for local and Docker setup.
- [x] Root `README.md` no longer instructs users to launch a separate worker.
- [x] Validation instructions no longer reference a standalone worker bundle.

**Verification:**

- [x] Search docs and package/deployment files for stale `bun run worker`, `dist/worker.js`, or separate-worker instructions.
- [x] Confirm all documented commands exist in `package.json`.

**Dependencies:** Task 3

**Files likely touched:**

- `WORKFLOWS.md`
- `../README.md`

**Estimated scope:** Small

## Checkpoint: Complete

- [x] All task acceptance criteria are met.
- [x] Typecheck and backend build pass.
- [x] Local and container startup instructions describe the same process topology.
- [x] Ready for review.
