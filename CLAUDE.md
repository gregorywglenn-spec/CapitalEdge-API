# Capital Edge MCP — Project Intelligence File

This is the day-1 reading for any AI agent (Claude or otherwise) opening this project cold. Read this first, then follow the cross-references at the bottom for deeper context.

## Hard Lessons — Read This First

- **Tell the ugly truth.** Especially about whether something will actually work. The instinct to confirm what's flattering is the failure mode. Push back, run actual diagnostics, report the true picture even when it complicates the plan. Tonight that rule caught a real divergence between the on-disk handoff and Greg's verbal direction; flagging it surfaced a real architectural decision instead of plowing past it.
- **Don't quote in weeks what Greg ships in hours.** He builds dramatically faster than institutional time estimates assume. Six and a half hours from "let's set up Cowork for this" to "76 real Form 4 trades in Firestore via a server we built and a repo on GitHub." Calibrate to that pace.
- **Foundation before features. Always.** No exceptions. Same rule from the Capital Edge claude.md, applies here too.
- **Don't make Greg fight the same UI twice.** When a placeholder like `YOUR-USERNAME` showed up in instructions, he typed it literally — costing two failed `git push` cycles. Always offer to fill in known values directly, or ask for them up front.
- **Don't conflate "data only" with "no transformations."** Pure-publisher posture (this project) doesn't surface derived intelligence (signal_weight, convergence scores, ranks). It still does normalization (CUSIP→ticker, date format, field cleanup). Greg explicitly locked the line: data only, no scores, no opinions, ever.
- **Project boundary discipline is real.** This project does NOT write to Capital Edge's Firestore collections. All scraper changes for this project's data happen in *this* codebase, against *this* project's Firebase. Capital Edge is owned by Derek (informal partner) and gets touched only via the data requirements doc as a peer FYI, never as a dependency.
- **Don't trust XML parsers with CUSIPs.** fast-xml-parser auto-parses numeric-looking strings as numbers by default. CUSIPs like `92343E102` (VeriSign) look like scientific notation and get destroyed (became `9.2343e+102`). CUSIPs with leading zeros (`037833100` → `37833100`) lose the prefix. Always set `parseTagValue: false` AND `parseAttributeValue: false`. The first 13F run silently mangled half the CUSIPs before this was caught.
- **13F filings have sub-account dupes — always aggregate by CUSIP.** Large institutional managers (Berkshire, BlackRock, Vanguard) report each security multiple times across internal "managers" / sub-accounts. Berkshire's 110-row 13F XML reduces to 42 unique securities once aggregated. Without aggregation, records collide on the same Firestore doc ID and silently overwrite — real data loss.
- **OpenFIGI returns foreign exchange listings by default.** Without a US-exchange preference filter in `pickBestMatch`, big-cap US stocks resolve to their Frankfurt/XETRA tickers (Chevron→`CHV`, Alphabet→`ABEA`, Moody's→`DUT`, DaVita→`TRL`, Sirius→`3HY`). Always filter `exchCode` for US codes (`US`, `UN`, `UQ`, `UR`, `UW`, `UA`, `UV`, `UF`, `UP`, `UD`, `UB`) before picking shortest ticker.
- **CINS-coded CUSIPs (starting with G or H) need an EDGAR name fallback.** Foreign-domiciled US-listed companies (Chubb-Bermuda, AON-Ireland, Allegion-Ireland, Liberty Latin America-Bermuda) have CUSIPs that begin with letters per the CINS scheme. OpenFIGI often only returns the foreign primary listing, missing the US dual listing. `src/sec-tickers.ts` falls back to EDGAR's `company_tickers.json` matching on normalized issuer name. Closes Chubb (CB), AON, Allegion (ALLE), Liberty Latin America (LILA).
- **Microsoft Store Claude Desktop has a sandboxed config path.** Standard install: `%APPDATA%\Claude\claude_desktop_config.json`. Microsoft Store install: `%LOCALAPPDATA%\Packages\Claude_<hash>\LocalCache\Roaming\Claude\claude_desktop_config.json`. The standard path returns "location unavailable" for Store installs. Greg's machine: `C:\Users\home8\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json`.
- **MCP server path resolution must be module-relative, not cwd-relative.** When Claude Desktop spawns the MCP server, the working directory is unpredictable (might be Claude's install dir). `firestore.ts` resolves `secrets/service-account.json` from `import.meta.url` → module dir → project root. Same pattern for any other relative-path file the server needs to read.
- **13F XML `<value>` is in dollars, not thousands, despite SEC instructions saying otherwise.** SEC Form 13F instructions historically read "report value in thousands of dollars (omit last three digits)" — but modern filers (2023+) report the full dollar amount. Treating `<value>` as thousands and multiplying by 1000 produces market_value 1,000× too high (e.g., Berkshire's AAPL position showed as $61T instead of $61B). The fix in `13f.ts` is to treat `<value>` as dollars directly and derive `market_value_thousands` by dividing.
- **OpenFIGI's `pickBestMatch` must return undefined when no US listing exists.** If we fall back to picking the shortest non-US ticker, big-cap securities resolve to foreign exchange tickers (Confluent → 8QR XETRA, Avidity → RNAGBP London, Hillenbrand → 9HI, etc.). Returning undefined forces the EDGAR name fallback (`sec-tickers.ts`) to kick in, which only contains US tickers from `company_tickers.json`. Net result: every record either gets a real US ticker or empty (for truly delisted/foreign-only names).
- **Shortest-ticker tiebreaker can pick the wrong company.** Single-letter tickers from OpenFIGI (e.g. "P" returned for Pure Storage's CUSIP — "P" was Pandora's old NYSE ticker, delisted 2019) win against the correct multi-letter ticker (PSTG) because shortest-wins is naive. Fix: maintain an explicit allowlist of legitimate single-char tickers (V/Visa, C/Citi, F/Ford, T/AT&T, S/SentinelOne, X/US Steel, K/Kellogg, M/Macy's, O/Realty Income, U/Unity, Z/Zillow). Reject any single-char ticker not in the allowlist. Plus reject any ticker matching `/USD$/i` (foreign cross-listings: NCSUSD, SGENUSD, GTT1USD).
- **OpenFIGI sometimes returns wrong-issuer tickers.** CUSIP 023139884 is Ambac Financial Group (AMBC), but OpenFIGI maps it to "OSG" (Overseas Shipholding — totally different company). Same pattern with "MDLN" for what OpenFIGI calls "Medline Inc" and "TIC" for "TIC Solutions Inc" (private/placeholder names). EDGAR-validation against `tickerSet` accepts these because OSG/MDLN/TIC really are valid US tickers — they just don't belong to those CUSIPs. The fix would be issuer-name cross-validation (compare OpenFIGI's returned `name` field against the 13F's `nameOfIssuer` and reject mismatches). Not yet implemented; deferred to v1.1.
- **SEC's `company_tickers.json` is filtered and incomplete; `company_tickers_exchange.json` is also incomplete AND has wrong mappings.** Both files claim to be comprehensive ticker catalogs but real S&P-mid-cap names like Hologic (HOLX), CyberArk (CYBR), Confluent (CFLT), Jamf (JAMF), Avidity (RNA), Dayforce (DAY), Exact Sciences (EXAS), Avadel (AVDL), Dun & Bradstreet (DNB), Hillenbrand (HI), Dynavax (DVAX), Ambac (AMBC) are simply absent. Even worse, `company_tickers_exchange.json` has stale ticker-to-issuer mappings: RNA → "Atrium Therapeutics, Inc." (should be Avidity Biosciences), PSTG → "Everpure, Inc." (should be Pure Storage). Treat both files as best-effort, never authoritative. The fix is a tertiary OpenFIGI search-by-name fallback when EDGAR name lookup fails.
- **Three-tier ticker resolution architecture.** (1) CUSIP → OpenFIGI `/v3/mapping` (cached in Firestore `cusip_map`). (2) If CUSIP returns no acceptable US ticker, try EDGAR name lookup (in-memory match against `company_tickers_exchange.json`). (3) If EDGAR name lookup misses, query OpenFIGI `/v3/search` by issuer name (rate-limited 5/min free, 25/min with API key — paced via `lastSearchCallAt` timestamp). Each successful resolution writes to `cusip_map` so subsequent runs short-circuit at tier 1. Source field tracks which tier resolved each ticker (`openfigi_mapping` / `edgar_name_fallback` / `openfigi_name_search`).
- **Aggressive name normalization is required for EDGAR matching.** 13F filers use abbreviated names ("CTLS" for Controls, "INTL" for International, "COS" for Companies, "PETE" for Petroleum, "HLDG" for Holdings, "MGMT" for Management, "SVCS" for Services, "AMER" for American, "ELEC" for Electric, "PWR" for Power, "WTR" for Water). EDGAR uses long forms. `normalizeName()` in `sec-tickers.ts` expands abbreviations BEFORE stripping corporate-form suffixes. Also strips jurisdiction suffixes (IRELAND, BERMUDA, SWITZ, NETHERLANDS, CAYMAN, etc.) and corporate forms (INC, CORP, LTD, PLC, LLC, HOLDINGS, HOLDING, GROUP, TRUST). With expansion: "JOHNSON CTLS INTL PLC" → "JOHNSON CONTROLS INTERNATIONAL" matches EDGAR's "Johnson Controls International plc" → JCI.
- **Pre-2023 13F market values are in thousands, not dollars.** SEC's instruction-line for `<value>` historically said "report in thousands of dollars (omit last three digits)." Modern filers (2023+) report full dollar amounts. Our fix treats `<value>` as dollars unconditionally, so pre-2023 filings show values 1000× too small. Not blocking v1 (current-quarter focused), but flagged for v1.1 era-boundary handling.

## What This Project Is

A Model Context Protocol (MCP) server that exposes US public financial disclosures — congressional trades, executive insider transactions (Form 4), and institutional holdings (13F) — as agent-native tools. Working title in code: `capital-edge-mcp`. Final brand/domain TBD.

Sibling product to the Capital Edge dashboard at `C:\CapitalEdge`. Dashboard sells derived intelligence (convergence score + tax engine) to retail investors. This project sells raw, normalized public-record data to developers and AI agents. Different audience, different legal posture, different product entirely.

**The wedge:** every existing financial-data MCP (Unusual Whales, FMP, Alpha Vantage) bolted MCP onto a pre-existing REST API and ended up with 100–250 tools that overwhelm agent context windows. This project is designed for the agent as the customer from the ground up: fewer tools, smarter parameters, descriptions that help the agent decide when to use each one. See `TOOL_DESIGN.md` for the full design rationale.

## Architecture — Locked In

Decisions made tonight that should not be re-litigated without explicit reason:

- **Two Firebase projects, one Google account.** `capital-edge` (existing dashboard) and `capitaledge-api` (this project). Same Google account (`claude1986aaa@gmail.com`), totally independent IAM/billing/Firestore/Functions. Sibling, not shared.
- **Dual-scrape architecture.** This project runs its own copy of the scrapers, hits SEC EDGAR / Senate / House sites independently, writes to *its own* Firestore. Capital Edge does the same on its side. We deliberately accepted the cost of doubled scraping work for full operational independence — Greg can move at his own pace without coordinating Firebase access with Derek.
- **Pure-publisher legal posture.** No convergence score, no signal weight, no derived rank, no "buy"/"strong buy" language. Tools return raw filings only. This is what keeps the product out of investment-advisor territory; the dashboard handles the publisher's-exemption complexity (Lowe v. SEC, 1985), this project sidesteps it entirely.
- **Stack: Node 20+ / TypeScript / MCP SDK / Firebase Admin.** Matches the dashboard codebase enough to share scraper logic; uses TypeScript strict mode for tool param safety.
- **Transport: stdio for v0.x dev, remote (HTTPS) for v1 deployment.** Hosting target is a sibling Firebase project's Cloud Functions or Cloud Run. Deployment infrastructure not yet stood up.
- **Repo: `https://github.com/gregorywglenn-spec/CapitalEdge-API`.** Private. Greg's GitHub username is `gregorywglenn-spec` (note: not `gregorywglenn`).

## Current State (April 30, 2026 — Day 3 mid-session, work paused)

What runs end-to-end **right now**:

**From Day 1 (April 28):**

- ✅ MCP server scaffolded and boots (`npm run dev` shows `LIVE MODE` on stdio)
- ✅ One MCP tool registered: `get_insider_transactions` — works against real Firestore data
- ✅ Form 4 scraper ported to Node/TypeScript, runs against live SEC EDGAR
- ✅ CLI: `npx tsx src/scrape.ts ping` — verifies Firestore connectivity
- ✅ CLI: `npx tsx src/scrape.ts form4 <TICKER> [--save]` — pulls Form 4 trades for a ticker, optionally writes to Firestore
- ✅ CLI: `npx tsx src/scrape.ts form4-feed [days] [--save]` — pulls Form 4 trades across all companies for the last N days
- ✅ Firestore credentials at `secrets/service-account.json` (gitignored)
- ✅ 76 real insider trades sitting in the `insider_trades` collection from a successful `form4-feed 3 --save` run
- ✅ Pushed to GitHub on `main`

**Day 2 additions (April 29):**

- ✅ **13F scraper ported to Node/TypeScript with full v1-quality enrichment** (`src/scrapers/13f.ts`): parses informationTable XML, aggregates sub-account dupes by CUSIP, top-50-by-value filter
- ✅ **OpenFIGI integration** (`src/openfigi.ts`): CUSIP→ticker via Bloomberg's free API, US-exchange preference, Firestore write-through cache (`cusip_map` collection), optional `OPENFIGI_API_KEY` env var for higher rate limits
- ✅ **EDGAR name fallback** (`src/sec-tickers.ts`): when OpenFIGI returns empty for foreign-domiciled CINS CUSIPs, falls back to matching against EDGAR's `company_tickers.json` by normalized issuer name. Catches Chubb→CB, AON, Allegion→ALLE, Liberty Latin America→LILA
- ✅ **Position-change calculation** (`13f.ts:applyPositionChanges`): compares each current-quarter holding to the same fund's prior-quarter holding from Firestore, computes `position_change` ("new" / "increased" / "decreased" / "closed" / "unchanged"), `shares_change`, `shares_change_pct`. Synthesizes 0-share "closed" records for prior holdings absent in current quarter.
- ✅ CLI: `npx tsx src/scrape.ts 13f <ALIAS_OR_CIK> [--save]` — single-fund 13F (e.g., `13f berkshire --save`)
- ✅ CLI: `npx tsx src/scrape.ts 13f-feed [days] [--save]` — recent 13F filings across all funds (default 30 days, max 25 funds)
- ✅ CLI: `npx tsx src/scrape.ts funds` — list 10 tracked fund aliases (berkshire, blackrock, vanguard, bridgewater, citadel, point72, deshaw, renaissance, twosigma, millennium)
- ✅ **42 Berkshire Hathaway 13F holdings** in `institutional_holdings` collection (Q4 2025), all with correct US tickers, consolidated to one row per security (110 raw entries → 42 aggregated)
- ✅ **47 entries in `cusip_map` cache** (42 OpenFIGI hits + 5 from EDGAR name fallback); subsequent scrapes hit cache instead of re-fetching
- ✅ `firestore.ts` made robust to launch context — service-account.json path resolves relative to module location (`import.meta.url`), not cwd. Required for Claude Desktop spawning the MCP server from a different working directory.
- ✅ `firestore.ts` adds `saveInstitutionalHoldings`, exports `getLiveDb`, `getDbIfLive` for use by scraper modules
- ✅ MCP server registered in Claude Desktop's `claude_desktop_config.json` (sandboxed Microsoft Store path) and **proven end-to-end** — asked the running Claude Desktop "what insider trades happened above $5M in the last week," it called `get_insider_transactions` against live Firestore, returned 14 Avis Budget Group records totaling ~$488M of selling on April 23.
- ✅ Form 4 multi-owner parsing fix (task #16). Fast-xml-parser returns an array for filings with multiple reportingOwner elements (typical for 10%+ holder / fund-entity filings — exactly what the Avis sells were). Without this fix, every such record's officer_name silently became "unknown." Now concatenates owner names with " / " and OR's the isDirector flag across all owners. After re-running `form4-feed --save`, existing "unknown" records resolve to actual entity names.
- ✅ Ticker validation regex relaxed in `get_insider_transactions` from `^[A-Za-z]{1,5}$` to `^[A-Za-z][A-Za-z0-9./-]{0,9}$`. Now accepts BRK.A, BRK.B, BF.B, HEI/A, LEN/B, etc.
- ✅ **Second MCP tool registered: `get_institutional_holdings`** — exposes the 13F `institutional_holdings` collection. Same filter/sort surface as the insider tool, plus 13F-specific params (cusip, fund_name, fund_cik, quarter, position_change).
- ✅ **Form 4 re-scrape ran clean.** `form4-feed 3 --save` re-pulled 73 records with the multi-owner fix applied. Avis Budget Group records correctly attribute to "Pentwater Capital Management LP / Halbower Matthew" (was "unknown" pre-fix). NN Inc cluster and other 10%+ holder filings similarly resolved.
- ✅ **Berkshire 13F re-scrape post-bug-fixes confirmed clean.** AAPL position now shows `market_value: 61,961,735,283` (~$62B) instead of $62T — the dollar-vs-thousands fix is working. All 42 holdings have correct US tickers, including all five CINS-coded foreign-domiciled names that flowed through the EDGAR name fallback: Chubb (CB), AON (AON), Allegion (ALLE), and Liberty Latin America (LILA, two share classes). Log line `[sec-tickers] Loaded 10357 tickers, 7986 unique normalized names` confirms EDGAR catalog loaded successfully.
- ✅ **Claude Desktop restarted** so the MCP server is now running with all today's fixes live: multi-owner Form 4 parsing, relaxed ticker regex (BRK.A etc.), US-only OpenFIGI resolution, EDGAR name fallback, dollar-magnitude market values, and the new `get_institutional_holdings` tool exposed.

**Day 3 additions (April 30):**

- ✅ **Broader 13F re-scrape ran** (`13f-feed 30 --save` covering Berkshire, Viking, Tekla, Energy Income Partners, Broadwood, Diker, Harvest, Coastline Trust, Washington Capital, Hermes 2018, Lane Five 2014, etc. — both modern and historical filings). Berkshire continues to be clean. Viking, Coastline, EIP all show correct US tickers and dollar-magnitude market values for 2025-Q4 and 2026-Q1 filings.
- ✅ **Wrong-ticker tiebreaker fix** in `pickBestMatch` (`src/openfigi.ts`):
  - Single-character tickers rejected unless in explicit allowlist (V, C, F, T, S, X, K, M, O, U, Z) — closes the "P → Pandora not Pure Storage" failure mode.
  - Tickers matching `/USD$/i` rejected — closes NCSUSD (Cornerstone), SGENUSD (Seagen), GTT1USD foreign-listing leaks.
  - EDGAR-catalog cross-validation as preference: when multiple US-listed candidates remain, prefer ones whose ticker appears in EDGAR's `tickerSet`. Falls through to all candidates when no EDGAR-validated option exists (avoids losing recent IPOs not yet in catalog).
  - `pickBestMatch` is now async (calls `isKnownUSTicker`); `openFigiBatch` awaits it.
- ✅ **EDGAR normalization expanded** (`src/sec-tickers.ts`):
  - Abbreviation expansion table (CTLS→CONTROLS, INTL→INTERNATIONAL, MGMT→MANAGEMENT, SVCS→SERVICES, COS→COMPANIES, PETE→PETROLEUM, HLDG→HOLDINGS, AMER→AMERICAN, ELEC→ELECTRIC, PWR→POWER, WTR→WATER, WKS→WORKS, etc.) applied BEFORE corporate-form stripping.
  - Jurisdiction-word stripping (IRELAND, BERMUDA, SWITZ, NETHERLANDS, CAYMAN, JERSEY, GUERNSEY, GIBRALTAR, MARSHALL, LIBERIA, SCOTLAND, ENGLAND, JAPAN, KOREA, CHINA, GBR, UK, USA, US, DEL, NE).
  - Leading/trailing "THE" stripped (handles "X COMPANY, THE").
  - Singular `HOLDING` added to corporate-form regex (was just plural `HOLDINGS|HLDGS`).
  - Diagnostic `[sec-tickers] MISS` log line surfaces specific normalization gaps.
  - Result: JOHNSON CTLS INTL PLC → JCI, ACCENTURE PLC IRELAND → ACN, COOPER COS INC → COO, AMERICAN ELEC PWR CO INC → AEP all resolve where they used to be empty.
- ✅ **`isKnownUSTicker(ticker)` exported** for use by `openfigi.ts`. Backed by a `tickerSet: Set<string>` populated as a side effect of `loadMap()`.
- ✅ **Tertiary fallback: OpenFIGI search-by-name** (`src/openfigi.ts:searchOpenFigiByName`). Uses OpenFIGI's `/v3/search` endpoint, filters to `marketSecDes: "Equity"`, runs through the same `pickBestMatch` for consistency. Rate-limited via `lastSearchCallAt` timestamp + `SEARCH_DELAY_MS` (12s free tier, 2.4s with API key). Wired into `13f.ts` as the third tier — fires only when both OpenFIGI mapping and EDGAR name lookup return empty.
- ✅ **EDGAR source switched** from `company_tickers.json` to `company_tickers_exchange.json` (slightly more comprehensive, includes preferred-share tickers like JPM-PC). Both files have known gaps and wrong mappings — kept the exchange file because parser is now generalized via `fields[]` lookup.
- ✅ **New diagnostic CLI commands** in `src/scrape.ts`:
  - `test-normalize [names...]` — runs `normalizeName()` + `lookupTickerByName()` on input names (or a default canary set), prints normalized form and EDGAR match. Use to smoke-test normalization changes BEFORE expensive scrape runs.
  - `search-edgar <substring>` — searches EDGAR's loaded catalog by raw-title or normalized-form substring. Diagnostic for "why isn't EDGAR matching this name?"
  - `dump-edgar` — prints catalog stats (total entries, unique normalized names, unique tickers), a sample of 20 entries, and a per-ticker presence check for canary tickers (AAPL, JCI, ACN, HOLX, CYBR, CFLT, JAMF, RNA, DAY, EXAS, AVDL, DNB, HI, DVAX, PSTG, AMBC). This is what surfaced the SEC catalog data-quality issues.
  - `flush-cusip-cache` — deletes all entries in the `cusip_map` Firestore collection so the next scrape re-resolves from scratch under current logic. Use after changing OpenFIGI selection or EDGAR fallback.

## What's Open / Next Up

In rough priority order. Greg paused work on April 30 mid-afternoon (going to day job). Resume here:

1. **🔴 IMMEDIATE NEXT MOVE — verify tertiary OpenFIGI search-by-name fallback works.** Code is written and on disk but NOT yet tested end-to-end. Run sequence:
   ```
   cd C:\CapitalEdge-API
   npm run typecheck                                    # confirm code compiles
   npx tsx src/scrape.ts flush-cusip-cache              # clear stale empty cache entries
   npx tsx src/scrape.ts 13f 0001140315 --save          # test ONE fund (Harvest, has 9+ unresolved names)
   ```
   Watch for log lines:
   - `[13f]   <CUSIP> (<NAME>) → <TICKER> via EDGAR name` — tier 2 hit (existing path)
   - `[13f]   <CUSIP> (<NAME>) → <TICKER> via OpenFIGI search` — tier 3 hit (the new path; this is what we want to see for HOLX, CYBR, CFLT, JAMF, AVDL, DAY, EXAS, DVAX, DNB, HI)
   - `[openfigi search] rate-limited for "..."` — hit the 5/min free-tier limit; would need OPENFIGI_API_KEY to speed up
   
   **Optional speedup before this run:** sign up for free OpenFIGI API key at https://www.openfigi.com/api (takes ~2 min, just an email), then `set OPENFIGI_API_KEY=<key>` in the shell. Bumps search rate limit from 5/min to 25/min — turns ~2-min Harvest run into ~30 seconds.

2. **If Harvest test resolves the missing names**, run the full feed: `npx tsx src/scrape.ts 13f-feed 30 --save`. Expect 5–10 minutes for the broader fund landscape (most CUSIPs already cached from earlier run; tertiary fallback only fires for the 10–20 names still empty). Then spot-check canaries: HOLX, CYBR, CFLT, JAMF, AVDL, DAY, EXAS should now resolve.

3. **Known limitations that won't be fixed by this round** (deferred to v1.1):
   - **Wrong-issuer OpenFIGI mappings**: AMBAC FINANCIAL → OSG, MEDLINE INC → MDLN, TIC SOLUTIONS → TIC. Root cause is OpenFIGI's CUSIP→ticker mapping returning a real-but-wrong US ticker. Fix needs issuer-name cross-validation (compare OpenFIGI's returned `name` field against 13F's `nameOfIssuer`, reject mismatches).
   - **Pre-2023 13F market values 1000× too small**: SEC's old "thousands" instruction. Need era-boundary handling that treats `<value>` as thousands for filings before 2023. Affects historical Hermes 2018, Lane Five 2014, etc. Doesn't affect current-quarter MCP tool queries.

4. **After 13F data is solid**: restart Claude Desktop and test `get_institutional_holdings` MCP tool end-to-end. Ask things like "which institutions hold AAPL?", "show me Viking's biggest positions", "which funds added to NVDA last quarter?" Likely will surface a Firestore composite-index error on first query — that's normal, the error message includes a one-click URL to create the index.

5. **Commit + push today's fixes to GitHub.** Three-tier ticker fallback architecture, EDGAR source switch, normalization expansion, USD-suffix rejection, single-char allowlist, isKnownUSTicker validation, all the new diagnostic CLI commands (test-normalize, search-edgar, dump-edgar, flush-cusip-cache).

6. **Port the Senate scraper** (HTML parsing, browser-flavored — needs `jsdom` + the existing `tough-cookie` jar). v1 needs `get_congressional_trades` data.

7. **Port the House scraper** (PDF parsing, trickiest of the four).

8. **Add the `bioguide_id` catalog** for congressional member enrichment. Spec already exists in `C:\CapitalEdge\CONGRESS_DATA_PIPELINE.md`.

9. **Implement remaining v1 tools:** `get_member_profile`, `get_congressional_trades`, `get_company_filings_summary`. Full design in `TOOL_DESIGN.md`. Two of five v1 tools built (insider transactions, institutional holdings).

10. **Deploy v1.0 as a remote MCP server.** Probably Cloud Run or Firebase Functions in the `capitaledge-api` project. Needs the Blaze plan upgrade.

11. **Commercial: brand, domain, customer validation, pricing, marketing site.** Not engineering. Don't build deployment infrastructure ahead of customer interest.

## Files In This Project

- `src/index.ts` — MCP server entry, stdio transport, dispatches list/call to the tool registry
- `src/tools/index.ts` — registry of registered tools
- `src/tools/insider-transactions.ts` — first MCP tool (definition + handler + input validation)
- `src/tools/institutional-holdings.ts` — second MCP tool, exposes 13F holdings (Day 2)
- `src/scrapers/form4.ts` — Node/TS port of the Form 4 scraper
- `src/scrapers/13f.ts` — Node/TS port of the 13F scraper with sub-account aggregation, top-50 filter, position-change calc, closed-position synthesis (Day 2)
- `src/openfigi.ts` — OpenFIGI CUSIP→ticker enrichment with US-exchange preference, Firestore write-through cache, EDGAR-catalog cross-validation in `pickBestMatch`, single-char allowlist, USD-suffix rejection, and `searchOpenFigiByName` for the tertiary search-by-name fallback (Day 3)
- `src/sec-tickers.ts` — EDGAR `company_tickers_exchange.json` (Day 3 — switched from `company_tickers.json`) name fallback for CINS-coded foreign-domiciled CUSIPs and ticker-validation oracle. Exports `lookupTickerByName`, `isKnownUSTicker`, `searchEdgar`, `dumpEdgar`, `normalizeName`. Contains aggressive abbreviation-expansion table and jurisdiction-suffix stripping.
- `src/scrape.ts` — CLI runner for scrapers (`ping`, `form4`, `form4-feed`, `13f`, `13f-feed`, `funds`, plus Day 3 diagnostics: `test-normalize`, `search-edgar`, `dump-edgar`, `flush-cusip-cache`)
- `src/firestore.ts` — data layer with auto-detected stub vs live mode; `saveInsiderTransactions`, `saveInstitutionalHoldings`, `pingFirestore`, `getLiveDb`, `getDbIfLive`
- `src/types.ts` — shared types (`ResultEnvelope`, `InsiderTransaction`, `InstitutionalHolding`, etc.)
- `package.json` — dependencies and scripts
- `tsconfig.json` — TypeScript config (strict mode, ES2022, NodeNext)
- `.gitignore` — excludes `secrets/`, `node_modules/`, `dist/`
- `secrets/service-account.json` — Firebase service account key (NEVER commit; gitignored)
- `secrets/.gitkeep` — keeps the folder in version control without contents
- `reference/form4_scraper.js` — original browser-version scraper from Capital Edge (kept for diffing)
- `reference/congressional_scraper.js` — original Senate scraper (browser-version, awaiting Node port)
- `reference/house_scraper.js` — original House scraper (browser-version, awaiting Node port)
- `reference/institutional_scraper.js` — original 13F scraper (browser-version, awaiting Node port)
- `MCP_PROJECT_HANDOFF.md` — original handoff from the chat-interface session that scoped this product
- `DATA_REQUIREMENTS_FOR_DASHBOARD.md` — data-quality spec sent to the Capital Edge dashboard project as peer review (not a hard dependency since we're dual-scrape)
- `TOOL_DESIGN.md` — v1 tool surface design (5 tools, design principles, composition patterns)
- `README.md` — human orientation, quickstart
- `CLAUDE.md` — this file

## External Locations

- **GitHub repo:** https://github.com/gregorywglenn-spec/CapitalEdge-API (private)
- **Firebase project:** https://console.firebase.google.com/project/capitaledge-api/overview
  - Firestore database: `(default)` in `us-central1`, production-mode rules
  - Service account: `firebase-adminsdk-fbsvc@capitaledge-api.iam.gserviceaccount.com`
  - Plan: Spark (free tier). Will need Blaze for Cloud Functions deployment later.
- **Capital Edge dashboard project:** `C:\CapitalEdge\` (separate Cowork workspace, owned operationally by Derek)

## Capital Edge Cross-References (sibling project)

These files in `C:\CapitalEdge\` may be relevant context for AI agents working here. Read them only if relevant to the current task — don't preload everything.

- **`DATA_STRATEGY.md`** — original dual-track business plan, Firestore schema design, full cost picture, build phases, competitor comparison, April 2026 repositioning around Unusual Whales. Schema doc is somewhat out of date relative to what scrapers actually write; cross-check against actual scraped data when in doubt.
- **`CONGRESS_DATA_PIPELINE.md`** — detailed spec for ingesting congress-legislators YAML data (537 members, photos, committee assignments). Bioguide_id is the join key. Important hard-won gotchas inside (Cloudflare bot challenge on theunitedstates.io, photo concurrency limits, JPEG magic-byte verification). Foundational for any tool that returns congressional trade data with member context.
- **`DATA_SOURCES_ROADMAP.md`** — v2+ expansion candidates (Form 144, 13D/G, USAspending, FRED, etc.). Strategic note inside about positional vs event data — important for v2 tool design but not v1.
- **`HANDOFF_NEXT_SESSION.md`** — the dashboard project's own handoff to its next session. Read for context on dashboard state, NOT for MCP guidance.
- **`run-scraper.js`** — the dashboard's working Node CLI runner with thinner inline scrapers. Reference only; this project has its own copies and ports under `reference/` and `src/scrapers/`.

## Standing Rules from Greg

These apply across all his Claudes — copied here so a cold session has them inline.

1. **Tell the ugly truth.** Especially about whether something will actually work. Push back, run actual diagnostics, report the true picture even when it complicates the plan.
2. **Don't quote in weeks what he ships in hours.** Recalibrate constantly.
3. **Foundation before features. Always. No exceptions.**
4. **Speak in easy-to-understand dialog. Use comparisons to explain things. Teach.** Greg is a builder learning code — analogies to construction, framing, plumbing land well.
5. **Flag opportunity in the moment.** If you spot a genuine business opportunity adjacent to what you're working on, surface it without being asked.
6. **Pure-publisher posture stays.** No derived intelligence in tool outputs. Ever. Convergence score and similar belong to the dashboard product, not here.
7. **Project boundary discipline.** This project never writes to Capital Edge's Firestore collections. Scraper changes that affect this project's data happen here only.

## Decisions Greg Locked In Tonight

In case future sessions try to re-open these:

- MCP server is the v1 product. The REST API tier is parked indefinitely. If it ever ships, it lives on its own separate website/brand, not under this project's umbrella.
- Two Firebase projects under one Google account. Not data sync. Not dual-write. Pure dual-scrape with full operational independence.
- Tool surface: 5 tools, entity-based with rich filters (`get_insider_transactions` not `get_recent_insider_transactions` + `get_insider_transactions_by_ticker`). See `TOOL_DESIGN.md` for the load-bearing argument.
- Foundation pace is set by the dashboard's data quality. The MCP project can move fast on tool design and architecture; can't outrun the data quality of what scrapers produce. We'll port scrapers properly with full field set rather than ship thin scrapers that limit the tool surface.

## How to Continue Tomorrow

If a fresh Cowork session is starting in this folder:

1. Read this file (you just did, if you're an agent reading top-down).
2. Glance at `MCP_PROJECT_HANDOFF.md` for the original strategic framing.
3. Glance at `TOOL_DESIGN.md` for what the v1 tool surface looks like and which tools depend on which scrapers.
4. Then ask Greg: which of the open items above is the priority right now. Don't guess.

Greg's keyboard test sequence (anytime you want to verify everything still works):

```
cd C:\CapitalEdge-API
npx tsx src/scrape.ts ping                    # confirms credentials
npx tsx src/scrape.ts form4 AAPL              # hits SEC, prints AAPL trades
npx tsx src/scrape.ts form4-feed 1 --save     # 1-day live feed, saves to Firestore
npm run dev                                    # boots MCP server in LIVE MODE
```

## Last Updated

April 30, 2026 — Day 3, work paused mid-afternoon (Greg headed to day job). State: three-tier ticker resolution architecture is fully written but the third tier (OpenFIGI search-by-name) is **untested end-to-end**. Code on disk includes: USD-suffix rejection in pickBestMatch, single-char ticker allowlist, EDGAR-catalog cross-validation in pickBestMatch, expanded normalization in sec-tickers.ts (abbreviation expansion, jurisdiction-suffix stripping, leading/trailing THE), switch from `company_tickers.json` to `company_tickers_exchange.json` (both turned out to be incomplete and have wrong mappings — see Hard Lessons), tertiary OpenFIGI search-by-name fallback wired into 13f.ts, four new diagnostic CLI commands (test-normalize, search-edgar, dump-edgar, flush-cusip-cache).

Today's wins, confirmed via test runs: Berkshire 13F still clean post-changes (AAPL $62B, all 5 CINS-coded foreign names resolve). Viking's Johnson Controls now resolves to JCI via abbreviation expansion (CTLS+INTL). Hermes 2018's Accenture and Cooper Cos resolve via jurisdiction-strip and abbreviation-expansion. USD-suffix leaks plugged (NCSUSD/SGENUSD/GTT1USD). Pure Storage's bad "P" rejected (now correctly empty rather than wrong, will hopefully resolve via tier 3 once tested).

Today's discovery (forced an architecture pivot): SEC's `company_tickers_exchange.json` is INCOMPLETE (missing HOLX, CYBR, CFLT, JAMF, AVDL, DAY, EXAS, DVAX, DNB, HI, AMBC) AND has wrong mappings (RNA → "Atrium Therapeutics" not Avidity Biosciences; PSTG → "Everpure" not Pure Storage). Cannot rely on either SEC ticker file as authoritative. The tertiary OpenFIGI search-by-name fallback is the right architectural response; it's coded but pending test.

**The immediate next move is item 1 in "What's Open / Next Up" — run the test sequence (typecheck → flush-cusip-cache → `13f 0001140315 --save` for Harvest) to verify the new tertiary fallback resolves HOLX, CYBR, CFLT, JAMF, AVDL, DAY, EXAS, DVAX, DNB, HI. If it works, follow with full `13f-feed 30 --save`. Optional speedup: get a free OpenFIGI API key (~2 min signup) and set `OPENFIGI_API_KEY` env var to bump search rate limit from 5/min to 25/min.**
