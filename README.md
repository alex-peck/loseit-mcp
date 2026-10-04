# Lose It MCP

Unofficial MCP server for Lose It, reverse-engineered from observed web app traffic and validated against live API behavior.

## Overview

This project exposes Lose It calorie tracking and nutrition data through MCP using the web app's GWT-RPC API and the mobile sync gateway for fasting.

Supported capabilities include:

- **bulk calorie history** — one record per day across an arbitrary date range
  in a single request, with aggregate statistics
- **bulk nutrition history** — per-day macro/micronutrient totals across a range
- **bulk weight history** — every weigh-in in a range, with trend and rolling average
- **food aggregation** — the most-logged / highest-calorie foods across a range
- reading a single day's calorie summary with budget, eaten, and remaining
  calories for any date (historical dates supported), plus the recorded weight
- reading a single day's food log entries with food name, brand, measured
  amount, serving unit, and per-food nutrition for the logged portion (calories, protein, fat,
  saturated fat, cholesterol, sodium, carbohydrates, fiber, and sugars)
- searching the food database, inspecting a selected food's default serving
  and available measures, and logging that food into a chosen meal and date
- editing (amount, meal) and deleting logged foods
- **intermittent fasting** — fasting history, the fast in progress, the fasting
  schedule, and starting, ending, editing, resuming, and deleting fasts
- logging, reading, and deleting exercise
- recording weigh-ins
- daily notes: read, add, edit, delete
- custom goals (steps, water, sleep, measurements, …): read and record or
  remove a day's value

## Tools

| Tool | Scope | Purpose |
| --- | --- | --- |
| `loseit_get_daily_summaries` | range | One record per day: eaten, budget, exercise, remaining, weight, food count — plus totals, mean/median/min/max, days over budget, and weight trend. **The tool to use for any multi-day analysis.** |
| `loseit_get_nutrition_history` | range | Per-day totals for calories, protein, fat, saturated fat, carbohydrates, fiber, sugars, sodium, and cholesterol, with per-nutrient statistics. |
| `loseit_get_weight_history` | range | Every weigh-in with net change, min/max, and a 7-point rolling average. |
| `loseit_get_top_foods` | range | Foods ranked by total calories or logging frequency, with each food's share of range calories. |
| `loseit_get_daily_summary` | one day | A single day's calorie summary (plus the week's breakdown for a current-week date). |
| `loseit_get_food_log` | one day | A single day's individual food entries with per-food nutrition. |
| `loseit_get_food_model` | metadata | Meal categories, measurement and nutrient units, account timezone, and logging workflow. |
| `loseit_search_foods` | search | Search food database by name; returns exact food IDs plus the search context required to fetch them. |
| `loseit_get_food` | one food | Inspect the default serving, nutrient values, and available serving-size descriptors for a search result. |
| `loseit_log_food` | write | Log a selected food into breakfast, lunch, dinner, or snacks on a given date. |
| `loseit_update_food_entry` | write | Change a logged food's amount (`portion`) and/or meal. |
| `loseit_delete_food_entry` | write | Delete a logged food. |
| `loseit_get_fasts` | range | Fasts that started in the range, the fast in progress, the fasting schedule, and summary stats. |
| `loseit_start_fast` | write | Start a fast now or at an earlier time; defaults to the most common scheduled goal; supply `targetHours` for mixed schedules. |
| `loseit_end_fast` | write | End the fast in progress now or at an earlier time. |
| `loseit_update_fast` | write | Edit a fast's start, end, or goal; `endTime: null` resumes it. |
| `loseit_delete_fast` | write | Delete a fast. |
| `loseit_search_exercises` | search | Exercise categories with their variants and METs. |
| `loseit_get_exercise_log` | one day | A day's exercises with minutes and calories. |
| `loseit_log_exercise` | write | Log an exercise variant for some minutes (calories estimated as Lose It does, or supplied). |
| `loseit_delete_exercise` | write | Delete a logged exercise. |
| `loseit_record_weight` | write | Record a weigh-in (lb or kg) for a date, replacing that day's weight. |
| `loseit_get_notes` | one day | A day's notes. |
| `loseit_add_note` | write | Add a daily note. |
| `loseit_update_note` | write | Edit a daily note. |
| `loseit_delete_note` | write | Delete a daily note. |
| `loseit_get_custom_goals` | one day | Custom goals with their range and the day's value. |
| `loseit_record_custom_goal_value` | write | Record a goal's value for a date (replaces that day's value). |
| `loseit_delete_custom_goal_value` | write | Remove a goal's value for a date. |

Every range tool accepts the same arguments: `startDate` + `endDate`
(`YYYY-MM-DD`, inclusive), or `days` counting back from `endDate` (which
defaults to today). The default range is the last 30 days and the maximum span
is 1100 days.

### Logging food

Call `loseit_search_foods` with a food name, choose a result, then pass its
`foodId`, `name`, and `source` **unchanged** to `loseit_get_food` to inspect its
default serving and nutrition. Pass the same three fields to `loseit_log_food`,
along with a required `meal` (`breakfast`, `lunch`, `dinner`, or `snacks`).
`date` is optional (`YYYY-MM-DD` in the configured account timezone, default
today). For a measured amount, supply
`portion: {"amount": 30, "unit": "grams"}` or
`portion: {"amount": 16, "unit": "fluid ounces"}`. The tool
selects that food's matching serving-size descriptor and applies its
reference-amount conversion. If multiple descriptors match, specify
`servingSizeIndex` from `loseit_get_food` as well; when using an index without
`unit`, `amount` is in the descriptor's unit. Common mass and liquid-volume
units can be converted within their respective families if the exact unit is
missing. **Mass-to-volume conversions require a food-specific density and
are not guessed.** Alternatively, omit `portion` and use `servings` (default
1) to multiply the default portion (including its displayed amount). Never
supply both.

`loseit_get_food` reports the default serving and each available descriptor's
physical `amount`, `unit`, and `referenceAmount`; `quantity` is Lose It's
internal portion multiplier, **not** the physical amount. The food log
includes `servingAmount` in `servingUnit`, plus the meal, food ID, and entry ID
when its full model can be decoded. `loseit_get_food_model` lists the unit
names and logging workflow.

Food logging creates a new entry and is **not idempotent**. Write RPCs are
never automatically retried: if the request times out or its response is lost,
check `loseit_get_food_log` before trying again. Search and logging require the
live GWT model registry; if auto-discovery fails, these tools return an
explicit error rather than guessing a food model. Creating custom foods and
recipes is not yet supported.

### Editing the log

Food, exercise, and note editing tools identify an item by the id their read
tool returns (`entryId` from `loseit_get_food_log` / `loseit_get_exercise_log`,
or `noteId`) plus the `date` it is logged on. They re-read the day after writing
and report an error if Lose It did not apply the requested change. Goal and
weight writes also verify their saved values. Updates and deletes are safe to
repeat; additions are not. Repeating a delete for an item already removed
returns a not-found error without writing again.

`loseit_update_food_entry` rebuilds the serving from the food, as the web app
does, so `portion: {"amount": 2}` keeps the entry's current unit and
`{"amount": 150, "unit": "grams"}` converts like `loseit_log_food`.

`loseit_log_exercise` estimates calories with Lose It's own formula —
(METs − 1) × weight in kg × 1.05 × hours, which reproduces the burns Lose It
stores — unless `calories` is supplied. Like the apps, logging exercise posts
the workout to the account's activity feed. Durations must be whole minutes
(1–1440); the same duration is used for the saved workout and calorie estimate.
After a timeout or lost response, check the exercise log before retrying.

Goals that Lose It calculates from the food log (net carbs, protein, fiber)
cannot be recorded manually. Water and other goals must already exist on the
account; create them in the Lose It app.

### Fasting

Fasting is not part of the web app. These tools use the mobile apps' sync
gateway (`gateway.loseit.com/user/loseItTransactionBundle`, protobuf), which
accepts the same login as the web API. The gateway only offers "changes since
a cursor", so the first fasting call in a process downloads the account's sync
history (a few megabytes, roughly 10–20 seconds) and later calls only fetch
what changed. Times are given and returned in the account timezone
(`YYYY-MM-DDTHH:MM`, or with an explicit offset). Local times skipped by a clock
change are rejected; repeated local times require an explicit UTC offset.
Starts and ends more than five minutes in the future are rejected (the small
tolerance allows clock skew). The default goal uses the most common scheduled
goal, falling back to the latest fast's goal or 16 hours. The gateway's weekday
numbering is unverified, so mixed schedules do not select a goal by weekday;
supply `targetHours` to choose one explicitly. Goals must be at least one
minute and are rounded to whole minutes.

Fasting changes upsert the whole fast and require a gateway acknowledgement.
Updates and deletes use `fastId` without a date. A start creates a new ID;
after an uncertain result, check `loseit_get_fasts` before retrying. Concurrent
fasting calls on a client are serialized to keep its sync cursor consistent.

In HTTP mode, all logging and fasting changes require both the `mcp:tools` and `mcp:tools:write`
OAuth scopes. Existing read-only authorizations cannot write: reconnect
and authorize again with both scopes, since a refresh token cannot add write
access. A client must request the write scope; the sign-in page displays the
requested permissions but does not provide a scope picker. Local stdio mode
does not use OAuth scopes. After adding tools, refresh the app's tool scan in
ChatGPT developer mode; reauthorizing alone does not refresh its tool list.
Published apps require an admin to update actions or republish the app.
The server validates a cached Lose It session during sign-in and renews it if
Lose It rejects a read request. GWT writes are never automatically
retried, even if the upstream session expires.

## API Coverage

Most tools use the Lose It web app GWT-RPC endpoint (`www.loseit.com/web/service`) with session cookies obtained from `api.loseit.com/account/login`. Fasting uses the iOS app's protobuf sync gateway (`gateway.loseit.com`), authenticated with the `liauth` token from the same login and identified as iOS app build 18.5.400 (the build its protocol was captured from).

Avoid repeated logins: Lose It's login endpoint is rate-limited by Cloudflare
(HTTP 429, error 1015, for roughly ten minutes after a handful of logins). The
server reuses the cached session and only logs in when Lose It rejects it.

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
- `MCP_ALLOWED_REDIRECT_HOSTS` (comma-separated OAuth client redirect
  hostnames; defaults to ChatGPT/OpenAI plus localhost)
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
- Automated tests use isolated session storage and do not write to the real
  account's session cache or contact its API.
- Logging tools validate the numbered model fields they use against the live web
  serializers and refuse changed layouts rather than writing mismatched data.
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
