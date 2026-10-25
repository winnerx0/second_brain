"""Specialist name -> the agent tool that runs it. Port of `src/workflows/registry.ts`.

`app/workflows/engine.py` looks a step's specialist up here to execute it. The two
specialists with no entry are handled directly by the engine: `synthesis` calls the
model with no tools, and `telegram` sends through the idempotent delivery path.
"""

from __future__ import annotations

from langchain_core.tools import BaseTool

from app.agent.subagents.tavily import tavily_tool

#: Add an entry as each specialist lands; `app/workflows/catalog.py` tracks the gap.
SPECIALISTS: dict[str, BaseTool] = {
    "web_search": tavily_tool,
}
