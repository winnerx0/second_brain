# Second Brain

A daily briefing agent powered by a LangChain planning agent that dynamically delegates to GitHub, Google Calendar, Notion, and memory tools, delivered via Telegram.

## Features

- 🤖 **AI-Powered Agent**: Uses LangChain with dynamic tool selection
- 🔗 **OAuth Integration**: Secure OAuth authentication for GitHub and Notion
- 📊 **Multiple Data Sources**: GitHub, Google Calendar, Notion, AniList, and more
- 💬 **Chat Interface**: Web-based streaming chat with real-time responses
- 🧠 **Memory System**: Persistent memory with classification and importance scoring
- 📱 **Telegram Delivery**: Daily briefings delivered to Telegram
- 🔌 **MCP Support**: Model Context Protocol integration for Notion

## Architecture

```
User/Cron → Hono → Planning Agent (createAgent) → Tools → Response → Telegram
                         │
                         ├── GitHub (open PRs, assigned issues, recent pushes) [OAuth]
                         ├── Notion (pages, databases, blocks) [OAuth + MCP]
                         ├── Google Calendar (today's events)
                         └── Memory (store/recall from Postgres)
```

## Setup

### 1. Install dependencies

```bash
bun install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in `.env`:

| Variable              | Description                                                      |
| --------------------- | ---------------------------------------------------------------- |
| `OPENROUTER_API_KEY`  | OpenRouter API key                                               |
| `OPENROUTER_MODEL`    | OpenRouter model ID (e.g. `openai/gpt-5`)                        |
| `OPENROUTER_BASE_URL` | OpenRouter API base URL (default `https://openrouter.ai/api/v1`) |
| `OPENAI_API_KEY`      | OpenAI API key used for embeddings                               |
| `EMBEDDING_MODEL`     | Embedding model ID (default `text-embedding-3-small`)            |
| `GITHUB_TOKEN`        | GitHub personal access token (fallback if OAuth not used)        |
| `GITHUB_USERNAME`     | Your GitHub username                                             |
| `GOOGLE_CALENDAR_ID`  | Google Calendar ID (e.g. `primary`)                              |
| `GOOGLE_CREDENTIALS`  | Service account JSON string                                      |
| `TELEGRAM_BOT_TOKEN`  | Telegram bot token from @BotFather                               |
| `TELEGRAM_CHAT_ID`    | Your Telegram chat ID                                            |
| `DATABASE_URL`        | Postgres connection string                                       |
| `NOTION_TOKEN`        | Notion integration token (fallback if OAuth not used)            |

**OAuth Configuration (Optional but Recommended):**

| Variable                      | Description                                    |
| ----------------------------- | ---------------------------------------------- |
| `OAUTH_REDIRECT_BASE_URL`     | OAuth callback base URL (e.g. `http://localhost:3000`) |
| `APP_URL`                     | Web app URL (e.g. `http://localhost:5173`)    |
| `GITHUB_OAUTH_CLIENT_ID`      | GitHub OAuth app client ID                     |
| `GITHUB_OAUTH_CLIENT_SECRET`  | GitHub OAuth app client secret                 |
| `NOTION_OAUTH_CLIENT_ID`      | Notion OAuth integration client ID             |
| `NOTION_OAUTH_CLIENT_SECRET`  | Notion OAuth integration client secret         |

**For detailed OAuth setup instructions, see [OAUTH_SETUP.md](./OAUTH_SETUP.md)**

**Encode service account JSON:**

```bash
base64 -w 0 service-account.json
```

### 3. Run database migrations

```bash
bun run db:generate
bun run db:migrate
```

### 4. Start the server

```bash
bun run dev     # development (watch mode)
bun run start   # production
```

Server starts on port **3000**.

### 5. Start the web app

The browser UI lives in `web/` and connects to the streaming chat API on the backend.

```bash
bun run web:dev
```

The web app runs on port **3001**.

## API

### `GET /health`

```json
{ "status": "ok", "timestamp": 1712000000000 }
```

### `POST /cron`

Triggers the daily briefing. Fetches GitHub + Calendar data, generates a summary via the planning agent, stores it in the DB, and sends it to Telegram.

```bash
curl -X POST http://localhost:3000/cron
```

### `POST /chat`

Ad-hoc question routing — the agent decides which tools to call.

```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "what commits did I make today?"}'
```

### `POST /chat/stream`

Streaming chat endpoint for the browser UI. It returns SSE events for status, tool start/end, assistant token deltas, and the final response.

```bash
curl -N -X POST http://localhost:3000/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"text": "what am I working on right now?"}'
```

## Database

Multiple tables managed by Drizzle ORM:

- **`agent_runs`** — log of each briefing run
- **`task_history`** — GitHub issues/PRs tracked over time
- **`memories`** — agent memory store (preferences, patterns, facts)
- **`connections`** — OAuth connections and their status
- **`chat_sessions`** — chat session history
- **`chat_history`** — individual chat messages
- **`graph_nodes`** — knowledge graph nodes
- **`graph_edges`** — knowledge graph relationships

```bash
bun run db:studio   # open Drizzle Studio
```

## OAuth Connections

The agent supports OAuth authentication for enhanced security and user-specific access:

- **GitHub**: Manage repositories, issues, and PRs with your GitHub account
- **Notion**: Access your Notion workspace via OAuth (used by MCP)

### Quick Start

1. Set up OAuth apps (see [OAUTH_SETUP.md](./OAUTH_SETUP.md))
2. Add OAuth credentials to `.env`
3. Start the web app and navigate to `/connections`
4. Click "Connect" for GitHub or Notion
5. Authorize the application

The agent will automatically use OAuth tokens when available, falling back to environment variable tokens if not connected.

## Available Tools

The agent has access to the following tools:

- **GitHub**: `get_open_prs`, `get_assigned_issues`, `get_recent_pushes`, `create_issue`, `close_issue`, `delete_issue`
- **Notion**: Full workspace access via MCP (search, read, create, update pages, databases, blocks)
- **Google Calendar**: View and manage calendar events
- **Gmail**: Read and send emails
- **Memory**: Store and recall information with importance scoring
- **Knowledge Graph**: Build and query a knowledge graph of entities and relationships
- **AniList**: Track anime and manga
- **Miscellaneous**: Get current date/time, perform calculations

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
