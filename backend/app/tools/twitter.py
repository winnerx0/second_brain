from __future__ import annotations

from typing import Any

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from app.http import get_client
from app.json import dumps
from app.logging import get_logger
from app.oauth import get_valid_token

logger = get_logger("twitter")

TWITTER_API_URL = "https://api.twitter.com/2"
USER_FIELDS = "id,name,username,description,created_at,public_metrics,verified"
TWEET_FIELDS = "id,text,created_at,public_metrics,conversation_id,referenced_tweets,author_id"


async def _token() -> str:
    token = await get_valid_token("twitter")
    if not token:
        raise RuntimeError("Twitter/X is not connected. Please connect Twitter/X in Connections first.")
    return token


async def _twitter_fetch(
    path: str, method: str = "GET", body: Any = None, query: dict[str, Any] | None = None
) -> Any:
    token = await _token()
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"

    params = {k: v for k, v in (query or {}).items() if v is not None}
    response = await get_client().request(
        method, f"{TWITTER_API_URL}{path}", params=params, headers=headers, json=body
    )
    if response.status_code == 204:
        return None

    text = response.text
    data = response.json() if text else None

    if response.is_error:
        raise RuntimeError(f"Twitter/X API request failed ({response.status_code}): {text}")

    return data


@tool("twitter_get_me")
async def get_twitter_me() -> str:
    """Get the authenticated Twitter/X user profile."""
    try:
        data = await _twitter_fetch("/users/me", query={"user.fields": USER_FIELDS})
        return dumps(data)
    except Exception as exc:
        logger.error("[twitter] getTwitterMe", exc_info=exc)
        return f"Error fetching Twitter/X profile: {exc}"


class GetTwitterUserByUsernameArgs(BaseModel):
    username: str = Field(description="Twitter/X username, with or without @")


@tool("twitter_get_user_by_username", args_schema=GetTwitterUserByUsernameArgs)
async def get_twitter_user_by_username(username: str) -> str:
    """Get a Twitter/X user profile by username."""
    try:
        clean_username = username.lstrip("@")
        data = await _twitter_fetch(
            f"/users/by/username/{clean_username}", query={"user.fields": USER_FIELDS}
        )
        return dumps(data)
    except Exception as exc:
        logger.error("[twitter] getTwitterUserByUsername", exc_info=exc)
        return f"Error fetching Twitter/X user: {exc}"


class GetTwitterUserTweetsArgs(BaseModel):
    userId: str = Field(description="Twitter/X user ID")
    maxResults: int | None = Field(default=None, description="Number of posts to fetch")


@tool("twitter_get_user_tweets", args_schema=GetTwitterUserTweetsArgs)
async def get_twitter_user_tweets(userId: str, maxResults: int | None = None) -> str:
    """Get recent posts from a Twitter/X user by user ID."""
    try:
        data = await _twitter_fetch(
            f"/users/{userId}/tweets",
            query={
                "max_results": maxResults or 10,
                "tweet.fields": TWEET_FIELDS,
                "expansions": "author_id",
                "user.fields": USER_FIELDS,
            },
        )
        return dumps(data)
    except Exception as exc:
        logger.error("[twitter] getTwitterUserTweets", exc_info=exc)
        return f"Error fetching Twitter/X posts: {exc}"


class SearchRecentTweetsArgs(BaseModel):
    query: str = Field(description="Twitter/X recent search query")
    maxResults: int | None = Field(default=None, description="Number of posts to fetch")


@tool("twitter_search_recent_tweets", args_schema=SearchRecentTweetsArgs)
async def search_recent_tweets(query: str, maxResults: int | None = None) -> str:
    """Search recent Twitter/X posts."""
    try:
        data = await _twitter_fetch(
            "/tweets/search/recent",
            query={
                "query": query,
                "max_results": maxResults or 10,
                "tweet.fields": TWEET_FIELDS,
                "expansions": "author_id",
                "user.fields": USER_FIELDS,
            },
        )
        return dumps(data)
    except Exception as exc:
        logger.error("[twitter] searchRecentTweets", exc_info=exc)
        return f"Error searching Twitter/X posts: {exc}"


class GetTwitterMentionsArgs(BaseModel):
    userId: str = Field(description="Twitter/X user ID")
    maxResults: int | None = Field(default=None, description="Number of mentions to fetch")


@tool("twitter_get_mentions", args_schema=GetTwitterMentionsArgs)
async def get_twitter_mentions(userId: str, maxResults: int | None = None) -> str:
    """Get recent mentions for a Twitter/X user by user ID."""
    try:
        data = await _twitter_fetch(
            f"/users/{userId}/mentions",
            query={
                "max_results": maxResults or 10,
                "tweet.fields": TWEET_FIELDS,
                "expansions": "author_id",
                "user.fields": USER_FIELDS,
            },
        )
        return dumps(data)
    except Exception as exc:
        logger.error("[twitter] getTwitterMentions", exc_info=exc)
        return f"Error fetching Twitter/X mentions: {exc}"


class CreateTweetArgs(BaseModel):
    text: str = Field(description="Post text")
    replyToTweetId: str | None = Field(default=None, description="Tweet ID to reply to, if creating a reply")


@tool("twitter_create_tweet", args_schema=CreateTweetArgs)
async def create_tweet(text: str, replyToTweetId: str | None = None) -> str:
    """Create a Twitter/X post or reply as the authenticated user."""
    try:
        body: dict[str, Any] = {"text": text}
        if replyToTweetId:
            body["reply"] = {"in_reply_to_tweet_id": replyToTweetId}
        data = await _twitter_fetch("/tweets", method="POST", body=body)
        return dumps(data)
    except Exception as exc:
        logger.error("[twitter] createTweet", exc_info=exc)
        return f"Error creating Twitter/X post: {exc}"


class DeleteTweetArgs(BaseModel):
    tweetId: str = Field(description="Tweet ID to delete")


@tool("twitter_delete_tweet", args_schema=DeleteTweetArgs)
async def delete_tweet(tweetId: str) -> str:
    """Delete one of the authenticated user Twitter/X posts by ID."""
    try:
        data = await _twitter_fetch(f"/tweets/{tweetId}", method="DELETE")
        return dumps(data)
    except Exception as exc:
        logger.error("[twitter] deleteTweet", exc_info=exc)
        return f"Error deleting Twitter/X post: {exc}"


twitter_tools = [
    get_twitter_me,
    get_twitter_user_by_username,
    get_twitter_user_tweets,
    search_recent_tweets,
    get_twitter_mentions,
    create_tweet,
    delete_tweet,
]
