from __future__ import annotations

import json

import httpx
import pytest

from app.tools.tavily import tavily_search


@pytest.fixture
def tavily_api(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    """Capture request bodies and return a canned Tavily response."""
    sent: list[dict] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        assert request.headers["authorization"] == "Bearer test-placeholder"
        return httpx.Response(
            200,
            json={
                "query": "react release",
                "answer": "React 19 is out.",
                "results": [
                    {
                        "title": "Release notes",
                        "url": "https://example.com",
                        "content": "summary",
                        "raw_content": None,
                        "score": 0.9,
                        "published_date": "2026-01-01",
                    }
                ],
                "response_time": 1.5,
                "usage": {"credits": 2},
                "request_id": "req-1",
            },
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.tools.tavily.get_client", lambda: client)
    return sent


async def test_response_is_rekeyed_to_camel_case(tavily_api: list[dict]) -> None:
    result = json.loads(await tavily_search.ainvoke({"query": "react release"}))
    assert result == {
        "query": "react release",
        "answer": "React 19 is out.",
        "results": [
            {
                "title": "Release notes",
                "url": "https://example.com",
                "content": "summary",
                "rawContent": None,
                "score": 0.9,
                "publishedDate": "2026-01-01",
            }
        ],
        "responseTime": 1.5,
        "creditsUsed": 2,
        "requestId": "req-1",
    }


async def test_default_request_body(tavily_api: list[dict]) -> None:
    await tavily_search.ainvoke({"query": "q"})
    assert tavily_api[0] == {
        "query": "q",
        "search_depth": "basic",
        "topic": "general",
        "max_results": 5,
        "include_answer": "basic",
        "include_usage": True,
        "include_favicon": True,
    }


async def test_optional_filters_are_omitted_when_unset(tavily_api: list[dict]) -> None:
    """Absent keys must stay absent from the request body."""
    await tavily_search.ainvoke({"query": "q", "time_range": "week", "include_domains": ["a.com"]})
    body = tavily_api[0]
    assert body["time_range"] == "week"
    assert body["include_domains"] == ["a.com"]
    assert "exclude_domains" not in body

    await tavily_search.ainvoke({"query": "q", "include_domains": []})
    assert "include_domains" not in tavily_api[1], "an empty list is omitted, not sent"


async def test_http_error_is_reported_as_text(monkeypatch: pytest.MonkeyPatch) -> None:
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, text="rate limited")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.tools.tavily.get_client", lambda: client)

    result = await tavily_search.ainvoke({"query": "q"})
    assert result == "Tavily search failed (429): rate limited"


async def test_missing_api_key_is_reported(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TAVILY_API_KEY", "")
    from app.config import get_settings

    get_settings.cache_clear()
    result = await tavily_search.ainvoke({"query": "q"})
    assert result.startswith("Tavily web search is not configured.")


async def test_subagent_streams_prefixed_tool_events(
    monkeypatch: pytest.MonkeyPatch, tavily_api: list[dict]
) -> None:
    """The specialist reports inner tools as 'tavily:<tool>' to the caller's sink."""
    from langchain.agents import create_agent
    from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
    from langchain_core.messages import AIMessage

    from app.agent.context import StreamContext, subagent_stream_context
    from app.agent.subagents import tavily as tavily_subagent

    class _Scripted(GenericFakeChatModel):
        def bind_tools(self, tools, **kwargs):
            return self

    model = _Scripted(
        messages=iter(
            [
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "tavily_search",
                            "args": {"query": "react release"},
                            "id": "c1",
                            "type": "tool_call",
                        }
                    ],
                ),
                AIMessage(content="React 19 is out. Source: https://example.com"),
            ]
        )
    )
    agent = create_agent(model, tools=list(tavily_subagent.tavily_tools))
    monkeypatch.setattr(tavily_subagent, "_agent", lambda: agent)

    events: list[dict] = []

    async def sink(event: dict) -> None:
        events.append(event)

    with subagent_stream_context(StreamContext(on_event=sink)):
        answer = await tavily_subagent.tavily_tool.ainvoke({"query": "react release"})

    assert answer == "React 19 is out. Source: https://example.com"
    assert [e["tool"] for e in events] == ["tavily:tavily_search", "tavily:tavily_search"]
    assert [e["type"] for e in events] == ["tool_start", "tool_end"]
