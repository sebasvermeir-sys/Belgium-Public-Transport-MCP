# Public Transport Belgium MCP

A remote [MCP](https://modelcontextprotocol.io) server for Belgian public transport, running on Cloudflare Workers. Add it to Claude (web, desktop or phone) as a custom connector and ask things like:

- "Is the 08:04 from Brussels-Midi to Gent on time, and which platform?"
- "When is the next metro at Arts-Loi?"
- "Which bus from Gent Sint-Pietersstation gets me to Gent Zuid, and when does it arrive?"
- "Any disruptions on the SNCB today?"

| Operator | Data | Key needed |
|---|---|---|
| **SNCB/NMBS** (trains) | Live boards, journeys, train stops, composition, disruptions via [iRail](https://docs.irail.be) | none |
| **STIB/MIVB** (Brussels metro, tram, bus) | Live waiting times, stops, travellers info | Belgian Mobility open data (free) |
| **De Lijn** (Flemish bus, tram) | Live delays, timetables, A→B trips, disruptions | De Lijn open data (free) |

TEC (Wallonia) is not supported yet.

## Tools

| Tool | What it does |
|---|---|
| `find_stop` | Search stations and stops (FR/NL/EN names, nicknames, typos). |
| `departures` / `arrivals` | Live board at a stop. For De Lijn, `to` keeps only trips that reach that stop and shows the arrival time. |
| `plan_journey` | Train connections A → B with delays, platforms and transfers. |
| `train_status` | Every stop of one train, with live times. |
| `disruptions` | SNCB, STIB or De Lijn disruptions, filterable by line or stop. |
| `composition` | Carriages, seats and facilities of a train. |
| `commute_check` | Door-to-door Brussels ⇄ Gent: STIB metro → Brussels-Midi → train → Gent-Sint-Pieters → De Lijn, 3 plans by default. You pass your own stops. |

Output is compact text, one line per item, designed to be cheap for the model to read. The server stores no personal data: no accounts, no favourites, no history.

## Deploy your own

You need a free [Cloudflare](https://dash.cloudflare.com) account and Node.js 20+.

```bash
git clone https://github.com/sebasvermeir-sys/Belgium-Public-Transport-MCP.git
cd Belgium-Public-Transport-MCP
npm install
npx wrangler login
npx wrangler kv namespace create CACHE   # paste the printed id into wrangler.jsonc
```

Edit `wrangler.jsonc`:
- `kv_namespaces[0].id`: the id from the command above.
- `IRAIL_USER_AGENT`: your own app name and contact (iRail asks for this).

Set the secrets. Each command prompts for the value, so it never lands in your shell history or in git:

```bash
npx wrangler secret put MCP_TOKEN              # required: a long random password, e.g. from `openssl rand -hex 32`
npx wrangler secret put BELGIAN_MOBILITY_KEY   # optional: enables STIB
npx wrangler secret put DELIJN_API_KEY         # optional: enables De Lijn
npx wrangler secret put APP_TOKEN              # optional: see "Structured output" below
```

Then:

```bash
npm run deploy
```

### Getting the API keys
- **STIB:** sign up at the [Belgian Mobility open data portal](https://api-management-opendata-production.developer.azure-api.net), subscribe to the STIB product and copy the subscription key.
- **De Lijn:** sign up at [portal.delijn.be](https://portal.delijn.be), subscribe to "Open Data Free" and copy the primary key.

Without these keys the server still works for SNCB; the STIB or De Lijn tools say they're not configured.

## Connect it to Claude

In claude.ai: **Settings → Connectors → Add custom connector**.
- **URL:** `https://<your-worker>.workers.dev/mcp`
- **Request header** (if your account offers it): `Authorization: Bearer <MCP_TOKEN>`
- Otherwise use the URL `https://<your-worker>.workers.dev/mcp/<MCP_TOKEN>`. This puts the token in the URL, so only use it where headers aren't available.

Any other MCP client that speaks Streamable HTTP works the same way.

## Structured output (optional)

Callers using `APP_TOKEN` instead of `MCP_TOKEN` get the same text plus `structuredContent` with a declared `outputSchema` (schema version "1"): ISO times with the Brussels offset, stops with coordinates, time objects `{scheduled, expected, delay_min, realtime}`, and stable disruption ids. This is meant for apps and dashboards. The chat token stays text-only because the structured data is several times larger. The schemas live in `src/structured.ts`.

## Development

```bash
cp .dev.vars.example .dev.vars   # fill in at least MCP_TOKEN; never commit .dev.vars
npm run dev                      # local server on http://localhost:8787/mcp
npm test                         # vitest: runs the real Worker against recorded fixtures with a fixed clock
npm run typecheck
npm run profile                  # CPU time per tool
```

- Text output is locked by `test/snapshot.test.ts`. Update snapshots (`npx vitest run -u`) only for deliberate format changes.
- Recorded upstream responses are in `test/fixtures/`.

### Notes
- **Free plan CPU:** Workers Free allows 10 ms of CPU per request. Warm requests fit, but the first request on a fresh instance can go over and fail. The [Workers Paid plan](https://developers.cloudflare.com/workers/platform/pricing/) ($5/month) removes this.
- **Stop lists** (about 715 SNCB stations and 870 STIB stops) are rebuilt into KV by a cron every 6 hours. De Lijn stops are looked up through its search API on demand.
- **Caching:** responses are cached for 20–60 s, with a 10-minute stale copy served if an upstream API fails.
- **iRail** allows 3 requests per second per IP. The server throttles itself below that.

## Data sources

Train data from [iRail](https://irail.be) (community API on top of NMBS/SNCB open data). STIB data from the Belgian Mobility open data portal. De Lijn data from the De Lijn open data portal. Check each provider's terms before running a public instance. This project is not affiliated with SNCB, STIB, De Lijn or iRail.

## License

[MIT](LICENSE)
