# Implementation Plan: Run Workflow Worker in the Backend Process

## Overview

Move workflow polling, run execution, and learning into the backend server process so a normal backend start handles both HTTP traffic and workflow jobs. Remove the separate worker command and image artifact, retain the existing Postgres coordination and workflow limits, and update backend setup and health documentation.

## Architecture Decisions

- Extract the polling loop into an importable lifecycle function and start it from the backend entry point. Keep `src/workflows/engine.ts` responsible for scheduling and execution logic.
- Start one worker loop per backend process. Existing Postgres locks and unique constraints continue coordinating multiple backend replicas; the global four-run cap remains enforced by `claimRun`.
- Keep worker heartbeat rows so `/workflows/health` continues reporting active backend worker processes.
- On process shutdown, stop accepting new HTTP connections and drain in-flight requests, with a timed forced HTTP close; abort active runs, wait for active run and learning tasks to settle, and remove the process heartbeat.
- Do not change the database schema or workflow execution semantics.

## Task List

### Phase 1: Embed worker lifecycle

- [ ] Task 1: Extract the worker loop as a startable backend service.
- [ ] Task 2: Start and stop the worker with the backend process.

### Checkpoint: Embedded execution

- [ ] Focused workflow tests, typecheck, and backend build pass.
- [ ] Health reports the embedded worker and a queued/manual run can execute.

### Phase 2: Remove separate-worker setup

- [ ] Task 3: Remove separate worker build and command wiring.
- [ ] Task 4: Update backend workflow setup and validation documentation.

### Checkpoint: Complete

- [ ] Local and Docker setup use one backend process for HTTP and workflow execution.
- [ ] Documentation matches the shipped process and configuration.
- [ ] All acceptance criteria are met and ready for review.

## Risks and Mitigations

| Risk                                                     | Impact | Mitigation                                                                                     |
| -------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------- |
| Shutdown timing interrupts active workflow actions       | Medium | Reuse the worker abort signal, await active tasks, and preserve existing lease recovery rules. |
| Each backend replica starts a worker loop                | Low    | Preserve Postgres locking and global concurrency enforcement.                                  |
| HTTP startup races with the worker's first database call | Medium | Run the worker loop in the background; log and retry polling errors as today.                  |
| Docker shutdown grace period is shorter than run timeout | Medium | Set it to 17 minutes for the 15-minute run limit plus learning and cleanup.                    |
| Worker health is hidden after removing its container     | Medium | Require a fresh `/workflows/health` worker heartbeat in the backend health check.              |

## Open Questions

- None.
