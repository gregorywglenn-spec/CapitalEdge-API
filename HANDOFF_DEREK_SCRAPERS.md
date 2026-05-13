# KeyVex Scrapers — Day 8 & 9 Additions (Port Handoff for Derek)

**Purpose:** This is the catalog of scrapers added to `gregorywglenn-spec/Keyvex-API` over the May 11–12, 2026 push (Day 8 + Day 9). It exists so Derek's Claude can port them into the `C:\CapitalEdge` codebase / `capital-edge-d5038` Firebase project without having to reverse-engineer each one.

For each scraper this doc gives you:
- File path in the KeyVex repo (`src/scrapers/*.ts`)
- MCP tool name (the agent-facing surface)
- Source URL + auth requirements
- Cron schedule + cadence
- Output Firestore collection
- Idempotent doc-ID pattern (critical for re-run safety)
- Function summary
- Key Hard Lessons from the build (the non-obvious traps)

All scrapers are TypeScript on Node 20+. They share a few common patterns:
- HTTP via global `fetch` (no `axios`)
- User-Agent default: `"KeyVexMCP/0.1 contact@keyvex.com"` — change to match your project
- Rate-limit sleeps between requests (150-250ms typical)
- `merge: true` upserts on every Firestore write so re-runs are idempotent

The MCP-server side wires each scraper into:
1. `src/firestore.ts` — `save*` + `query*` functions
2. `src/tools/*.ts` — MCP tool definition + handler
3. `src/tools/index.ts` — tool registry
4. `src/scrape.ts` — CLI command for manual runs
5. `functions/src/index.ts` — `onSchedule` Cloud Function

If Derek's project just wants the SCRAPER part (no MCP surface), all 21 are independent modules that can be lifted into any TS codebase that has `firebase-admin` available.

---

## Quick-reference table

| # | Scraper | File | Source | Cadence | Collection |
|---|---|---|---|---|---|
| 1 | FEC Candidates | `fec.ts` | api.open.fec.gov | Weekly Sun | `fec_candidates` |
| 2 | FEC Committees | `fec.ts` | api.open.fec.gov | Weekly Sun | `fec_committees` |
| 3 | Schedule TO (Tender Offers) | `tender-offers.ts` | EDGAR FTS | Daily | `tender_offers` |
| 4 | Bills | `congress-legislation.ts` | api.congress.gov | Daily | `bills` |
| 5 | House Roll-Call Votes | `congress-legislation.ts` | api.congress.gov | Daily | `roll_call_votes` |
| 6 | FINRA OTC Weekly | `finra-otc.ts` | api.finra.org | Weekly Sun | `otc_market_weekly` |
| 7 | Form D (Private Placements) | `form-d.ts` | EDGAR FTS | Daily | `private_placements` |
| 8 | SEC + DOJ + CFTC + OCC + FDIC Enforcement | `enforcement-actions.ts` | mixed | Daily | `enforcement_actions` |
| 9 | Form N-PORT (Mutual Funds) | `nport.ts` | EDGAR FTS | Daily | `nport_filings` |
| 10 | Form S-1 / S-3 (Registrations) | `registration-statements.ts` | EDGAR FTS | Daily | `registration_statements` |
| 11 | OFAC SDN | `ofac-sdn.ts` | sanctionslistservice.ofac.treas.gov | Daily | `ofac_sdn` |
| 12 | Federal Register | `federal-register.ts` | federalregister.gov | Daily | `federal_register_documents` |
| 13 | DEF 14A Proxy Filings | `proxy.ts` | EDGAR submissions + FTS | Daily 7:15 AM | `proxy_filings` |
| 14 | Treasury Auctions | `treasury-auctions.ts` | api.fiscaldata.treasury.gov | Daily 7:30 AM | `treasury_auctions` |
| 15 | BLS Economic Indicators | `bls.ts` | api.bls.gov | Daily 8:45 AM | `economic_indicators` |
| 16 | HHS-OIG Exclusions (LEIE) | `oig-exclusions.ts` | oig.hhs.gov | Monthly 5th | `oig_exclusions` |
| 17 | CFPB Consumer Complaints | `cfpb-complaints.ts` | consumerfinance.gov | Daily 8 AM | `consumer_complaints` |
| 18 | XBRL Fundamentals | `xbrl.ts` | data.sec.gov | Weekly Sun 4 AM | `xbrl_fundamentals` |
| 19 | FRED Economic Data | `fred.ts` | api.stlouisfed.org | Daily 9 AM | `economic_indicators` (shared w/ BLS) |

---

## DAY 8 ADDITIONS (May 11)

### 1. FEC Candidates — `src/scrapers/fec.ts` → `scrapeFecCandidates`

- **Function:** Pulls every federally-registered candidate (House, Senate, President) for the current 2-year cycle from FEC's bulk endpoint. ~30K active filings.
- **MCP tool:** `get_fec_candidate_profile`
- **Source:** `https://api.open.fec.gov/v1/candidates/` (FEC OpenFEC v1 API)
- **Auth:** REQUIRES API key. Free, register at `https://api.open.fec.gov/developers/` (the `DEMO_KEY` works for 1000 req/hr — sufficient for daily refresh). Set env var `FEC_API_KEY`. The api.data.gov gateway is shared across FEC + Congress.gov, so the 1000/hr limit is shared across both keys if you use the same one.
- **Cadence:** Weekly (Sundays). FEC candidate data doesn't change daily.
- **Idempotent key:** `candidate_id` (FEC's permanent identifier like `H8AZ02193`).
- **Hard lesson:** FEC API returns 502s under heavy load — bake retry-with-backoff into the fetch helper. The retry was added in v0.19.1.
- **Provenance:** `fec_url` field set to `https://www.fec.gov/data/candidate/{candidate_id}/`.

### 2. FEC Committees — same file → `scrapeFecCommittees`

- **Function:** Pulls every FEC-registered committee (PACs, principal campaign committees, super PACs, party committees, leadership PACs). The link table between candidates and money flow. Includes `candidate_ids[]` array for the committees that support specific candidates.
- **MCP tool:** Same as candidates (`get_fec_candidate_profile` with `include_committees: true`).
- **Source:** `https://api.open.fec.gov/v1/committees/`
- **Auth:** Same FEC_API_KEY.
- **Cadence:** Weekly Sundays.
- **Idempotent key:** `committee_id` (e.g., `C00603533`).
- **Provenance:** `fec_url` → `https://www.fec.gov/data/committee/{committee_id}/`.

### 3. Schedule TO (Tender Offers) — `src/scrapers/tender-offers.ts`

- **Function:** SEC Schedule TO filings — third-party tender offers (M&A bids) + issuer buybacks. Live-feed scrape via EDGAR full-text search. v1A is metadata-only (filing date, filer, target ticker, accession, URL); body parse is v1.1.
- **MCP tool:** `get_tender_offers`
- **Source:** `https://efts.sec.gov/LATEST/search-index?forms=SCHEDULE+TO`
- **Auth:** SEC requires a real User-Agent (`KeyVexMCP/0.1 contact@keyvex.com` works).
- **Cadence:** Daily.
- **Idempotent key:** `accession_number` (e.g., `0001193125-26-014344`).
- **Hard lesson:** Some Schedule TO filings ship with target_ticker omitted from the structured metadata; tool description warns agents.

### 4. Bills — `src/scrapers/congress-legislation.ts` → `scrapeBills`

- **Function:** Congressional bills + resolutions across all 8 types (HR, S, HJRES, SJRES, HCONRES, SCONRES, HRES, SRES). Pulls latest action date, sponsor, title, status, full text URL.
- **MCP tool:** `get_bills`
- **Source:** `https://api.congress.gov/v3/bill/`
- **Auth:** REQUIRES `CONGRESS_API_KEY` (free via api.congress.gov). Shared rate limit with api.data.gov gateway.
- **Cadence:** Daily.
- **Idempotent key:** `bill_id` like `119-HR-134`.

### 5. House Roll-Call Votes — same file → `scrapeRollCallVotes`

- **Function:** Every roll-call vote held in the US House. v1A is HOUSE ONLY — Senate roll-calls are on a different endpoint (senate.gov XML) and are a v1.1 polish item.
- **MCP tool:** `get_roll_call_votes`
- **Source:** `https://api.congress.gov/v3/house-vote/{congress}/{session}/{voteNumber}` (or list endpoint)
- **Auth:** Same CONGRESS_API_KEY.
- **Cadence:** Daily.
- **Idempotent key:** `vote_id` like `house-119-1-362`.

### 6. FINRA OTC Weekly — `src/scrapers/finra-otc.ts`

- **Function:** Weekly off-exchange (ATS dark-pool) volume. Each row = one ticker × one trading venue × one week. ~250K records per fully-published week.
- **MCP tool:** `get_otc_market_weekly`
- **Source:** `https://api.finra.org/data/group/otcMarket/name/weeklySummary` (POST + JSON body)
- **Auth:** None, but FINRA-imposed PARTITION KEYS: `weekStartDate` AND `tierIdentifier` MUST both be in `compareFilters` with `compareType: "EQUAL"` before sortFields is honored. Tiers must be iterated explicitly: T1, T2, OTCE.
- **Cadence:** Weekly Sundays.
- **Idempotent key:** Composite `{weekStart}-{symbol||"_FIRM_TOTAL"}-{mpid}-{summaryType}`.
- **Provenance:** `finra_source_url` → either `otctransparency.finra.org/.../AtsIssueData?issueSymbol=...` (per-issue) or `.../AtsData?mpid=...` (firm-level when symbol is empty for ATS_W_VOL_STATS rows).
- **Hard lesson:** Some rows (ATS_W_VOL_STATS) have an empty `issueSymbolIdentifier` because they're firm-level rollups, not per-issue. Use a `_FIRM_TOTAL` sentinel in the doc ID to avoid collisions.

### 7. Form D (Private Placements) — `src/scrapers/form-d.ts`

- **Function:** SEC Form D filings — Regulation D exempt-offering notices. VC raises, PE funds, real-estate syndicates. v1A metadata only.
- **MCP tool:** `get_private_placements`
- **Source:** `https://efts.sec.gov/LATEST/search-index?forms=D`
- **Auth:** SEC User-Agent.
- **Cadence:** Daily.
- **Idempotent key:** `filing_uuid` (composite of `accession_number` + filer CIK).

### 8. Enforcement Actions — `src/scrapers/enforcement-actions.ts`

- **Function:** Five-regulator press-release feed: SEC, DOJ, CFTC, OCC, FDIC. v1A metadata + teaser (no full body extraction).
- **MCP tool:** `get_enforcement_actions` (single tool, `source` enum filter)
- **Sources & auth (each branch in the same module):**
  - **SEC** — RSS at `https://www.sec.gov/news/pressreleases.rss`. SEC User-Agent.
  - **DOJ** — JSON API at `https://www.justice.gov/api/v1/press_releases.json`. No auth. Default sort is OLDEST-FIRST (counterintuitive); set `sort=date&direction=DESC`.
  - **CFTC** — NO RSS / NO JSON API. HTML index scrape at `https://www.cftc.gov/PressRoom/PressReleases`. Each row has `<time datetime="ISO">` + `<a href="/PressRoom/PressReleases/{id}-{yr}">title</a>`. Use `cheerio` to parse. Browser-style User-Agent works fine.
  - **OCC** — NO RSS. HTML at `https://www.occ.treas.gov/news-issuances/news-releases/{year}/index-news-releases-{year}.html`. **Requires browser-style User-Agent (KeyVexMCP/0.1 gets 302-redirected).** Use `Mozilla/5.0 (compatible; KeyVexBot/1.0; +https://...)` or similar. Filter to news releases only (skip bulletins).
  - **FDIC** — NO RSS. HTML at `https://www.fdic.gov/news/press-releases`. Same Drupal-fronted CDN that needs browser-style User-Agent. Structure: `<article class="node--news">` with `<time datetime="ISO">` + `<p class="news-title"><a href="..." rel="bookmark">title</a></p>`.
- **Cadence:** Daily 6:35 AM ET (all 5 sources in one combined Cloud Function).
- **Idempotent keys:**
  - `sec-{guid-or-slug}` for SEC RSS items
  - `doj-{uuid}` for DOJ JSON items
  - `cftc-{release-number}` (e.g., `cftc-9230-26`)
  - `occ-{slug}` (e.g., `occ-nr-occ-2026-36`)
  - `fdic-{slug}` (slug from the URL path)
- **Hard lesson 1:** OCC + FDIC reject bare-bot User-Agent strings via CloudFront. Switching to browser-style UA fixes it.
- **Hard lesson 2:** CFTC has no RSS — the HTML scrape is brittle but cheerio + the documented row structure has held up reliably.

### 9. Form N-PORT — `src/scrapers/nport.ts`

- **Function:** Mutual fund / ETF / closed-end fund monthly portfolio holdings reports. v1A is filing METADATA — per-fund-per-month metadata only; holdings detail extraction is v1.1.
- **MCP tool:** `get_nport_filings`
- **Source:** EDGAR FTS `forms=NPORT-P`
- **Auth:** SEC User-Agent.
- **Cadence:** Daily.
- **Idempotent key:** `accession_number`.

### 10. Form S-1 / S-3 (Registration Statements) — `src/scrapers/registration-statements.ts`

- **Function:** IPO + shelf-registration filings. Covers S-1, S-1/A (amendments), S-3, S-3/A.
- **MCP tool:** `get_registration_statements`
- **Source:** EDGAR FTS with form-filter rotated across the 4 form codes.
- **Auth:** SEC User-Agent.
- **Cadence:** Daily.
- **Idempotent key:** `accession_number`.
- **Hard lesson:** Same XSL-prefix issue as other SEC form scrapers — strip `^xsl[A-Z0-9]+/` from `primaryDocument` before fetching, otherwise you get HTML-rendered output instead of raw XML.

### 11. OFAC SDN List — `src/scrapers/ofac-sdn.ts`

- **Function:** US Treasury Office of Foreign Assets Control "Specially Designated Nationals" sanctions list. Single-file CSV download. ~19K entries (~5.5 MB).
- **MCP tool:** `get_ofac_sdn`
- **Source:** `https://sanctionslistservice.ofac.treas.gov/api/publicationpreview/exports/sdn.csv`
- **Auth:** None.
- **Cadence:** Daily 6:50 AM ET.
- **Idempotent key:** `ent_num` (OFAC's permanent entity number).
- **Hard lesson 1:** OFAC uses `-0-` as the empty-field sentinel. Normalize to `""` on ingest.
- **Hard lesson 2:** CSV uses CRLF line endings + quoted-field state machine (commas inside `"…"` fields). Use the state-machine parser (already in `ofac-sdn.ts`), not naive `split(',')`.
- **Provenance:** `ofac_url` → `https://sanctionssearch.ofac.treas.gov/Details.aspx?id={ent_num}`.

### 12. Federal Register — `src/scrapers/federal-register.ts`

- **Function:** Federal Register documents — proposed rules, final rules, notices, presidential documents. The official daily publication of US federal regulatory actions.
- **MCP tool:** `get_federal_register_documents`
- **Source:** `https://www.federalregister.gov/api/v1/documents.json` (public API, no auth)
- **Cadence:** Daily.
- **Idempotent key:** `document_number` (federalregister.gov's permanent ID, e.g., `2026-09385`).

---

## DAY 9 ADDITIONS (May 12, today's marathon)

### 13. DEF 14A Proxy Filings — `src/scrapers/proxy.ts`

- **Function:** SEC Schedule 14A proxy statements — annual shareholder-meeting filings carrying exec compensation tables, board nominations, shareholder proposals, auditor info. Captures the full DEF 14A family: DEF 14A (annual), DEFA14A (additional materials), DEFM14A (merger-related), DEFR14A (revised).
- **MCP tool:** `get_proxy_filings`
- **Source:** EDGAR submissions API per-ticker + FTS for live-feed
- **Auth:** SEC User-Agent.
- **Cadence:** Daily 7:15 AM ET, 2-day lookback window.
- **Idempotent key:** `accession_number`.
- **Convenience fields derived from filing_type:** `is_merger_related` (DEFM14A), `is_amendment` (DEFR14A), `is_additional_materials` (DEFA14A).
- **Hard lesson:** FTS doesn't support wildcard form matching — must iterate each of the 4 form codes (`DEF+14A`, `DEFA14A`, `DEFM14A`, `DEFR14A`) and dedup by accession. Encode space as `+` or `%20`.

### 14. Treasury Auctions — `src/scrapers/treasury-auctions.ts`

- **Function:** US Treasury debt auction records — Bills (≤1yr), Notes (2-10yr), Bonds (20-30yr), TIPS (inflation-protected), FRNs (floating-rate). Captures pre-auction announcements AND post-auction results (bid-to-cover ratio, yields, bidder breakdowns, SOMA holdings).
- **MCP tool:** `get_treasury_auctions`
- **Source:** `https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/auctions_query` (REST JSON, no auth)
- **Cadence:** Daily 7:30 AM ET, 14-day lookback.
- **Idempotent key:** `{cusip}-{auction_date}`.
- **Key signal fields:** `bid_to_cover_ratio` (demand metric), `soma_holdings` + `soma_included` (Fed QE/QT activity), direct/indirect/primary-dealer bidder breakdowns.
- **Hard lesson:** Treasury's API serializes everything as STRINGS — coerce to number with `toNum()` and treat literal string `"null"` as null. Also: Records have a two-stage lifecycle (announcement → results); idempotent saves with `merge:true` overwrite cleanly when results publish.

### 15. BLS Economic Indicators — `src/scrapers/bls.ts`

- **Function:** Bureau of Labor Statistics curated 20-series watchlist covering employment (unemployment U-3/U-6, payrolls, labor force participation), wages (ECI, average hourly earnings), inflation (CPI all items / core / food / energy / housing + PPI), productivity (nonfarm productivity, unit labor costs).
- **MCP tool:** `get_economic_indicators` (with `source: "bls"`)
- **Source:** `https://api.bls.gov/publicAPI/v2/timeseries/data/` (POST JSON)
- **Auth:** Optional. Free tier without key = 50 req/day. With `BLS_API_KEY` env var = 500/day. One scheduler run is one POST, so the free tier is fine.
- **Cadence:** Daily 8:45 AM ET, 2-year lookback.
- **Idempotent key:** `{series_id}-{period}` (e.g., `LNS14000000-2026M04`).
- **Provenance:** `source_url` → `https://data.bls.gov/timeseries/{series_id}`.
- **Schema note:** v0.39.0 renamed `bls_source_url` → `source_url` for cross-source consistency with FRED (see #19).

### 16. HHS-OIG Exclusions (LEIE) — `src/scrapers/oig-exclusions.ts`

- **Function:** Federal healthcare "List of Excluded Individuals/Entities" — anyone barred from billing Medicare, Medicaid, or any federal healthcare program. ~83K entries (~15 MB CSV).
- **MCP tool:** `get_oig_exclusions`
- **Source:** `https://oig.hhs.gov/exclusions/downloadables/UPDATED.csv` (single-file CSV download)
- **Auth:** None.
- **Cadence:** Monthly, 5th of month at 7 AM ET (OIG publishes monthly updates in the first few days).
- **Idempotent key:** `oig-{NPI}` when NPI is populated and valid 10-digit; else `oig-{SHA1(name+business+date+state+zip)}` 12-char truncated hash.
- **Schema:** 18 fixed columns from OIG (LASTNAME, FIRSTNAME, MIDNAME, BUSNAME, GENERAL category, SPECIALTY, UPIN, NPI, DOB, ADDRESS, CITY, STATE, ZIP, EXCLTYPE statute code, EXCLDATE, REINDATE, WAIVERDATE, WVRSTATE).
- **Hard lesson:** Date format is `YYYYMMDD` raw; sentinel `00000000` means empty. Always normalize to ISO `YYYY-MM-DD` or null. Also: OIG only ships CURRENTLY-excluded entries — reinstated providers are removed from the file. `is_reinstated=true` filter will return ~0 in v1A.

### 17. CFPB Consumer Complaints — `src/scrapers/cfpb-complaints.ts`

- **Function:** Consumer Financial Protection Bureau complaint database. ~10K complaints/day across banks, credit reporting, mortgage servicers, debt collectors, fintech, crypto. Complaint volume is a leading indicator of CFPB/OCC/FDIC enforcement.
- **MCP tool:** `get_consumer_complaints`
- **Source:** `https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/` (Elasticsearch-style)
- **Auth:** None, but requires browser-style User-Agent.
- **Cadence:** Daily 8 AM ET. v1A: rolling 2-day window, capped at 2000 most-recent records per run (full historical = 5M+ records, out of scope).
- **Idempotent key:** `complaint_id` (CFPB's primary key).
- **Pagination:** `frm` (from) + `size` parameters, flat JSON array return (no envelope), sort `created_date_desc`.

### 18. XBRL Fundamentals — `src/scrapers/xbrl.ts` ⭐ THE BIG ONE

- **Function:** SEC EDGAR XBRL-tagged financial fundamentals from 10-K + 10-Q filings. Income statement / balance sheet / cash flow line items per company per quarter. Curated 40-concept watchlist covering Revenues, NetIncomeLoss, Assets, Liabilities, StockholdersEquity, EPS basic/diluted, share counts, cash flows, etc.
- **MCP tool:** `get_fundamentals`
- **Source:** `https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json` (one call returns ALL tagged observations for a company across every 10-K + 10-Q they've ever filed)
- **Auth:** SEC User-Agent.
- **Cadence:** Weekly Sundays 4 AM ET. Streaming saver in `scrapeAndSaveXbrlStreaming` (saves per-company to keep peak memory <1 GiB).
- **Universe:** Curated 132-ticker watchlist in `src/data/xbrl-universe.ts` (S&P-100 + cross-source-relevant additions: defense, banks, healthcare, energy, big tech, autos). 130 tickers successfully ingest; BRK.B + MMC skip per known issues.
- **Idempotent key:** `{cikPadded}-{concept}-{period_end}-{form-with-slash-sanitized}-{period_start || "pit"}`.
- **Three critical Hard Lessons (CAPTURED IN CLAUDE.md, MUST KNOW BEFORE PORTING):**

  1. **doc-ID MUST include `period_start`.** A 10-K filing tags BOTH the FY cumulative observation (start=Oct prior year, end=Sept) AND the Q4 standalone (start=Jul, end=Sept) under the SAME `concept` + `period_end` + `form`. Without `period_start` in the ID, one overwrites the other. Agents querying for "Revenues for FY2018" can get the wrong number depending on which observation happened to land last.

  2. **`cikToTicker` reverse lookup picks preferred-share series via last-write-wins.** SEC's `company_tickers.json` has multiple entries per CIK for companies with preferred series (JPM has JPM common + JPM-PA/PC/PD/PG/PM preferred). The LAST ticker in the catalog (often a preferred series like JPM-PM) clobbers the common ticker. Records end up stored with `ticker="JPM-PM"` and agents querying `ticker:"JPM"` find nothing. **Fix:** callers of `scrapeXbrlByCik` MUST pass a `tickerOverride` parameter that preserves the INPUT ticker. `scrapeXbrlByTicker` was updated to always pass-through the input.

  3. **SEC `company_tickers.json` strips dots from class-share tickers.** BRK.B is stored as "BRKB". BF.B is "BFB". HEI.A is "HEIA". Naive ticker lookup misses these. **Fix:** `getTickerInfo` tries direct lookup → strip dots → strip slashes, in that order.

- **Volume:** 593,461 observations scraped across 130 companies; 323,590 unique docs preserved (the ~46% collision is EXPECTED — each company refiles prior-period comparatives in every subsequent 10-K with a different accession number; merge:true keeps the most-recent restatement, which is the canonical value).
- **Universe dedup:** GOOG was removed from the universe because GOOGL covers the same CIK 1652044 — running both clobbers each other.

### 19. FRED Economic Data — `src/scrapers/fred.ts`

- **Function:** Federal Reserve Economic Data (St. Louis Fed). Curated 30-series watchlist: rates (Fed Funds DFF, 2Y/10Y/30Y Treasury, 10Y-2Y spread, 30yr mortgage, AAA/BAA), GDP (nominal/real/growth), activity (industrial production, housing starts, retail sales), inflation (PCE, Core PCE, 5Y/10Y breakevens), employment (UNRATE/PAYEMS — FRED republish of BLS + JOLTS + jobless claims), money (M2, Fed total assets WALCL, overnight reverse repo), debt (federal debt, Treasury general account), trade (trade balance, broad dollar index), sentiment (U Michigan).
- **MCP tool:** `get_economic_indicators` (with `source: "fred"`) — SHARED with BLS, same tool extended to two sources
- **Source:** `https://api.stlouisfed.org/fred/series/observations` (V1 API; V2 is bulk-by-release which we don't use)
- **Auth:** REQUIRED `FRED_API_KEY` env var (free registration at `https://fredaccount.stlouisfed.org/apikeys`).
- **Cadence:** Daily 9 AM ET, 5-year lookback.
- **Idempotent key:** `{series_id}-{period}` (e.g., `DGS10-2026D131` for daily, `UNRATE-2026M04` for monthly).
- **Period labels** (KeyVex convention, fixed-width so lex-sort = chronological):
  - `{YYYY}M{MM}` monthly (e.g., `2026M04`)
  - `{YYYY}Q{QQ}` quarterly (e.g., `2026Q01`)
  - `{YYYY}A01` annual
  - `{YYYY}W{WW}` weekly (ISO week number)
  - `{YYYY}D{DDD}` daily (day-of-year, zero-padded to 3 digits)
- **Hard lesson 1:** AAA and BAA are MONTHLY in FRED, not daily (despite my initial catalog labeling). Got 64 obs over 5 years = monthly. Fixed in the catalog.
- **Hard lesson 2:** FRED uses `"."` as the missing-value sentinel for daily series (when markets close on holidays). Treat `"."` as `null`.
- **Provenance:** `source_url` → `https://fred.stlouisfed.org/series/{series_id}`.

---

## Companion (not a scraper, but a major tool)

### Unified Search — `src/tools/unified-search.ts` (TOOL, NOT SCRAPER)

Cross-collection fan-out tool that queries 12 collections in parallel for ticker, 10 collections for company_cik, 2 for bioguide_id, 1 for recipient_uei. Uses `Promise.allSettled` so one slow source doesn't block the rest. Single MCP call replaces 6-10 sequential tool calls for "tell me everything about X" questions.

- **Identifier coverage:**
  - `ticker` → 12 collections (insider_trades, institutional_holdings, congressional_trades, planned_insider_sales, initial_ownership_baselines, activist_ownership, material_events, proxy_filings, xbrl_fundamentals, tender_offers, registration_statements, otc_market_weekly)
  - `bioguide_id` → 2 collections (congressional_trades, annual_financial_disclosures)
  - `company_cik` → 10 collections (insider_trades, planned_insider_sales, initial_ownership_baselines, activist_ownership, material_events, proxy_filings, xbrl_fundamentals, private_placements, registration_statements, nport_filings)
  - `recipient_uei` → 1 collection (federal_contracts)

If Derek's project also wants a unified_search equivalent: the adapter pattern in `src/tools/unified-search.ts` is dead simple — array of `{name, call: (q, limit) => promise | null}` adapters, each returning null when the identifier doesn't apply.

---

## Stable patterns shared across all scrapers

These are conventions that hold across all 19 scrapers. Lifting them into Derek's codebase one-time will pay back across the whole port.

1. **Rate-limit helper:** `const sleep = (ms) => new Promise(r => setTimeout(r, ms))`. Call before every HTTP request. SEC and EDGAR want ≥150ms between requests; FINRA wants ≥200ms; FRED is unspecified but 200ms is polite.

2. **User-Agent:** SEC's EDGAR + EDGAR FTS + EDGAR submissions API + data.sec.gov ALL require an identifying User-Agent. They block bare bots. Default to `"KeyVexMCP/0.1 contact@keyvex.com"` style. CFPB + OCC + FDIC + Federal Register need browser-style UAs (CloudFront challenges otherwise).

3. **`fast-xml-parser` settings:** When parsing SEC XML (Form 4, Form 144, Form 3, 13D/G, XBRL): ALWAYS set `parseTagValue: false` AND `parseAttributeValue: false`. Otherwise numeric-looking strings (CUSIPs, ticker codes) get auto-coerced to numbers and corrupted.

4. **Idempotent saves:** Every `save*` function uses `batch.set(doc, data, { merge: true })`. Batch size 400 (Firestore limit is 500). Re-runs upsert cleanly. Doc IDs are deterministic from source data so the same observation lands at the same doc ID every time.

5. **Stub mode:** `isStubMode()` checks for absence of `secrets/service-account.json`. Each `save*` throws if called in stub mode; each `query*` returns empty results. Useful for local dev without credentials.

6. **Cloud Function deployment:** Each scraper has an `onSchedule` Cloud Function in `functions/src/index.ts`. Memory typically 512 MiB; XBRL + OIG bump to 1 GiB. Timeout 9-30 min. `retryCount: 0` because we have daily retries via the next cron tick.

7. **Service-key authentication on Cloud Functions:** `firestore.ts` auto-detects GCP runtime via `process.env.K_SERVICE`/`FUNCTION_TARGET`/`FUNCTION_NAME` and uses `applicationDefault()` instead of the local service-account.json. Mirror this if Derek's project mixes local + Cloud Function deployment.

8. **Secrets in Cloud Functions:** API keys (MCP_API_KEY, FEC_API_KEY, CONGRESS_API_KEY, BLS_API_KEY, FRED_API_KEY) use `defineSecret` from `firebase-functions/params` + `.value()` at runtime. Set via `firebase functions:secrets:set NAME --data-file=-` piping the value from stdin.

---

## What's NOT included in this handoff

The MCP-server side (HTTP transport, tool registry, server-setup) is specific to KeyVex's product positioning. Derek's project doesn't need it — the scrapers are the data layer; the dashboard reads from Firestore directly.

The unified_search tool is similarly product-specific. Useful pattern but only relevant if Derek's project wants a federated query surface for its own UI/agent.

The CLAUDE.md project memory file has additional context but it's KeyVex-specific operational notes — not needed for the scraper port.

---

**Questions Derek's Claude might have:**

- **Q:** Why a separate `xbrl-universe.ts` file vs. inline list?
- **A:** Universe membership is a curation decision that changes quarterly. Isolating it makes the dependency clear; multiple files (scrape.ts, functions/src/index.ts) import the same constant.

- **Q:** Why merge:true everywhere?
- **A:** Idempotency. Same scraper running twice produces the same doc IDs; merge:true upserts cleanly without duplicates.

- **Q:** Why composite Firestore indexes per query shape?
- **A:** Firestore requires composite indexes for any query combining ≥2 fields. KeyVex's `firestore.indexes.json` has ~80 indexes total. The cost is paid at write time (negligible) for sub-second read times on cross-cutting queries.

- **Q:** Should Derek's project preserve KeyVex's "source_url" provenance field?
- **A:** Strongly recommend yes. Every record traceable to its source-of-record filing makes compliance / audit / agent-trust work cleanly. Costs nothing at scrape time.

---

**Generated:** May 12, 2026 (Day 9 LATE NIGHT). KeyVex repo: https://github.com/gregorywglenn-spec/Keyvex-API at commit `8d576bb`. Reach out via `contact@keyvex.com` if any of this needs clarification.
