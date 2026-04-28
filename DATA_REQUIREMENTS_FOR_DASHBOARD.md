# Data Requirements — From the MCP/API Project to the Dashboard Project

**Audience:** The Claude session working in `C:\CapitalEdge\` (the dashboard project).
**Author:** Cowork session working in `C:\CapitalEdge-API\` (the MCP server / API project).
**Date:** April 28, 2026
**Status:** Requirements spec. Implementation owner is the dashboard project per the project-boundary rule (scrapers are owned there, delivery surface is owned here).

---

## Why this document exists

The MCP server we're building in `C:\CapitalEdge-API\` reads from the same Firestore collections (`congressional_trades`, `insider_trades`, `institutional_holdings`) that the Capital Edge dashboard's scrapers write to. After reading all the relevant code in `C:\CapitalEdge\`, the MCP project has identified gaps between what those collections contain today and what an MCP customer would need from them.

This is the spec for what to fix on the scraper side. The MCP project is not going to write to those collections from its own codebase — that violates the boundary. We're handing this list across.

Greg's direction (April 28): "make this best it could possibly be… build something an agent or developer's agent would want." So the bar is "what does a paying agent customer need," not "what's easiest to ship."

---

## Key context discovered while reading

**The standalone scraper files and the Node runner are running different code.**

`C:\CapitalEdge\run-scraper.js` (the Node CLI that actually wrote real data to Firestore on April 22) does **not** import any of the four standalone scraper files. It defines its own thin inline implementations of `scrapeForm4`, `scrape13F`, `scrapeSenate`, `scrapeHouse`. The four standalone files (and their duplicates in `C:\CapitalEdge\scrapers\`) are richer — they have full parsers — but they were written for the browser (use `DOMParser`, `document.cookie`, browser `fetch`) and cannot run as-is in Node.

**Implication:** the rich parsing logic mostly already exists. The work is to port that logic into the Node runner (or wire the standalone classes through Node-compatible DOM/cookie shims like `jsdom` and `tough-cookie`) — not to write new parsers from scratch.

**Duplicate scraper files** still exist in `C:\CapitalEdge\` root vs. `C:\CapitalEdge\scrapers\`. Greg has indicated this is the dashboard project's call to resolve. Flagging only — not action for this spec.

---

## Critical fixes (block MCP v1 quality)

### 1. Senate PTR parsing — extract trade details from PTR HTML

**Today:** `run-scraper.js` `scrapeSenate()` only checks whether the ticker appears in the PTR HTML and stores a thin record with member, chamber, disclosure_date, report_url. No transaction details.

**Required:** The fields the MCP customer needs per Senate trade record:

| Field | Type | Source |
|---|---|---|
| `transaction_type` | `"buy"` \| `"sell"` | "Purchase" / "Sale" cell in PTR HTML table |
| `transaction_date` | ISO date | First column of PTR HTML table |
| `disclosure_date` | ISO date | Filed-on date from PTR list |
| `reporting_lag_days` | number | Business days between transaction and disclosure |
| `amount_range` | string | "$1,001 - $15,000" etc. from PTR HTML |
| `amount_min` | number | Parsed lower bound |
| `amount_max` | number | Parsed upper bound |
| `owner` | string | "Self" \| "Spouse" \| "Joint" \| "Dependent" |
| `asset_name` | string | Company name from PTR HTML |
| `asset_type` | string | "Stock" \| "Stock Option" etc. |
| `comment` | string | Comment cell |
| `member_name` | string | First + last |
| `member_first`, `member_last` | string | Already separated |
| `chamber` | `"senate"` | Constant |

**Implementation guide:** The standalone `C:\CapitalEdge\congressional_scraper.js` already has a working `PTRParser` class that extracts all of these. Port the parsing logic to Node (replace `DOMParser` with `jsdom`, swap `document.cookie` for the existing `tough-cookie` jar pattern that `run-scraper.js` is already using for session management). The HTML parsing and field extraction logic does not need to change.

### 2. House PTR parsing — extract trade details from PDF text

**Today:** `run-scraper.js` `scrapeHouse()` runs `pdf-parse`, checks if the ticker appears in the PDF text, and stores a thin record with member, chamber, state_district, disclosure_date, report_url. The actual trade details inside the PDF are not extracted.

**Required:** Same field set as Senate (above) — `transaction_type`, `transaction_date`, `amount_range`, `amount_min`, `amount_max`, `owner`, `asset_name`, plus `state` and `state_district` which the House scraper already captures.

**Implementation guide:** The standalone `C:\CapitalEdge\house_scraper.js` already has `HousePDFParser` that uses regex patterns over the PDF text to extract the trade rows. The parser is heuristic (PDF layouts are messy) but it has structure to build on. Two notes:

- The standalone file's `HousePDFParser` already runs on `pdf-parse` text output, so the Node port is mostly mechanical — just remove the IIFE wrapper, drop the browser-only export branch, import what's needed.
- PDF parsing accuracy will not be 100%. Build in a "didn't parse" status flag on records where the parser couldn't extract trade details — keep them in the database as filing pointers (the standalone file already has a `_saveFilingRecord` mode that does exactly this with a `status: 'pending_pdf_parse'` flag). MCP tools can return both parsed trades and filing pointers depending on what the customer asks for.

### 3. Form 4 — restore the fields the standalone scraper has

**Today:** `run-scraper.js` `scrapeForm4()` writes a record with `id`, `ticker`, `company_cik`, `officer_name`, `officer_title`, `transaction_type`, `transaction_code`, `transaction_date`, `disclosure_date`, `shares`, `price_per_share`, `total_value`, `accession_number`, `sec_filing_url`, `created_at`.

**Missing relative to the standalone `form4_scraper.js`:**

| Field | Why it matters |
|---|---|
| `company_name` | Customers want the company name, not just the CIK |
| `shares_owned_after` | Lets customers compute "is the officer net long or net short after this trade" |
| `acquired_disposed` | "A" or "D" indicator — clarifies direction |
| `security_title` | "Common Stock" vs "Class A" vs other — material |
| `is_director` | Boolean flag for board members |
| `reporting_lag_days` | Business days between transaction and disclosure |
| `signal_weight` | Pre-computed weighting by trade size × officer rank — useful in the API even if the convergence score itself is dashboard-only |
| `data_source` | Constant marker — useful for provenance in API responses |

**Implementation guide:** The standalone `C:\CapitalEdge\form4_scraper.js` `Form4Parser.parse()` already extracts all of these. The runner's inline version is a stripped-down rewrite that lost them. Port the standalone parser's field set into the runner.

Filtering note: the standalone scraper filters out trades under $5,000 (`MIN_TRADE_VALUE`). For the API/MCP product, do not filter on amount — let the customer filter. Keep all P/S transactions regardless of size.

### 4. 13F — implement position_change calculation

**Today:** `institutional_scraper.js` (standalone, not the runner) defines `position_change`, `shares_change`, and `shares_change_pct` fields but never populates them. The comment says "calculated vs prior quarter" — the calculation isn't there. The runner has neither field at all.

**Required:** During each 13F ingestion, for each `(fund_cik, cusip)` pair, look up the prior quarter's holding in Firestore and compute:

- `position_change`: `"new"` (no prior holding) | `"closed"` (prior holding > 0, current = 0) | `"increased"` | `"decreased"` | `"unchanged"`
- `shares_change`: current shares minus prior shares
- `shares_change_pct`: percentage change

**Why it matters:** This is one of the most useful queries an MCP customer would ask: "did Berkshire add to its AAPL position?" Without `position_change`, that question requires the customer to fetch two quarters and diff them themselves. With it, one tool call answers it.

### 5. CUSIP → ticker enrichment for 13F holdings

**Today:** `institutional_scraper.js` saves `ticker: ''` and notes `// Enriched separately via CUSIP lookup` — but no enrichment happens. The runner uses a hardcoded `TICKER_CUSIP_MAP` of 14 watchlist tickers in `run-scraper.js` lines 188–203, which means any 13F holding for a ticker not in that map gets dropped during the CUSIP filter.

**Required:** A working CUSIP → ticker lookup that covers any US-listed equity, not just the watchlist.

**Options:**

- **OpenFIGI API** (free, requires API key registration). Best long-term solution. Maps CUSIP → ticker with high accuracy.
- **SEC EDGAR company tickers JSON** (already used elsewhere in the codebase) gives ticker → CIK, not CUSIP → ticker. Not directly useful for this.
- **Maintain a growing CUSIP map.** Acceptable bridge; doesn't scale to a paid API product where customers will query random tickers.

Recommend OpenFIGI integration with caching layer in Firestore (`cusip_map` collection: `{cusip: '037833100', ticker: 'AAPL', name: 'Apple Inc', last_verified: ts}`).

### 6. bioguide_id on every congressional trade

**Today:** Neither version of the congressional or house scraper stores `bioguide_id`. They store `member_name` ("Susan Collins") and sometimes `member_first` / `member_last`.

**Required:** `bioguide_id` field on every `congressional_trades` row, sourced from the unitedstates congress-legislators YAML data described in `C:\CapitalEdge\CONGRESS_DATA_PIPELINE.md`.

**Why it matters:** Joining a trade to a member's full profile (party, state, committees, photo) without bioguide_id requires fragile name matching every time. With bioguide_id, it's one Firestore lookup.

**Implementation guide:** `CONGRESS_DATA_PIPELINE.md` already specifies the catalog and the integration play. Step 2 of "How this plugs into Capital Edge specifically" in that doc says exactly this: load the catalog, build a name → bioguide reverse index, look up during scraping, store bioguide_id on the trade row.

This depends on the congress-legislators catalog being loaded. The doc says local Python bootstrap is fair game pre-foundation; the production sync function depends on Blaze tier.

---

## Medium-priority cleanup

### 7. Reconcile DATA_STRATEGY.md schema with what gets written

The schema documented in `C:\CapitalEdge\DATA_STRATEGY.md` (`congressional_trades`, `insider_trades`, `institutional_holdings`) does not match what the runner writes. Examples:

- Doc says `insider_trades.company_name`; runner writes `company_cik` (no name).
- Doc says `congressional_trades` has `party`, `state`, `transaction_type`, `transaction_date`, `amount_range`, `owner`. Runner writes only `member`, `chamber`, `disclosure_date`, `report_url`.
- Doc says `institutional_holdings.cik`; standalone uses `fund_cik`.
- Doc says `institutional_holdings.company_name`; standalone uses `issuer_name`.
- Doc has `quarter` field; runner doesn't write it (standalone does).

After fixes 1–5 land, the doc and the schema will be much closer. Either update the doc to match what gets written or align the field names. Pick one — Capital Edge customers and any future API documentation generator will read whichever is wrong and trust it.

### 8. Senate scraper — enrich party and state

The standalone `congressional_scraper.js` notes `party: meta.party || ''` and `state: meta.state || ''` — comments say "Not in PTR — enriched separately." That enrichment isn't wired up for Senate. Once bioguide_id is on the trade row (fix #6), party/state can come from the congress catalog automatically. House already has `state` and `state_district` from the XML index, but no `party`.

---

## Lower priority — known limitations

### 9. House scraper completeness

`run-scraper.js` `scrapeHouse()` slices to the first 25 PTRs from the year's index. The standalone `house_scraper.js` filters by `lookbackDays` (default 7). Neither is "every PTR ever" — both are "recent." For an MCP product backfill, a `scrape historical year` mode would be useful. Not blocking v1.

### 10. Senate scraper — pagination

`run-scraper.js` `scrapeSenate()` requests 100 PTRs per page (`length: '100'`) with no pagination loop. For periods with more than 100 PTR filings, this will silently truncate. Not blocking v1 but worth fixing before public launch.

---

## Firestore configuration

### Composite indexes

`C:\CapitalEdge\firestore.indexes.json` is currently empty (`"indexes": []`). Most MCP tools will run queries that require composite indexes — Firestore rejects any query that filters on one field and sorts by another unless the matching index is declared and deployed via `firebase deploy --only firestore:indexes`.

Firestore returns a one-click index-creation URL on the first failed query, so this is workable iteratively. But declaring them up front avoids the "first customer hit a 500 error" experience.

**Anticipated indexes for the v1 tool surface:**

| Collection | Fields |
|---|---|
| `insider_trades` | `ticker` ASC, `disclosure_date` DESC |
| `insider_trades` | `transaction_type` ASC, `total_value` DESC |
| `congressional_trades` | `ticker` ASC, `transaction_date` DESC |
| `congressional_trades` | `bioguide_id` ASC, `disclosure_date` DESC (after fix #6) |
| `institutional_holdings` | `ticker` ASC, `market_value` DESC |
| `institutional_holdings` | `fund_cik` ASC, `quarter` DESC |
| `institutional_holdings` | `ticker` ASC, `position_change` ASC, `market_value` DESC (after fix #4) |

This list will grow as the tool surface expands. The MCP project surfaces new index needs to the dashboard project as they come up; the dashboard project deploys them.

### Security rules

`C:\CapitalEdge\firestore.rules` defaults to `allow read, write: if false` for everything except per-user `users/{userId}` paths. The shared collections (`congressional_trades`, `insider_trades`, `institutional_holdings`) have no explicit rules, which means client-SDK access is denied by default.

This is fine for the MCP server because the Firebase Admin SDK with a service account bypasses security rules entirely, and customer-facing access goes through the MCP server rather than directly to Firestore. No rules changes needed for MCP v1.

If at some point the dashboard project decides to expose these collections directly to authenticated app users (e.g., real-time listeners in the dashboard UI), rules will need to be added then. Flagging for future awareness only.

---

## What this project (MCP/API) will do in parallel

While the dashboard project addresses the above, the MCP project will:

1. Continue grounding work — read remaining reference docs (`DATA_SOURCES_ROADMAP.md`, dashboard's `HANDOFF_NEXT_SESSION.md`) for context.
2. Design the v1 MCP tool surface against the *target* schema (post-fixes), with notes flagging which tools depend on which fix landing first.
3. Set up the MCP project's own Node/TypeScript scaffolding: `package.json`, `@modelcontextprotocol/sdk`, `firebase-admin`, service-account setup. The skeleton can exist without the data being perfect — testing connectivity and tool registration is independent of payload quality.

Once a meaningful subset of the fixes above land, we can stand up the first working tool end-to-end.

---

## Coordination points

- **Service account.** The MCP server will need its own Firestore credentials. Greg's call: same Firebase project as Capital Edge (one service account, shared) or sibling project (two service accounts, blast radius scoped). Lean toward sibling per the original handoff — ask Greg if/when the MCP project is ready to deploy.
- **Schema changes.** If any of fixes 1–8 result in schema changes that break the dashboard app's existing queries, those need to be coordinated. The dashboard project has authority to refuse or modify any of this — it owns the scrapers and the collections.
- **Project boundary discipline.** The MCP project will not write to shared collections from its codebase. All writes happen via the dashboard project's scrapers. The MCP project reads only.

---

*This is a living document. As MCP tool design surfaces additional data needs, they'll be added here rather than acted on directly in the dashboard codebase.*
