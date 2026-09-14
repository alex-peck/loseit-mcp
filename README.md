# Lose It MCP

Unofficial MCP server for Lose It, reverse-engineered from observed web app traffic and validated against live API behavior.

Built entirely by Claude Opus 4.6 via Claude Code.

## Overview

This project exposes Lose It calorie tracking and nutrition data through MCP using the web app's GWT-RPC API.

Supported capabilities include:

- **bulk calorie history** — one record per day across an arbitrary date range
  in a single request, with aggregate statistics
- **bulk nutrition history** — per-day macro/micronutrient totals across a range
- **bulk weight history** — every weigh-in in a range, with trend and rolling average
- **food aggregation** — the most-logged / highest-calorie foods across a range
- reading a single day's calorie summary with budget, eaten, and remaining
  calories for any date (historical dates supported), plus the recorded weight
- reading a single day's food log entries with food name, brand, servings
  logged, and per-food nutrition for the logged portion (calories, protein, fat,
  saturated fat, cholesterol, sodium, carbohydrates, fiber, and sugars)

## Tools

| Tool | Scope | Purpose |
| --- | --- | --- |
| `loseit_get_daily_summaries` | range | One record per day: eaten, budget, exercise, remaining, weight, food count — plus totals, mean/median/min/max, days over budget, and weight trend. **The tool to use for any multi-day analysis.** |
| `loseit_get_nutrition_history` | range | Per-day totals for calories, protein, fat, saturated fat, carbohydrates, fiber, sugars, sodium, and cholesterol, with per-nutrient statistics. |
| `loseit_get_weight_history` | range | Every weigh-in with net change, min/max, and a 7-point rolling average. |
| `loseit_get_top_foods` | range | Foods ranked by total calories or logging frequency, with each food's share of range calories. |
| `loseit_get_daily_summary` | one day | A single day's calorie summary (plus the week's breakdown for a current-week date). |
| `loseit_get_food_log` | one day | A single day's individual food entries with per-food nutrition. |

Every range tool accepts the same arguments: `startDate` + `endDate`
(`YYYY-MM-DD`, inclusive), or `days` counting back from `endDate` (which
defaults to today). The default range is the last 30 days and the maximum span
is 1100 days.

## API Coverage

The current implementation uses the Lose It web app GWT-RPC endpoint (`www.loseit.com/web/service`) with session cookies obtained from `api.loseit.com/account/login`. The iOS app's protobuf API is not used.

The GWT-RPC policy hash and permutation header are tied to the current Lose It
web app build and change whenever Lose It recompiles the web app. By default the
server **auto-discovers** both values at startup from the public compiled web app
assets (the `.nocache.js` bootstrap and the selected `.cache.js` permutation), so
it keeps working across Lose It deploys with no manual intervention. Auto-discovery
can be disabled with `LOSEIT_GWT_AUTOFETCH=false`, and either value can be pinned
explicitly via the environment variables below (an explicit override always wins).

## Run Modes

The same build supports two deployment styles:

| Mode | Transport | Accounts | Credentials |
| --- | --- | --- | --- |
| `stdio` (default) | local stdio | one | `LOSEIT_EMAIL` and `LOSEIT_PASSWORD` in the process environment |
| `http` | Streamable HTTP + OAuth | many | each user signs in through the server's web page |

HTTP mode implements OAuth authorization-code flow with PKCE, dynamic client
registration, access/refresh tokens, and the MCP protected-resource metadata
used by remote clients. Each MCP session is bound to the authenticated Lose It
account. OAuth clients, tokens, and Lose It credentials are persisted in one
AES-256-GCM encrypted file; raw OAuth tokens are stored only as hashes.

## Setup

```bash
npm install
cp .env.example .env
npm test
npm run build
```

Shared optional values:

- `MCP_TRANSPORT` (`stdio` by default; set `http` for multi-user hosting)
- `LOSEIT_TIMEZONE` (IANA zone shown by default on the hosted sign-in page;
  default `America/Chicago`)
- `LOSEIT_REQUEST_TIMEOUT_MS` (default `15000`)
- `LOSEIT_GWT_AUTOFETCH` (default `true`; set `false` to disable runtime discovery of the build values below)
- `LOSEIT_GWT_POLICY_HASH` (pin the policy hash instead of auto-discovering it)
- `LOSEIT_GWT_PERMUTATION` (pin the permutation strong name instead of auto-discovering it)

### Single-user stdio mode

Required:

- `LOSEIT_EMAIL`
- `LOSEIT_PASSWORD`

Optional:

- `LOSEIT_SESSION_PATH` (default `~/.loseit-mcp/session.json`)

The server runs over stdio:

Example client configuration for the built server:

```json
{
  "mcpServers": {
    "loseit": {
      "command": "node",
      "args": ["/absolute/path/to/loseit-mcp/dist/index.js"],
      "cwd": "/absolute/path/to/loseit-mcp"
    }
  }
}
```

For local development without building first:

```json
{
  "mcpServers": {
    "loseit": {
      "command": "npx",
      "args": ["tsx", "src/index.ts"],
      "cwd": "/absolute/path/to/loseit-mcp"
    }
  }
}
```

If a client does not support `cwd`, pass the Lose It environment variables directly in the client configuration instead of relying on `.env`.

### Multi-user HTTP mode

Required:

- `MCP_TRANSPORT=http`
- `MCP_PUBLIC_URL` — the externally reachable HTTPS origin, without a path
  (for example `https://loseit-mcp.example.com`)
- `MCP_ENCRYPTION_SECRET` — at least 32 random characters; keep this stable or
  the encrypted user/token store cannot be opened

Optional:

- `MCP_HTTP_HOST` (default `0.0.0.0`)
- `MCP_HTTP_PORT` (default `3000`)
- `MCP_DATA_PATH` (default `~/.loseit-mcp/server.enc.json`)
- `MCP_ALLOWED_HOSTS` (comma-separated; defaults to the hostname in
  `MCP_PUBLIC_URL`)
- `MCP_TRUST_PROXY` (default `false`; set `true` behind one trusted reverse
  proxy so rate limiting sees the client address)

Generate an encryption secret and start the server:

```bash
export MCP_TRANSPORT=http
export MCP_PUBLIC_URL=https://loseit-mcp.example.com
export MCP_ENCRYPTION_SECRET="$(openssl rand -base64 48)"
npm run build
npm start
```

Terminate TLS at the application or at a trusted reverse proxy and forward the
public origin to `MCP_HTTP_PORT`. Persist `MCP_DATA_PATH` across deploys and
back it up together with the encryption secret.

The remote MCP URL is:

```text
https://loseit-mcp.example.com/mcp
```

Add that URL as the MCP server in ChatGPT. The OAuth browser flow displays this
server's sign-in page; each person enters their own Lose It email, password, and
timezone. The health endpoint is `GET /healthz`.

## Notes

- Session cookies are cached to `~/.loseit-mcp/session.json` to avoid re-authenticating on every server start. The cache is created with restricted file permissions.
- In HTTP mode, Lose It session cookies remain in memory. Encrypted credentials
  allow the server to re-authenticate an account after a restart or expired
  Lose It session without writing a plaintext per-user cookie cache.
- Bulk range tools are backed by Lose It's own
  `getDailyDetailsIncludingPendingForDateRange` RPC, which the web app uses to
  render its multi-day views. One request returns the whole range, so pulling
  three years of daily calories costs a handful of requests rather than a
  thousand. Ranges are split into 200-day chunks, because a single very large
  request can take Lose It over a minute to build from a cold cache while each
  chunk answers in about a second.
- Very large GWT-RPC responses are not valid JSON: the server emits them as
  chunked JavaScript array literals joined with `.concat(...)`. The parser
  splices those chunks back together, which is what makes multi-year ranges
  possible.
- Each day's weigh-in is read from that day's own record in the object graph, so
  weights are attributed to the correct date.
- The food log returns per-food nutrition for the logged portion (calories plus
  macros) along with the day's total calories for any requested date (not just
  the current week). The tool fetches the requested day directly via Lose It's
  `getDailyDetailsForDate` RPC, so arbitrary historical dates are supported.
  Nutrition is recovered by fully
  deserializing the GWT-RPC object graph. The model field layouts are
  auto-generated at startup from Lose It's compiled permutation JavaScript (the
  generated field serializers are the ground truth for field order/types), so
  the parser stays correct across Lose It rebuilds and on days that include
  synced/manual workouts. If the permutation JS can't be fetched or parsed, the
  tool falls back to a built-in registry, and if the graph still can't be parsed
  cleanly it degrades to name/brand-only results and sets `detailed: false`.
- The GWT-RPC response parser combines a structural object-graph deserializer
  for the food log and daily summary, both of which fetch the requested day
  directly via Lose It's `getDailyDetailsForDate` RPC for arbitrary historical
  dates. The daily summary keeps the full current-week breakdown when the
  requested day falls in the current week, and returns just that day otherwise.
  "Today" is resolved in the account's configured timezone
  (`LOSEIT_TIMEZONE`, default `America/Chicago`), so the correct day is used
  even when the server process runs in UTC.
