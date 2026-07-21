# Lose It MCP

Unofficial MCP server for Lose It, reverse-engineered from observed web app traffic and validated against live API behavior.

Built entirely by Claude Opus 4.6 via Claude Code.

## Overview

This project exposes Lose It calorie tracking and nutrition data through MCP using the web app's GWT-RPC API.

Supported capabilities include:

- reading daily calorie summary with budget, eaten, and remaining calories
- reading weekly calorie history with per-day breakdowns
- reading food log entries with food name, brand, servings logged, and per-food
  nutrition for the logged portion (calories, protein, fat, saturated fat,
  cholesterol, sodium, carbohydrates, fiber, and sugars), plus the day's total calories

## API Coverage

The current implementation uses the Lose It web app GWT-RPC endpoint (`www.loseit.com/web/service`) with session cookies obtained from `api.loseit.com/account/login`. The iOS app's protobuf API is not used.

The GWT-RPC policy hash and permutation header are tied to the current Lose It
web app build and change whenever Lose It recompiles the web app. By default the
server **auto-discovers** both values at startup from the public compiled web app
assets (the `.nocache.js` bootstrap and the selected `.cache.js` permutation), so
it keeps working across Lose It deploys with no manual intervention. Auto-discovery
can be disabled with `LOSEIT_GWT_AUTOFETCH=false`, and either value can be pinned
explicitly via the environment variables below (an explicit override always wins).

## Setup

```bash
npm install
cp .env.example .env
npm test
npm run build
```

Configuration requires:

- `LOSEIT_EMAIL`
- `LOSEIT_PASSWORD`

Optional values:

- `LOSEIT_TIMEZONE` (IANA zone, default `America/Chicago`)
- `LOSEIT_SESSION_PATH` (default `~/.loseit-mcp/session.json`)
- `LOSEIT_REQUEST_TIMEOUT_MS` (default `15000`)
- `LOSEIT_GWT_AUTOFETCH` (default `true`; set `false` to disable runtime discovery of the build values below)
- `LOSEIT_GWT_POLICY_HASH` (pin the policy hash instead of auto-discovering it)
- `LOSEIT_GWT_PERMUTATION` (pin the permutation strong name instead of auto-discovering it)

## MCP Setup

The server runs over stdio.

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

## Notes

- Session cookies are cached to `~/.loseit-mcp/session.json` to avoid re-authenticating on every server start. The cache is created with restricted file permissions.
- The food log returns per-food nutrition for the logged portion (calories plus
  macros) along with the day's total calories. Nutrition is recovered by fully
  deserializing the GWT-RPC object graph. The model field layouts are
  auto-generated at startup from Lose It's compiled permutation JavaScript (the
  generated field serializers are the ground truth for field order/types), so
  the parser stays correct across Lose It rebuilds and on days that include
  synced/manual workouts. If the permutation JS can't be fetched or parsed, the
  tool falls back to a built-in registry, and if the graph still can't be parsed
  cleanly it degrades to name/brand-only results and sets `detailed: false`.
- The GWT-RPC response parser combines a structural object-graph deserializer
  (for the food log) with targeted pattern extraction (for summaries).
