# Second Brain

A daily briefing agent powered by a LangChain planning agent that dynamically delegates to GitHub, Google Calendar, and memory tools, delivered via Telegram.

## Architecture

```
User/Cron → Hono → Planning Agent (createAgent) → Tools → Response → Telegram
                         │
                         ├── GitHub (open PRs, assigned issues, recent pushes)
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

| Variable | Description |
|---|---|
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `OPENROUTER_MODEL` | OpenRouter model ID (e.g. `openai/gpt-5`) |
| `OPENROUTER_BASE_URL` | OpenRouter API base URL (default `https://openrouter.ai/api/v1`) |
| `OPENAI_API_KEY` | OpenAI API key used for embeddings |
| `EMBEDDING_MODEL` | Embedding model ID (default `text-embedding-3-small`) |
| `GITHUB_TOKEN` | GitHub personal access token |
| `GITHUB_USERNAME` | Your GitHub username |
| `GOOGLE_CALENDAR_ID` | Google Calendar ID (e.g. `primary`) |
| `GOOGLE_CREDENTIALS` | Service account JSON string |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID |
| `DATABASE_URL` | Postgres connection string |

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

## Database

Three tables managed by Drizzle ORM:

- **`agent_runs`** — log of each briefing run
- **`task_history`** — GitHub issues/PRs tracked over time
- **`memories`** — agent memory store (preferences, patterns, facts)

```bash
bun run db:studio   # open Drizzle Studio
```
