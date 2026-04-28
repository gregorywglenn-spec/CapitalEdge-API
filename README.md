# Capital Edge MCP Server

Working title for an MCP (Model Context Protocol) server that exposes US public financial disclosures — congressional trades, executive insider transactions (Form 4), and institutional holdings (13F) — as a clean toolkit designed natively for AI agents and the developers building them.

Sibling project to the Capital Edge dashboard at `C:\CapitalEdge`. The dashboard project owns the scrapers and the Firestore data; this project owns the agent-facing delivery surface.

## Project status

April 28, 2026 — v0.1 scaffold. The MCP server boots and responds to protocol messages, but registers no tools yet. Tool registration is gated on (a) data foundation fixes landing in the dashboard project (see `DATA_REQUIREMENTS_FOR_DASHBOARD.md`), and (b) service account credentials being provisioned.

## Day-1 reading for a cold Cowork session

Read these files in this folder in order:

1. **`MCP_PROJECT_HANDOFF.md`** — the original handoff from the chat-interface session that scoped this product, including the load-bearing argument for MCP-first sequencing, architecture decisions, competitive landscape, legal posture, and Day-1 first-move guidance. (May get renamed to `HANDOFF_NEXT_SESSION.md` per its own instructions.)
2. **`DATA_REQUIREMENTS_FOR_DASHBOARD.md`** — the spec this project sent to the dashboard project listing every data fix needed in the shared Firestore collections before the MCP tools can return rich responses. Includes anticipated composite indexes and Firestore security-rules notes.
3. **Selected files in `C:\CapitalEdge\`** — `DATA_STRATEGY.md` (the original dual-track business plan), `CONGRESS_DATA_PIPELINE.md` (bioguide_id / committee data integration spec), `DATA_SOURCES_ROADMAP.md` (post-v1 expansion sources), `run-scraper.js` (the canonical scraper code that wrote real Firestore data), `firestore.rules`, `firestore.indexes.json`.

## Stack

- **Language:** TypeScript on Node 20+
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **Data layer:** Firestore via `firebase-admin` (read-only against Capital Edge's collections)
- **Transport:** stdio for local dev; remote (HTTPS) for deployed v1
- **Hosting (planned):** Firebase Functions or Cloud Run, sibling Firebase project to Capital Edge

## Quickstart

```bash
npm install
npm run dev
```

`dev` runs the server with `tsx watch` for hot reload. Connect from Claude Desktop or any MCP client by pointing it at `node /path/to/dist/index.js` (after `npm run build`) or `tsx /path/to/src/index.ts` for development.

For Firestore connectivity, drop a service account JSON at `secrets/service-account.json` (path is gitignored). Configuration loader is not yet wired — that lands when the first tool is registered.

## Project boundaries

This project does **not** write to the shared Firestore collections (`congressional_trades`, `insider_trades`, `institutional_holdings`). All scraper changes and data corrections happen in the Capital Edge dashboard project. When this project needs schema changes, it raises them via the data requirements doc, not by editing scraper code from here.

## License

Private, no license declared. Pre-release.
