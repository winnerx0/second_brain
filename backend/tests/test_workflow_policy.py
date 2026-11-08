from __future__ import annotations

import pytest

from app.workflows.policy import fingerprint

#: (tool, args) -> sha256 hex, captured from known-good runs.
NODE_DIGESTS = [
    (
        "send_email",
        {"to": "alice@example.com", "body": "Hello"},
        "0cab6d940b50dcf6f171b9c27d457e212d64fed863c48f0dd54c974ebba85b80",
    ),
    (
        "create_issue",
        {"owner": "org", "repo": "repo", "title": "Bug", "body": "x"},
        "c754f749b475e84b0a3d94c77fb92bae530a1589ca15aa80d0ea8ca0ef07da70",
    ),
    (
        "send_telegram_message",
        {},
        "6695fb77dc2ff6f5d56e5a31fb9d11eb6a789a77775ff9680939e12899b45132",
    ),
    (
        "merge_pull_request",
        {"owner": "o", "repo": "r", "pullNumber": 7},
        "3f0329fdc6d71752b1a210845840134329c09bc2b1f851a0ba5941f228b8832d",
    ),
    (
        "close_issue",
        {"owner": "o", "repo": "r", "issueNumber": 3, "listIds": ["a", "b"]},
        "324e2ecdfd5cbc7cbb14bf7d549b12519feddb463f59a2c9f0134883fbf9a3d0",
    ),
    (
        "set_flag",
        {"value": True, "taskId": "t1"},
        "d439dbe05f6c708214438785ea322ce8f36bdc37f46e0f4e79030fc37323e775",
    ),
]


@pytest.mark.parametrize(("tool", "args", "digest"), NODE_DIGESTS)
def test_fingerprint_matches_node(tool: str, args: dict, digest: str) -> None:
    assert fingerprint(tool, args) == digest


def test_content_arguments_do_not_change_the_fingerprint() -> None:
    """Re-sending the same message to the same recipient is the same write."""
    first = fingerprint("send_email", {"to": "a@x.com", "body": "one"})
    second = fingerprint("send_email", {"to": "a@x.com", "body": "two"})
    assert first == second


def test_target_arguments_do_change_the_fingerprint() -> None:
    """A different recipient is a different write and must not be deduplicated."""
    assert fingerprint("send_email", {"to": "a@x.com"}) != fingerprint(
        "send_email", {"to": "b@x.com"}
    )


def test_argument_order_does_not_matter() -> None:
    """Entries are sorted, so the model's key order cannot split the ledger."""
    assert fingerprint("create_issue", {"owner": "o", "repo": "r"}) == fingerprint(
        "create_issue", {"repo": "r", "owner": "o"}
    )


def test_tool_name_is_part_of_the_fingerprint() -> None:
    assert fingerprint("close_issue", {"owner": "o"}) != fingerprint("delete_issue", {"owner": "o"})
