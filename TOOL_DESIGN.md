# v1 Tool Design — Capital Edge MCP Server

**Author:** Cowork session in `C:\CapitalEdge-API\`
**Date:** April 28, 2026
**Status:** Draft for review. Locked tool surface should be agreed before any tool is implemented end-to-end. Subject to revision once the dashboard project lands data fixes from `DATA_REQUIREMENTS_FOR_DASHBOARD.md`.

---

## Why this document

The wedge for this product is that incumbent financial-data MCPs (Unusual Whales, FMP, Alpha Vantage) all bolted MCP wrappers onto pre-existing REST APIs. They publish 100–250 tools that look like database table queries and overwhelm agent context windows. The strategic bet for Capital Edge MCP is the opposite: **fewer tools, designed for agents from the ground up, with descriptions that help the agent decide when to use each one.**

This document specifies the v1 tool surface against that bet. It's the actual creative work — once these designs are right, the implementation is mostly mechanical wiring of Firestore queries.

---

## Design principles

These principles applied across every tool in this document.

### 1. Tool count: 5 is better than 50

Each tool added is a thing the agent has to load, reason about, and choose between. The minimum viable surface that covers the core use cases beats the "complete" surface every time. v1 ships 5 tools. v2 can add what real customer feedback demands.

### 2. Filters are parameters, not separate tools

REST conventions encourage `/recent-trades` and `/trades-by-ticker` as separate endpoints. That pattern bloats MCP servers with `get_recent_X`, `get_X_by_ticker`, `get_X_by_member`, etc. — each a specific named door for a query that's really one query with different filters.

Pattern used here: one tool per *entity* (congressional trades, insider transactions, institutional holdings, member profiles), and filters are optional parameters. An agent who wants "AAPL trades by Senator Collins this year" makes one call with three filters, not three calls.

### 3. Tool descriptions help the agent decide

Tool descriptions are written for an LLM reading them at runtime, not for human API doc browsers. They include:

- **What the tool returns** — one sentence
- **When to use it** — the situations the agent should reach for this tool
- **What pairs with it** — which other tools commonly chain after this one
- **Notable gotchas** — anything the agent must understand to use the data correctly (e.g., "disclosure date vs. transaction date")

This is the single highest-leverage thing a tool description can do. Get it right and the agent reasons well; get it wrong and the agent falls back to brute-force chaining.

### 4. Response shapes are envelopes, not arrays

Every response is an object with `results`, `count`, `has_more`, `query` (echo of filters used), and any tool-specific metadata. Agents get pagination signals and can verify their query was understood. Bare arrays force agents to guess.

### 5. Names are verb-noun in plain English

`get_congressional_trades`, not `query_legislative_disclosures` or `cong_trades_v1`. If a non-technical user said the request out loud, the tool name should sound like the thing they asked for.

### 6. Output is facts, not signals

This product sells public-record disclosures. No "buy"/"strong buy"/"avoid" interpretive language anywhere in the tool surface. No `signal_weight` field even though the underlying data has one — that's dashboard-product territory under publisher's-exemption framing. This product stays in pure-publisher posture.

---

## Cross-cutting concerns

### Dates

All date inputs and outputs are ISO 8601 strings (`"2026-04-28"` for dates, `"2026-04-28T15:30:00Z"` for timestamps). The tool descriptions never say "MM/DD/YYYY" because that's an implementation detail of the upstream data sources we already normalized away.

### Tickers

All tickers are uppercase 1–5 letter strings. Tools normalize input: `"aapl"` and `"AAPL"` both work. Invalid format returns an error rather than zero results.

### Pagination

Default `limit` is 50 records. Maximum is 500. Responses include `has_more: boolean` so the agent knows whether to fetch more. Cursor-based pagination via `cursor` token (opaque string) is preferred over offset, but v1 may ship with simple `limit` only and add cursor support in v1.1 if customers ask.

### Rate limits

Per-customer rate limits enforced by the MCP server based on the customer's tier. Hitting a rate limit returns an error with structured fields:

```json
{
  "code": "RATE_LIMITED",
  "limit": 100,
  "window": "1d",
  "reset_at": "2026-04-29T00:00:00Z"
}
```

The agent can reason about the reset time. Doesn't apply to v0 / pre-launch usage.

### Error envelope

```json
{
  "code": "INVALID_TICKER" | "INVALID_DATE" | "RATE_LIMITED" | "DATA_UNAVAILABLE" | "INTERNAL_ERROR",
  "message": "human-readable explanation",
  "details": { ...field-specific... }
}
```

`DATA_UNAVAILABLE` is the polite version of "we tried but the source returned nothing usable" — used when, for example, a House PTR was filed but the PDF couldn't be parsed (returns the filing pointer with `parse_status: "failed"` instead of dropping the record).

---

## v1 tool surface (5 tools)

### Tool 1: `get_congressional_trades`

**Description (agent-facing):**

> Returns trade records disclosed by U.S. members of Congress under the STOCK Act — Senate eFD and House Clerk Periodic Transaction Reports (PTRs). Each record is one disclosed transaction by a member or their immediate family.
>
> Use this when the user asks about: who in Congress traded a specific stock, what trades a specific member made, recent congressional trading activity, or filings within a date range.
>
> Pair with `get_member_profile` to enrich each result with the trader's party, state, committee assignments, and photo.
>
> Important: This data is *disclosed* trades, with reporting lag up to 45 days. The `disclosure_date` is when the public could first see the trade; the `transaction_date` is when the trade actually happened. For "what did Congress just disclose buying" questions, sort by `disclosure_date`. For "what did Congress hold around a specific market event," filter and sort by `transaction_date`.

**Parameters:**

| Name | Type | Required | Default | Notes |
|---|---|---|---|---|
| `ticker` | string | no | — | Stock symbol filter, e.g. `"AAPL"` |
| `member_name` | string | no | — | Full or partial member name; case-insensitive substring match |
| `bioguide_id` | string | no | — | Member's permanent ID, e.g. `"C001098"`; preferred over `member_name` when known |
| `chamber` | `"senate"` \| `"house"` | no | both | Filter to one chamber |
| `transaction_type` | `"buy"` \| `"sell"` | no | both | Purchases or sales only |
| `owner` | `"Self"` \| `"Spouse"` \| `"Joint"` \| `"Dependent"` | no | all | Who owns the asset |
| `since` | ISO date | no | — | Only records on or after this date (uses `sort_by` field) |
| `until` | ISO date | no | — | Only records on or before this date |
| `min_amount` | number | no | — | Filter to trades with `amount_min` ≥ this value (USD) |
| `sort_by` | `"disclosure_date"` \| `"transaction_date"` | no | `"disclosure_date"` | Field used by `since`/`until` and ordering |
| `sort_order` | `"desc"` \| `"asc"` | no | `"desc"` | Most recent first by default |
| `limit` | integer | no | 50 | Max 500 |

**Response:**

```json
{
  "results": [
    {
      "id": "senate-abc-1",
      "member_name": "Susan M. Collins",
      "bioguide_id": "C001098",
      "chamber": "senate",
      "ticker": "AAPL",
      "asset_name": "Apple Inc.",
      "asset_type": "Stock",
      "transaction_type": "buy",
      "transaction_date": "2026-03-15",
      "disclosure_date": "2026-04-12",
      "reporting_lag_days": 19,
      "amount_range": "$1,001 - $15,000",
      "amount_min": 1001,
      "amount_max": 15000,
      "owner": "Self",
      "report_url": "https://efdsearch.senate.gov/...",
      "data_source": "SENATE_EFD_PTR"
    }
  ],
  "count": 1,
  "has_more": false,
  "query": { "ticker": "AAPL", "limit": 50 }
}
```

**Dependencies on dashboard fixes:**

- Fix #1 (Senate PTR parsing) and Fix #2 (House PTR parsing) — required for any field beyond `member_name`, `chamber`, `disclosure_date`, `report_url`. Without those, this tool returns thin records and the response objects above are aspirational.
- Fix #6 (bioguide_id) — required for the `bioguide_id` filter and field to be useful.

Until those fixes land, this tool returns whatever the runner currently writes (filing pointers with no transaction details). Tool description should be amended at v0.x to set that expectation honestly until v1 quality lands.

**Composition examples:**

```
User: "Who in Congress bought AAPL in the last 30 days?"
Agent calls:
  get_congressional_trades(ticker: "AAPL", transaction_type: "buy", since: "2026-03-29")
Then for each result:
  get_member_profile(bioguide_id: result.bioguide_id)
```

```
User: "What did Senator Collins trade this year?"
Agent calls:
  get_congressional_trades(member_name: "Collins", since: "2026-01-01")
```

---

### Tool 2: `get_insider_transactions`

**Description (agent-facing):**

> Returns executive insider transactions filed on SEC Form 4 — open-market purchases and sales by officers, directors, and 10%-owners of public companies. Each record is one transaction line item from one Form 4 filing.
>
> Use this when the user asks about: insider buying or selling at a specific company, all recent insider activity, transactions by a specific officer, or large insider trades by value.
>
> Form 4 is the fastest insider-trade signal in the public record — must be filed within 2 business days of the trade. The `reporting_lag_days` field tells you how stale the disclosure is.
>
> Note: This tool returns only open-market purchases (`P`) and sales (`S`). It excludes grants, option exercises, tax-withholding sales, and other non-discretionary transactions, because those don't carry the same signal weight that purchase/sale decisions do. If a customer asks for *all* Form 4 transactions including grants, that's not in v1.

**Parameters:**

| Name | Type | Required | Default | Notes |
|---|---|---|---|---|
| `ticker` | string | no | — | Stock symbol filter |
| `company_cik` | string | no | — | SEC CIK number; alternative to ticker |
| `officer_name` | string | no | — | Full or partial officer name; case-insensitive substring match |
| `transaction_type` | `"buy"` \| `"sell"` | no | both | |
| `min_value` | number | no | — | Filter to trades with `total_value` ≥ this (USD) |
| `since` | ISO date | no | — | |
| `until` | ISO date | no | — | |
| `sort_by` | `"disclosure_date"` \| `"transaction_date"` \| `"total_value"` | no | `"disclosure_date"` | |
| `sort_order` | `"desc"` \| `"asc"` | no | `"desc"` | |
| `limit` | integer | no | 50 | Max 500 |

**Response (per record):**

```json
{
  "id": "0000320193-25-000071-2026-03-15-P-5000",
  "ticker": "AAPL",
  "company_name": "Apple Inc.",
  "company_cik": "0000320193",
  "officer_name": "Timothy D. Cook",
  "officer_title": "Chief Executive Officer",
  "is_director": false,
  "transaction_type": "buy",
  "transaction_code": "P",
  "security_title": "Common Stock",
  "transaction_date": "2026-03-15",
  "disclosure_date": "2026-03-17",
  "reporting_lag_days": 2,
  "shares": 5000,
  "price_per_share": 195.50,
  "total_value": 977500,
  "shares_owned_after": 1234567,
  "acquired_disposed": "A",
  "accession_number": "0000320193-25-000071",
  "sec_filing_url": "https://www.sec.gov/Archives/edgar/data/320193/...",
  "data_source": "SEC_EDGAR_FORM4"
}
```

**Dependencies on dashboard fixes:**

This is the tool with the cleanest path to v1 quality. The runner already writes most of the fields needed. Fix #3 (restore lost Form 4 fields) adds `company_name`, `shares_owned_after`, `acquired_disposed`, `security_title`, `is_director`, `reporting_lag_days` — but the tool can ship a useful v0 against the existing schema while those land.

**Composition examples:**

```
User: "Has the CEO of NVDA bought any stock recently?"
Agent calls:
  get_insider_transactions(ticker: "NVDA", transaction_type: "buy", since: "2026-01-01")
  Then filters results client-side by officer_title containing "Chief Executive"
```

```
User: "Show me the biggest insider buys this month."
Agent calls:
  get_insider_transactions(transaction_type: "buy", since: "2026-04-01", sort_by: "total_value", sort_order: "desc", limit: 20)
```

---

### Tool 3: `get_institutional_holdings`

**Description (agent-facing):**

> Returns 13F holdings — quarterly snapshots of equity positions held by institutional investment managers with $100M+ AUM, filed with the SEC. Each record is one (fund, position, quarter) tuple.
>
> Use this when the user asks about: which institutions hold a stock, a fund's portfolio, position changes quarter-over-quarter, or "whale" activity in a specific name.
>
> Reporting lag: up to 45 days after quarter end. A 2026-Q1 filing typically appears in mid-May 2026. The most recent quarter visible always lags real time.
>
> Important: 13F covers institutional managers ≥ $100M but does NOT include short positions, cash, options (with rare exceptions), or non-US-listed equities. It's a snapshot of long equity positions only. For "did the fund increase its AAPL stake?" questions, check the `position_change` field.

**Parameters:**

| Name | Type | Required | Default | Notes |
|---|---|---|---|---|
| `ticker` | string | no | — | Filter to holdings of one stock |
| `cusip` | string | no | — | Alternative to ticker; CUSIP-based match |
| `fund_name` | string | no | — | Full or partial fund name; case-insensitive substring match |
| `fund_cik` | string | no | — | SEC CIK of the fund; preferred when known |
| `quarter` | string (`"YYYY-MM-DD"`) | no | latest | Period ending date, e.g. `"2026-03-31"` |
| `position_change` | `"new"` \| `"increased"` \| `"decreased"` \| `"closed"` \| `"unchanged"` | no | all | Filter to position-change type |
| `min_value` | number | no | — | Filter to positions with `market_value` ≥ this (USD) |
| `sort_by` | `"market_value"` \| `"shares_held"` \| `"shares_change_pct"` | no | `"market_value"` | |
| `sort_order` | `"desc"` \| `"asc"` | no | `"desc"` | |
| `limit` | integer | no | 50 | Max 500 |

**Response (per record):**

```json
{
  "id": "13f-0001067983-037833100-2026-03-31",
  "fund_name": "Berkshire Hathaway Inc.",
  "fund_cik": "0001067983",
  "ticker": "AAPL",
  "issuer_name": "Apple Inc.",
  "cusip": "037833100",
  "share_type": "SH",
  "investment_discretion": "SOLE",
  "shares_held": 905560000,
  "market_value": 197023600000,
  "quarter": "2026-03-31",
  "filing_date": "2026-05-15",
  "position_change": "decreased",
  "shares_change": -10000000,
  "shares_change_pct": -1.09,
  "accession_number": "...",
  "filing_url": "https://www.sec.gov/...",
  "data_source": "SEC_EDGAR_13F"
}
```

**Dependencies on dashboard fixes:**

- Fix #4 (position_change calculation) — required for `position_change`, `shares_change`, `shares_change_pct` filters and fields to be populated.
- Fix #5 (CUSIP→ticker enrichment) — required for `ticker` filter to actually work for any stock not in the hardcoded watchlist (currently only 14 tickers).

Until these land, this tool can answer "what does Berkshire hold" but not "did Berkshire add to its AAPL position" — and ticker-based queries silently return zero for any non-watchlist stock.

**Composition examples:**

```
User: "Which big institutions added to their NVDA positions last quarter?"
Agent calls:
  get_institutional_holdings(ticker: "NVDA", quarter: "2026-03-31", position_change: "increased", sort_by: "market_value")
```

```
User: "Show me Berkshire's biggest holdings."
Agent calls:
  get_institutional_holdings(fund_name: "Berkshire", quarter: "2026-03-31", sort_by: "market_value", limit: 25)
```

---

### Tool 4: `get_member_profile`

**Description (agent-facing):**

> Returns a current member of Congress's profile — name, party, state, chamber, district (House) or class (Senate), committee assignments, social media handles, and photo URL. Sourced from the unitedstates/congress-legislators GitHub repository.
>
> Use this when you have a `bioguide_id` from `get_congressional_trades` and want to enrich the trade with member context (party, state, committees), or when the user asks "who is Senator/Representative X."
>
> Returns at most one record. If neither lookup matches a current member, returns `null` in `result`.
>
> Note: Only currently-serving members are in this dataset. A trade by a former member from years ago will resolve only if that member is still in office.

**Parameters:**

| Name | Type | Required | Default | Notes |
|---|---|---|---|---|
| `bioguide_id` | string | no* | — | Permanent member ID, e.g. `"C001098"`. Preferred when known. |
| `name` | string | no* | — | Full or partial name; if multiple matches, returns null and sets a hint |

*Exactly one of `bioguide_id` or `name` is required.

**Response:**

```json
{
  "result": {
    "bioguide_id": "C001098",
    "name": {
      "full": "Susan M. Collins",
      "first": "Susan",
      "last": "Collins"
    },
    "party": "Republican",
    "state": "ME",
    "chamber": "Senate",
    "district": null,
    "class": 2,
    "term_start": "2021-01-03",
    "term_end": "2027-01-03",
    "terms_served": 5,
    "committees": [
      { "id": "SSAP", "name": "Committee on Appropriations", "title": "Chair" }
    ],
    "social": {
      "twitter": "SenatorCollins",
      "facebook": "senatorsusancollins"
    },
    "photo_url": "https://storage.googleapis.com/.../C001098.jpg"
  },
  "query": { "bioguide_id": "C001098" }
}
```

**Dependencies on dashboard fixes:**

- The `congress/{bioguideId}` Firestore collection from `CONGRESS_DATA_PIPELINE.md` must be populated. Today the local Python catalog bootstrap (Step 1 of that doc) is fair game pre-foundation; the production weekly sync function depends on Blaze tier.
- Without the catalog, this tool returns `null` for everything and is essentially non-functional.

**Composition examples:** See examples in `get_congressional_trades`.

---

### Tool 5: `get_company_filings_summary`

**Description (agent-facing):**

> Returns a summary of all available disclosure activity for a single stock ticker — counts and recency of insider transactions, congressional trades, and institutional holdings updates. The "give me the lay of the land for this ticker" tool.
>
> Use this as the first call when a user asks about a specific stock and you don't know which dataset is relevant. The summary tells you which tool to call next: if `congressional_trades_count` is 0, don't bother with `get_congressional_trades`; if `recent_insider_buy_count` is high, that's where the action is.
>
> This is a meta-tool for navigation. It doesn't return individual trade records — for those, follow up with the appropriate dataset-specific tool.

**Parameters:**

| Name | Type | Required | Default | Notes |
|---|---|---|---|---|
| `ticker` | string | yes | — | Stock symbol |
| `lookback_days` | integer | no | 90 | How far back the "recent" counts look |

**Response:**

```json
{
  "result": {
    "ticker": "NVDA",
    "company_name": "NVIDIA Corporation",
    "company_cik": "0001045810",
    "as_of": "2026-04-28",
    "lookback_days": 90,
    "insider_transactions": {
      "total_count": 47,
      "recent_count": 12,
      "recent_buy_count": 3,
      "recent_sell_count": 9,
      "recent_buy_value_total": 4250000,
      "recent_sell_value_total": 87000000,
      "most_recent_disclosure_date": "2026-04-22"
    },
    "congressional_trades": {
      "total_count": 8,
      "recent_count": 2,
      "recent_buy_count": 2,
      "recent_sell_count": 0,
      "members_involved_recent": ["P000613", "C001127"],
      "most_recent_disclosure_date": "2026-04-15"
    },
    "institutional_holdings": {
      "latest_quarter": "2026-03-31",
      "filer_count_latest_quarter": 1247,
      "total_market_value_latest_quarter": 1850000000000,
      "new_positions_count": 89,
      "increased_positions_count": 412,
      "decreased_positions_count": 528,
      "closed_positions_count": 67
    }
  }
}
```

**Dependencies on dashboard fixes:**

- This tool is essentially aggregations over the other three tools' data. Inherits all their dependencies.
- Fix #5 (CUSIP enrichment) is particularly important — without it, the institutional summary undercounts because most positions don't have a ticker mapped.

**Why this tool exists:**

This is a deliberate hedge against MCP tool sprawl. Without it, every "tell me about NVDA" question forces the agent to either guess which dataset is relevant or call all three. With it, one cheap call gives the agent enough information to choose the right next move. Reduces token usage in long agent conversations significantly.

---

## Composition patterns

These are the multi-tool flows we expect to see in real usage. Tool descriptions should suggest these implicitly via the "Use this when..." and "Pair with..." phrasing.

**Pattern: Stock investigation**

User: "What's happening with TSLA?"

1. `get_company_filings_summary(ticker: "TSLA")` — see at a glance which dataset has activity
2. Based on the summary, call ONE of:
   - `get_insider_transactions(ticker: "TSLA", since: "...")` if insider activity is the story
   - `get_congressional_trades(ticker: "TSLA", since: "...")` if Congress is involved
   - `get_institutional_holdings(ticker: "TSLA", quarter: "latest", position_change: "increased")` if institutional flow is the story

**Pattern: Member investigation**

User: "Did Senator X make any interesting trades?"

1. `get_member_profile(name: "X")` — confirm identity, get bioguide_id
2. `get_congressional_trades(bioguide_id: "...", since: "...", min_amount: 15000)` — non-trivial trades only

**Pattern: Whale tracking**

User: "Did any of the big funds add to NVDA last quarter?"

1. `get_institutional_holdings(ticker: "NVDA", quarter: "latest", position_change: "increased", sort_by: "market_value")` — done in one call

**Pattern: Cross-signal screening**

User: "Find stocks where Congress and insiders are both buying recently."

This is genuinely hard with five tools. The agent has to:

1. `get_congressional_trades(transaction_type: "buy", since: "...", limit: 100)` — get the universe
2. For each unique ticker, `get_insider_transactions(ticker, transaction_type: "buy", since: "...")` to check overlap
3. Synthesize results client-side

This is exactly the case where customer feedback would tell us whether we need a v2 tool like `find_converging_signals` or whether agents are happy doing the multi-step reasoning. Don't preemptively build it.

---

## Out of scope for v1

Things deliberately NOT in v1, with reasoning:

| Excluded | Why |
|---|---|
| Convergence score endpoint | Stays exclusive to the Capital Edge dashboard product. Selling derived signals here pulls in legal complexity (publisher's exemption interpretation) that pure-publisher tools avoid. Per `MCP_PROJECT_HANDOFF.md` legal posture section. |
| Webhook / real-time push | Adds infrastructure complexity (queue, retry, customer endpoint validation) for a feature that maybe 5% of v1 customers need. Add when there's demand. |
| Bulk download endpoints | Same logic. Pagination handles 99% of "I need a lot of data" use cases. |
| Form 144, 13D/G, 8-K, USAspending, FRED, etc. | Listed in `C:\CapitalEdge\DATA_SOURCES_ROADMAP.md` as v2+ expansion. Each requires scraper work in the dashboard project before it can be a tool here. |
| Convergence-style derived ranking | Same reason as the convergence score. Stays out. |
| Earnings transcripts / sentiment | Requires Finnhub paid tier for transcripts. Defer. |
| International data (Canada SEDI, UK RNS, etc.) | ToS / licensing issues per the handoff. Maybe never, definitely not v1. |

---

## v2 candidates

Listed for awareness — not committed work. Surface from real customer asks first.

- `find_committee_relevant_trades` — congressional trades weighted by committee jurisdiction over the company's sector (e.g., Senate Armed Services member buying Raytheon scores higher than Ag Committee member buying Raytheon). Depends on committee assignments being in `congress/{bioguideId}` collection (already speced in `CONGRESS_DATA_PIPELINE.md`). Real moat-deepener if pursued — no competitor has this.
- `get_form_144_filings` — proposed insider sales, 5–10 days faster than Form 4. Requires dashboard project to build the Form 144 scraper.
- `get_8k_material_events` — material company events. Requires dashboard project to build the 8-K parser.
- `get_federal_contracts` — USAspending contract awards, useful for narrative ("DoD contract three days after Senate Armed Services member buys"). Requires dashboard project to wire USAspending API.
- `find_converging_signals` — programmatic cross-dataset screening. Build only if real customer use shows agents struggling with the multi-step composition pattern.

---

## Open questions for review

These need Greg's input or further thought before tools get implemented.

1. **Tool naming convention — `get_X` vs other verbs?** Going with `get_*` for everything because all v1 tools are read-only. v2 may introduce `find_*` (multi-dataset screens) and `compare_*` (diff two periods). Consistent verb-first prefix per category.

2. **Limit defaults — 50 too small?** Considered 100. 50 is friendlier for smaller agent contexts but customers running big screens will paginate more often. Either is defensible. Opting 50 for v1; revisit at customer feedback.

3. **Should `get_member_profile` accept multiple bioguide_ids in one call?** Saves tool calls when an agent has 10 trades to enrich. Trade-off: response shape becomes a list, breaks the "single result" pattern. Lean toward keeping it one-at-a-time in v1 for clarity, add `get_member_profiles` (plural) in v2 if customers ask.

4. **Cursor-based pagination in v1 or v1.1?** Cursor is more correct for Firestore but adds implementation complexity. v1 ships with `limit` only, knowing that anyone wanting more than 500 records is a power user who'll tolerate v1.1 pagination. Check that with first beta customers.

5. **`get_company_filings_summary` accuracy guarantees.** This tool aggregates counts. If Firestore is missing recent filings (between scraper runs), the counts under-report. Should we surface a `data_freshness` field? Yes — recommend including `most_recent_disclosure_date` per dataset (already in the response) and `data_as_of` at the top level so the agent can warn the user about staleness.

---

## Changelog

- 2026-04-28: Initial draft. Five-tool surface designed: `get_congressional_trades`, `get_insider_transactions`, `get_institutional_holdings`, `get_member_profile`, `get_company_filings_summary`.
