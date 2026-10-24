"""SQLAlchemy models — port of `src/db/schema.ts`.

These models describe a database that already exists, created by the Drizzle
migrations in `backend/drizzle/0000` .. `0006`. They must reproduce that schema
exactly, down to constraint and index *names*, so `alembic revision --autogenerate`
reports no difference. Where `schema.ts` and the migrations disagree, the
migrations win — they are what actually ran.

Two fidelity hazards worth stating up front:

* `timestamp` vs `timestamp with time zone` is mixed. Everything created by
  migrations 0000-0005 is naive (`DateTime()`); the scheduling columns added by
  0006 are timezone-aware (`DateTime(timezone=True)`). Getting one wrong silently
  shifts workflow schedules.
* `graph_edges.from_node_id` / `to_node_id` and `chat_history.session_id` have no
  foreign keys in the real database. Do not add them.

Not modelled: `linkedin_drafts` (created by 0003, never dropped, already absent from
`schema.ts`). It is filtered out in `alembic/env.py` instead of being modelled, so
autogenerate neither drops it nor re-creates it.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    ARRAY,
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    PrimaryKeyConstraint,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import ENUM, JSONB, REAL
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

EMBEDDING_DIMENSIONS = 1536

#: Native Postgres enums created by `drizzle/0000`. `create_type=False` keeps Alembic
#: and `create_all()` from trying to re-issue `CREATE TYPE`.
memory_classification = ENUM(
    "identity",
    "relationships",
    "behavior",
    "preferences",
    "corrections",
    "knowledge",
    "unclassified",
    name="memory_classification",
    create_type=False,
)
memory_tier = ENUM(
    "short_term",
    "long_term",
    "lifelong",
    name="memory_tier",
    create_type=False,
)

_NOW = text("now()")


class Base(DeclarativeBase):
    pass


# ─── Briefings and task tracking ─────────────────────────────────────────────


class AgentRun(Base):
    __tablename__ = "agent_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    ran_at: Mapped[dt.datetime] = mapped_column(DateTime(), nullable=False, server_default=_NOW)
    briefing_text: Mapped[str] = mapped_column(Text, nullable=False)
    sources_fetched: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False)
    success: Mapped[bool] = mapped_column(Boolean, nullable=False)


class TaskHistory(Base):
    __tablename__ = "task_history"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    task_name: Mapped[str] = mapped_column(Text, nullable=False)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    first_seen: Mapped[dt.date] = mapped_column(Date, nullable=False)
    times_deferred: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    completed_at: Mapped[dt.date | None] = mapped_column(Date)


class Memory(Base):
    """Legacy flat memory store.

    Superseded by `graph_nodes` where `kind = 'memory'` (migration 0004 copied the
    rows across). No live code path reads or writes it, but the table and its data
    still exist, so it stays modelled.
    """

    __tablename__ = "memories"
    __table_args__ = (UniqueConstraint("key", name="memories_key_unique"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    key: Mapped[str] = mapped_column(Text, nullable=False)
    value: Mapped[str] = mapped_column(Text, nullable=False)
    classification: Mapped[str] = mapped_column(
        memory_classification, nullable=False, server_default=text("'unclassified'")
    )
    tier: Mapped[str] = mapped_column(
        memory_tier, nullable=False, server_default=text("'short_term'")
    )
    importance: Mapped[float] = mapped_column(REAL, nullable=False, server_default=text("0.2"))
    vector: Mapped[Any] = mapped_column(Vector(EMBEDDING_DIMENSIONS), nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(), nullable=False, server_default=_NOW)
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime(), nullable=False, server_default=_NOW)


# ─── Chat ────────────────────────────────────────────────────────────────────


class ChatSession(Base):
    __tablename__ = "chat_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'New Chat'"))
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(), nullable=False, server_default=_NOW)
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime(), nullable=False, server_default=_NOW)


class ChatHistory(Base):
    """One message per row.

    `session_id` is deliberately un-constrained: NULL means the default, session-less
    conversation, and `src/agent.ts` selects on `IS NULL` for it. `content` holds a
    JSON string whose shape depends on `role`, which is one of 'human' | 'ai' | 'tool'
    (the comment in `schema.ts` saying "user"/"assistant" is stale).
    """

    __tablename__ = "chat_history"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int | None] = mapped_column(Integer)
    role: Mapped[str] = mapped_column(Text, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(), nullable=False, server_default=_NOW)


# ─── Knowledge graph ─────────────────────────────────────────────────────────


class GraphNode(Base):
    __tablename__ = "graph_nodes"
    __table_args__ = (UniqueConstraint("key", name="graph_nodes_key_unique"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    normalized_name: Mapped[str] = mapped_column(Text, nullable=False)
    aliases: Mapped[list[str]] = mapped_column(
        ARRAY(Text), nullable=False, server_default=text("'{}'::text[]")
    )
    # `metadata` is reserved on a declarative class, so the attribute is renamed
    # while the column keeps its real name.
    meta: Mapped[dict[str, Any]] = mapped_column(
        "metadata", JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )

    # Memory-node attributes: populated when kind = 'memory', NULL for entity nodes.
    key: Mapped[str | None] = mapped_column(Text)
    value: Mapped[str | None] = mapped_column(Text)
    classification: Mapped[str | None] = mapped_column(memory_classification)
    tier: Mapped[str | None] = mapped_column(memory_tier)
    importance: Mapped[float] = mapped_column(REAL, nullable=False, server_default=text("0.2"))
    vector: Mapped[Any | None] = mapped_column(Vector(EMBEDDING_DIMENSIONS))

    # Learning / healing bookkeeping.
    recall_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    last_recalled_at: Mapped[dt.datetime | None] = mapped_column(DateTime())
    #: active | superseded | archived
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'active'"))
    #: Provenance, e.g. 'chat:session:12' | 'agent' | 'manual' | 'cron'.
    source: Mapped[str | None] = mapped_column(Text)
    confidence: Mapped[float] = mapped_column(REAL, nullable=False, server_default=text("1"))
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(), nullable=False, server_default=_NOW)
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime(), nullable=False, server_default=_NOW)


class GraphEdge(Base):
    __tablename__ = "graph_edges"
    __table_args__ = (
        UniqueConstraint("from_node_id", "to_node_id", "relation", name="graph_edges_unique"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # No foreign keys here — the real schema has none.
    from_node_id: Mapped[int] = mapped_column(Integer, nullable=False)
    to_node_id: Mapped[int] = mapped_column(Integer, nullable=False)
    relation: Mapped[str] = mapped_column(Text, nullable=False)
    weight: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("1"))
    confidence: Mapped[float] = mapped_column(REAL, nullable=False, server_default=text("1"))
    #: user | agent | inference
    created_by: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'user'"))
    evidence: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(), nullable=False, server_default=_NOW)


# ─── Connections ─────────────────────────────────────────────────────────────


class Connection(Base):
    """A third-party integration and its credentials.

    `access_token` doubles as the API-key column for providers that use key auth
    rather than OAuth (ClickUp). Tokens are stored in plaintext, as in the
    TypeScript implementation.
    """

    __tablename__ = "connections"
    __table_args__ = (UniqueConstraint("name", name="connections_name_unique"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    oauth_connected: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    access_token: Mapped[str | None] = mapped_column(Text)
    refresh_token: Mapped[str | None] = mapped_column(Text)
    token_expiry: Mapped[dt.datetime | None] = mapped_column(DateTime())
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(), nullable=False, server_default=_NOW)
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime(), nullable=False, server_default=_NOW)


# ─── Workflows ───────────────────────────────────────────────────────────────


class Workflow(Base):
    __tablename__ = "workflows"
    __table_args__ = (
        # Partial index backing the scheduler's "what is due" query. The predicate
        # text is written exactly as Postgres stores it (verified against
        # `pg_indexes.indexdef`), so a generated migration reproduces it verbatim.
        Index("workflow_due", "next_run_at", postgresql_where=text("enabled = true")),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    plan: Mapped[str] = mapped_column(Text, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    active_revision: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    #: manual | active | paused
    lifecycle: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'manual'"))
    # Timezone-aware: added by migration 0006.
    next_run_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    # Naive: created by migration 0002.
    last_run_at: Mapped[dt.datetime | None] = mapped_column(DateTime())
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(), nullable=False, server_default=_NOW)
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime(), nullable=False, server_default=_NOW)


class WorkflowRevision(Base):
    """An immutable snapshot of a workflow definition. Each run freezes one."""

    __tablename__ = "workflow_revisions"
    __table_args__ = (
        UniqueConstraint(
            "workflow_id", "version", name="workflow_revisions_workflow_id_version_unique"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    workflow_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey(
            "workflows.id",
            ondelete="CASCADE",
            name="workflow_revisions_workflow_id_workflows_id_fk",
        ),
        nullable=False,
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    definition: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=_NOW
    )


class WorkflowRun(Base):
    __tablename__ = "workflow_runs"
    __table_args__ = (
        # One run per workflow per scheduled instant: the latch that makes
        # `ON CONFLICT DO NOTHING` enqueueing idempotent across workers.
        Index("workflow_occurrence", "workflow_id", "scheduled_for", unique=True),
        # At most one live run per workflow. A concurrency primitive, not an
        # optimisation — `claimRun` relies on it.
        Index(
            "workflow_one_active",
            "workflow_id",
            unique=True,
            postgresql_where=text("status = ANY (ARRAY['queued'::text, 'running'::text])"),
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    workflow_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey(
            "workflows.id", ondelete="CASCADE", name="workflow_runs_workflow_id_workflows_id_fk"
        ),
        nullable=False,
    )
    revision_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey(
            "workflow_revisions.id", name="workflow_runs_revision_id_workflow_revisions_id_fk"
        ),
    )
    #: queued | running | completed | failed | cancelled | needs_attention
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'running'"))
    #: manual | schedule
    trigger: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'manual'"))
    output: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)
    # Naive: created by migration 0002.
    ran_at: Mapped[dt.datetime] = mapped_column(DateTime(), nullable=False, server_default=_NOW)
    # Timezone-aware: added by migration 0006.
    scheduled_for: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    lease_owner: Mapped[str | None] = mapped_column(Text)
    heartbeat_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    cancel_requested: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    feedback: Mapped[str | None] = mapped_column(Text)
    learned: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))


class WorkflowStep(Base):
    """Per-step checkpoint, keyed by (run, step). Drives resume after a lost lease."""

    __tablename__ = "workflow_steps"
    __table_args__ = (
        PrimaryKeyConstraint("run_id", "step_id", name="workflow_steps_run_id_step_id_pk"),
    )

    run_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey(
            "workflow_runs.id", ondelete="CASCADE", name="workflow_steps_run_id_workflow_runs_id_fk"
        ),
        nullable=False,
    )
    step_id: Mapped[str] = mapped_column(Text, nullable=False)
    #: pending | running | completed | failed
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'pending'"))
    output: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))


class WorkflowEvent(Base):
    """Append-only run event log; the source for the run-events SSE stream."""

    __tablename__ = "workflow_events"
    __table_args__ = (Index("workflow_events_run", "run_id", "id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey(
            "workflow_runs.id",
            ondelete="CASCADE",
            name="workflow_events_run_id_workflow_runs_id_fk",
        ),
        nullable=False,
    )
    event: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=_NOW
    )


class WorkflowAction(Base):
    """Write-idempotency ledger.

    One row per logical external write, fingerprinted over the tool name and its
    target arguments. A `started` row with no `completed` row is an unknown outcome:
    recovery marks the run `needs_attention` rather than repeating the write.
    """

    __tablename__ = "workflow_actions"
    __table_args__ = (
        UniqueConstraint(
            "run_id",
            "step_id",
            "fingerprint",
            name="workflow_actions_run_id_step_id_fingerprint_unique",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey(
            "workflow_runs.id",
            ondelete="CASCADE",
            name="workflow_actions_run_id_workflow_runs_id_fk",
        ),
        nullable=False,
    )
    step_id: Mapped[str] = mapped_column(Text, nullable=False)
    tool: Mapped[str] = mapped_column(Text, nullable=False)
    #: sha256 over [tool name, sorted target arguments]
    fingerprint: Mapped[str] = mapped_column(Text, nullable=False)
    #: started | completed
    status: Mapped[str] = mapped_column(Text, nullable=False)
    output: Mapped[dict[str, Any] | None] = mapped_column(JSONB)


class WorkflowLesson(Base):
    __tablename__ = "workflow_lessons"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    workflow_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey(
            "workflows.id", ondelete="CASCADE", name="workflow_lessons_workflow_id_workflows_id_fk"
        ),
        nullable=False,
    )
    run_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey(
            "workflow_runs.id",
            ondelete="SET NULL",
            name="workflow_lessons_run_id_workflow_runs_id_fk",
        ),
    )
    lesson: Mapped[str] = mapped_column(Text, nullable=False)
    confidence: Mapped[float] = mapped_column(REAL, nullable=False, server_default=text("0.5"))
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=_NOW
    )


class WorkflowProposal(Base):
    """A suggested definition change. Never auto-activated; requires review."""

    __tablename__ = "workflow_proposals"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    workflow_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey(
            "workflows.id",
            ondelete="CASCADE",
            name="workflow_proposals_workflow_id_workflows_id_fk",
        ),
        nullable=False,
    )
    run_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey(
            "workflow_runs.id",
            ondelete="SET NULL",
            name="workflow_proposals_run_id_workflow_runs_id_fk",
        ),
    )
    base_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    definition: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    #: pending | accepted | rejected
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'pending'"))
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=_NOW
    )


class WorkflowWorker(Base):
    """Heartbeat row per worker process. `/workflows/health` counts the fresh ones."""

    __tablename__ = "workflow_workers"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    heartbeat_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=_NOW
    )
