# CodexBridge

[中文版本](README.zh-CN.md)

CodexBridge wraps the official Codex CLI/SDK and exposes it as an OpenAI-compatible `/v1/chat/completions` endpoint. It also ships with a tiny CLI so you can talk to Codex locally. Any OpenAI-style client (OpenWebUI, Cherry Studio, curl, etc.) can treat CodexBridge as a drop-in model.

## Highlights

- **OpenAI-compatible API** – `/v1/chat/completions` (sync + SSE) plus `/v1/models`.
- **Persistent sessions** – Use `session_id` / `conversation_id` / `thread_id` / `user` to keep Codex context; omit them for ephemeral runs.
- **Multimodal input** – Accepts `image_url` and `local_image` blocks (HTTP(S), `file://`, `data:` URIs, local paths) and automatically converts them to Codex `local_image`.
- **Structured output** – Maps OpenAI `response_format` / `output_schema` to Codex `outputSchema` so the agent must return JSON that matches your schema.
- **Configurable sandbox** – Environment variables control filesystem access, working directory, networking, web search, and approval policy.
- **Self-hosted storage** – Codex sessions live in `~/.codex/sessions`; bridge mappings stay in `.codex_threads.json`.

## Requirements

- Node.js 18+
- Codex CLI installed and authenticated on the same machine
- npm (or adapt scripts for pnpm / yarn)

## Installation

```bash
git clone https://github.com/begonia599/CodexBridge
cd codexbridge
npm install
cp .env.example .env
cp .env .env.local   # optional custom config
```

Edit `.env` / `.env.local` before exposing the service (API key, sandbox mode, working directory, etc.).

## CLI chat

```bash
npm run codex:chat
```

- Type natural language commands; Codex replies inline.
- `/reset` starts a new Codex thread.
- `/exit` leaves the REPL.

Thread IDs are cached in `.codex_thread.json`, so you can close the CLI and continue later.

## HTTP bridge

```bash
npm run codex:server
```

- Default port: `8080` (`PORT` overrides)
- Health check: `GET /health`
- Session map: `.codex_threads.json` (delete to reset bridge-managed sessions)

### Basic request

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "content-type: application/json" \
  -H "authorization: Bearer 123321" \
  -d '{"model":"gpt-5-codex:medium","session_id":"demo","messages":[{"role":"user","content":"ls"}]}'
```

### Session IDs & persistence

- In production/front-end setups enable `CODEX_REQUIRE_SESSION_ID=true` so every request must include a session identifier.
- IDs can be supplied in the JSON body (`session_id` / `conversation_id` / `thread_id` / `user`) or via headers (`x-session-id`, `session-id`, `x-conversation-id`, `x-thread-id`, `x-user-id`).
- IDs must be non-empty strings (UUID, user ID, chat ID, etc.). Avoid numeric-only or nested objects.
- If all identifiers are omitted and `CODEX_REQUIRE_SESSION_ID` is `false`, CodexBridge flattens the entire `messages` history into `[ROLE]` blocks and sends it as a one-off prompt.

### Streaming

```bash
curl -N http://localhost:8080/v1/chat/completions \
  -H "content-type: application/json" \
  -H "authorization: Bearer 123321" \
  -d '{"model":"gpt-5-codex:high","session_id":"stream","stream":true,"messages":[{"role":"user","content":"Explain how to run npm init step by step."}]}'
```

Response is SSE (`data: {...}`) ending with `data: [DONE]`.

### Multimodal input

The bridge understands OpenAI-style content arrays. Examples:

- `{"type":"image_url","image_url":{"url":"https://example.com/demo.png"}}`
- `{"type":"local_image","path":"./images/demo.png"}`

Remote URLs and data URIs are downloaded to a temp folder, converted to Codex `local_image`, then cleaned up after the turn.

### Structured JSON output

CodexBridge forwards OpenAI `response_format` to Codex `outputSchema`:

```json
{
  "model": "gpt-5-codex",
  "session_id": "lint",
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "lint_report",
      "schema": {
        "type": "object",
        "properties": {
          "summary": { "type": "string" },
          "status": { "type": "string", "enum": ["ok", "action_required"] }
        },
        "required": ["summary", "status"],
        "additionalProperties": false
      }
    }
  },
  "messages": [
    { "role": "user", "content": "Check src/ for lint problems and return JSON following the schema." }
  ]
}
```

`type: "json_schema"` must include a `schema`. Missing or invalid schemas trigger HTTP 400.

### Networking & search

- `CODEX_NETWORK_ACCESS=true` allows Codex to run networked commands (`curl`, `git clone`, API calls).
- `CODEX_WEB_SEARCH=true` lets Codex use its built-in web search tool.

Both default to `false`.

## Source deployment

```bash
cp .env.example .env
npm run codex:server
```

Keep the process running via `pm2`, `systemd`, `forever`, or any other supervisor. If you need HTTPS, front the service with Nginx/Caddy pointing to `localhost:8080`. You can run `npm run codex:chat` alongside the server for CLI interaction.

### Dashboard prototype

Visit `http://<host>:8080/dashboard` to see the placeholder dashboard (served from `public/dashboard.html`). The page currently loads mock content; once token parsing is wired up you can populate it with real account metadata and session stats.

### One-command setup for Linux

```bash
curl -fsSL https://raw.githubusercontent.com/begonia599/CodexBridge/master/scripts/install.sh | bash
```

The script:
1. Installs git, Node.js, Docker, and Docker Compose if missing.
2. Clones/pulls the repo to `~/codexbridge` (override via `CODEXBRIDGE_DIR` env var).
3. Copies `.env.example` → `.env` (edit afterward).
4. Runs `docker compose up -d --build`.

> Requires sudo privileges to install system packages and Docker.

## Docker

### Docker Compose

```bash
docker compose up -d
docker compose logs -f codexbridge
```

> Compose mounts Codex data under `./codex-data` (auto-created). Delete that directory to reset Codex threads. Use `docker-compose` instead if you rely on the legacy command.

### Docker CLI

```bash
docker build -t codexbridge .

docker run --rm -p 8080:8080 \
  --env-file .env \
  -v "%cd%":/workspace \
  -v "%LOCALAPPDATA%\Codex":/root/.codex \
  -w /workspace \
  codexbridge
```

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `CODEX_MODEL` | `gpt-5-codex` | Default model |
| `CODEX_REASONING` | `medium` | Default reasoning effort (`low` / `medium` / `high`) |
| `CODEX_BRIDGE_API_KEY` | `123321` | API key for `Authorization: Bearer` / `x-api-key` |
| `CODEX_SKIP_GIT_CHECK` | `true` | Skip Codex “trusted Git repo” requirement |
| `CODEX_SANDBOX_MODE` | `read-only` | `read-only` / `workspace-write` / `danger-full-access` |
| `CODEX_WORKDIR` | empty | Force Codex threads to run inside this directory |
| `CODEX_NETWORK_ACCESS` | `false` | Allow networked commands |
| `CODEX_WEB_SEARCH` | `false` | Allow built-in web search |
| `CODEX_APPROVAL_POLICY` | `never` | `never` / `on-request` / `on-failure` / `untrusted` |
| `CODEX_LOG_REQUESTS` | `false` | Log incoming payloads |
| `CODEX_REQUIRE_SESSION_ID` | `false` | Require session identifiers (`true` recommended for production) |
| `CODEX_JSON_LIMIT` | `10mb` | `express.json()` body limit |

## Troubleshooting

- **413 PayloadTooLargeError** – Increase `CODEX_JSON_LIMIT` when sending base64 images or large bodies.
- **“Invalid or missing API key”** – Provide the correct `Authorization: Bearer <CODEX_BRIDGE_API_KEY>` or `x-api-key`.
- **Codex refuses to run (Git check)** – Disable `CODEX_SKIP_GIT_CHECK` only if the working directory is a trusted repo.
- **Need a clean slate** – Stop the server and delete `.codex_threads.json` and/or `~/.codex/sessions`.

## License

Non-commercial use only. See [LICENSE](LICENSE) for the full terms. Commercial usage requires prior written permission from begonia.

## Support & contact

- Repository: https://github.com/begonia599/CodexBridge
- Email: `begonia@bgnhub.me`

Feel free to reach out if you run into problems, want new features, or plan to fork and rework CodexBridge. Contributions and derivative projects are welcome.
