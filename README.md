# KeyVex

An MCP (Model Context Protocol) server exposing US public financial disclosures as agent-native tools. Designed from the ground up for AI agents — fewer tools, smarter parameters, descriptions that help the agent decide when to use each one.

## What it covers

Nine tools, one source of truth per domain, all backed by autonomous scrapers running on Firebase Cloud Functions:

| Tool | Source | Cadence |
|---|---|---|
| `get_insider_transactions` | SEC Form 4 | Every 30 min |
| `get_institutional_holdings` | SEC 13F-HR | Every 4 hours |
| `get_congressional_trades` | Senate eFD + House Clerk PTRs | Daily 6 AM ET |
| `get_planned_insider_sales` | SEC Form 144 | Hourly |
| `get_activist_stakes` | SEC 13D / 13G | Hourly |
| `get_federal_contracts` | USAspending.gov | Daily |
| `get_member_profile` | unitedstates/congress-legislators | Weekly |
| `get_material_events` | SEC 8-K | Hourly |
| `get_lobbying_filings` | Senate LDA (lda.gov) | Daily |

Plus a `legislators_historical` collection (~12,000 members back to 1789) for resolving former senators/reps when joining trades to profiles.

## Status

v0.15.0 — production. All 12 scrapers running autonomously on cron schedules in the `capitaledge-api` Firebase project. MCP server deployed as an authenticated HTTPS endpoint. Bioguide back-fill at 100% on congressional trades. Full v1 + v2 build closed.

The Firebase project ID `capitaledge-api` is permanent infrastructure (Google does not allow renaming project IDs). The KeyVex brand is independent of that internal identifier.

## Public endpoint

```
https://us-central1-capitaledge-api.cloudfunctions.net/mcp
```

Auth: `Authorization: Bearer <MCP_API_KEY>` on POST. Health-check at GET / returns version + tool list with no auth.

A custom domain (`mcp.keyvex.com`) will be mapped on top of this URL once the keyvex.com domain finishes registration.

## Stack

- **Language:** TypeScript on Node 20+
- **MCP SDK:** `@modelcontextprotocol/sdk` (StreamableHTTPServerTransport for HTTP, StdioServerTransport for Claude Desktop)
- **Data layer:** Google Firestore via `firebase-admin`
- **Hosting:** Firebase Cloud Functions Gen 2, region `us-central1`
- **Auth:** API key in Google Secret Manager (`MCP_API_KEY`) for the public HTTP endpoint

## Quickstart (local development)

```bash
npm install

# Run the stdio server (for Claude Desktop wiring):
npm run dev

# Run a one-off scraper from the CLI:
npx tsx src/scrape.ts ping
npx tsx src/scrape.ts 8k AAPL
npx tsx src/scrape.ts congressional 7 --save
```

Connect from Claude Desktop by pointing the MCP-server config at `node /path/to/dist/index.js` after `npm run build`, or `tsx /path/to/src/index.ts` for development.

For Firestore connectivity, drop a service account JSON at `secrets/service-account.json` (path is gitignored). The same code auto-detects the Cloud Functions runtime via `K_SERVICE` env var and uses Application Default Credentials there instead.

## Architecture

```
src/
├── tools/                 — one file per MCP tool (definition + handler)
│   ├── insider-transactions.ts
│   ├── institutional-holdings.ts
│   ├── congressional-trades.ts
│   ├── planned-insider-sales.ts
│   ├── activist-stakes.ts
│   ├── federal-contracts.ts
│   ├── member-profile.ts
│   ├── material-events.ts
│   ├── lobbying-filings.ts
│   └── index.ts           — registry of all tools
├── scrapers/              — one file per data source (Senate, House, EDGAR forms, USAspending, LDA, ...)
├── server-setup.ts        — shared MCP-server tool-registration logic
├── firestore.ts           — data layer with stub/live mode auto-detection
├── types.ts               — shared types
├── scrape.ts              — local CLI for invoking scrapers
└── index.ts               — stdio entry point (Claude Desktop)

functions/
├── src/index.ts           — Firebase Cloud Functions entry: 12 scheduled scrapers + the `mcp` HTTP function
├── package.json           — minimal deps (firebase-functions, firebase-admin); rest bundled by esbuild
└── tsconfig.json          — extends parent, includes ../src
```

## Pure-publisher posture

KeyVex returns raw, normalized public-record data. No derived signals, no convergence scores, no "buy"/"sell" language, no investment advice. That keeps the product cleanly outside investment-advisor territory under the publisher's exemption (Lowe v. SEC, 1985). Agent consumers can layer their own analysis on top.

## License

Private. No license declared. Reach out if you'd like access.

## Contact

`contact@capitaledge.app` (until `contact@keyvex.com` is operational).
