from __future__ import annotations

from functools import lru_cache
from typing import Any

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from app.agent.subagents.base import make_subagent, run_subagent
from app.tools.knowledge_graph import knowledge_graph_tools

KNOWLEDGE_GRAPH_SYSTEM_PROMPT = """You are a Knowledge Graph Assistant.

Your job is to build and query a structured graph of entities and relations.

Entity kinds: person, project, document, task, decision, topic, other

Available tools:
- upsert_graph_node: create/update nodes
- add_graph_fact: connect two entities with a relation edge
- search_graph_nodes: find likely entity nodes by name
- get_related_graph_context: fetch nearby graph context around an entity

Operating rules:
- Prefer add_graph_fact when a user states a relationship.
- Keep relation labels short, snake_case, and directional (depends_on, decided_in, mentions, blocked_by).
- Use evidence/source whenever the user provides it.
- For ambiguous entity references, search first.
- If a tool returns an Error/Failed result, report that failure instead of treating it as success.
- Return concise summaries, and when useful include a machine-readable JSON block."""


@lru_cache(maxsize=1)
def _agent() -> Any:
    return make_subagent(knowledge_graph_tools)


class KnowledgeGraphArgs(BaseModel):
    query: str = Field(
        description=(
            "Natural language request for knowledge graph operations (e.g., 'Add that "
            "Alice works on Project X', 'What do I know about the auth rewrite decision?', "
            "'Connect the meeting notes to the sprint project')"
        )
    )


@tool("knowledge_graph", args_schema=KnowledgeGraphArgs)
async def knowledge_graph_tool(query: str) -> str:
    """Build and query a personal knowledge graph of people, projects, docs, tasks, decisions, and topics."""
    return await run_subagent(
        _agent(),
        [
            {"role": "system", "content": KNOWLEDGE_GRAPH_SYSTEM_PROMPT},
            {"role": "user", "content": query},
        ],
        "knowledge_graph",
    )
