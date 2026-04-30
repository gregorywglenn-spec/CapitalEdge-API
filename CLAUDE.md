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
- **Empty `action=""` on an HTML form means "submit to current URL," NOT "fall back to a sibling URL."** The Senate eFD agreement form lives on `/search/home/` and has `<form action="" method="POST" id="agreement_form">`. Our first-pass port treated empty `action` as falsy and fell through to a hardcoded `/search/` default (which the reference browser scraper also used and which appears to have once worked via legacy URL mapping). The eFD now silently re-renders the home page when posted to `/search/`, leaving the session unagreed and downstream PTR detail pages bouncing back to home. The HTML spec is clear: empty `action` and missing `action` both mean "the document's URL." Always extract the form's actual `action` and resolve relative to the page that served the form. Reference scrapers can drift; validate against live behavior, not historical assumptions.
- **Django 4 CSRF middleware requires `Origin` header for unsafe methods.** Browsers always set `Origin` automatically; Node's `fetch` (undici) does not for cross-origin server-to-server requests. Without it, Django silently rejects POSTs and re-renders the form page (200 OK, not 403) — making this nearly impossible to debug from response codes alone. The tell-tale: `agreement POST → HTTP 200, finalUrl=/<form-page>/` instead of `finalUrl=/<post-target>/`. Always set `Origin: https://<host>` explicitly on POSTs from Node fetch. Also helpful: `Referer`, `X-CSRFToken` header, and dump the form HTML to extract the actual hidden-field set rather than hardcoding.
- **Senate eFD agreement protocol — the full sequence.** (1) GET `/search/home/` → extract CSRF token from form input (more reliable than reading from cookie jar since some Django configs make csrftoken HttpOnly). (2) POST `/search/home/` (the form's `action=""` resolves to the page URL, NOT `/search/`) with `csrfmiddlewaretoken` + `prohibition_agreement=1` + `Origin: https://efdsearch.senate.gov` + `Referer: HOME_URL` headers. (3) GET `/search/` to land on the search page after the redirect (some Django configs only flip the agreed flag once you actually load the search page, not at the redirect itself). (4) Re-read CSRF token from the new search page (Django rotates it post-POST). (5) `/search/report/data/` POST sends multipart `FormData` (matches browser wire format), Origin + Referer + X-CSRFToken + X-Requested-With headers. PTR detail GETs use `Referer: SEARCH_URL` once authenticated.
- **Senate PTRs include muni bonds and structured notes — `ticker: "--"` is correct for those.** Senators (esp. McCormick, Collins, Mullin) report large municipal bond and structured-note positions where the asset has no equity ticker. Asset is identified by issuer name + coupon + maturity in the asset_name field. Empty ticker is a faithful reflection of the source data, not a parser bug. v1 keeps these records for completeness; agents querying with a `ticker` filter naturally won't see them. Ticker validation regex must allow `BRK.A` / `BRK.B` etc. (already relaxed in `get_insider_transactions`; same pattern applied to `get_congressional_trades`).
- **Senate "paper PTR" amendments are a real but minor case.** Some PTR detail pages return an HTML wrapper around a PDF embed instead of a trade table. The current parser detects this via an `isPaperPtr()` heuristic and logs+skips. Not blocking v1 — most PTRs are electronic. Push to v1.1 if it ever becomes a meaningful percentage of disclosures (currently ~0% in observed runs).
- **Vertical depth, not horizontal expansion.** The temptation when the hub starts working is to add medical data, legal data, sports data — more domains feels like more value. It's a trap. Every data domain has its own sources, normalization quirks, regulatory landscape, and customer profile. Going horizontal means becoming a mediocre lumberyard for everything instead of an excellent one for one thing. Bloomberg won by going deep on financial. Westlaw won by going deep on legal. UpToDate won by going deep on medical. Wolfram Alpha tried to be everything-engine and never became a real business. The hub stays inside US public-disclosure data forever; expansion happens *deeper into the same vertical* (Form 144, 13D/G, 8-K, lobbying, USAspending, FRED, FEC, FOIA) — not adjacent verticals. The moat (agent-native MCP design + data-quality discipline) doesn't transfer to medical or sports anyway. Greg's analogy: don't call a plumber to lay flooring; don't use the siding guy to install cabinets. Specialists win.
- **Customer funnel is bottom-up, not top-down.** Free tier → indie devs → small fintechs → midsize firms → institutional. Don't optimize for institutional contracts in v1.0; optimize for indie devs *loving* the hub, because those devs become tech leads at small fintechs in 18 months and bring the hub with them. The free public-data cost structure (no Bloomberg-style licensing fees) is what makes this path economically viable. Quiver Quantitative followed exactly this path to a $2.6M raise.

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

**Day 3 afternoon — Senate scraper port complete (April 30):**

- ✅ **Senate eFD scraper ported to Node/TypeScript** (`src/scrapers/senate.ts`, ~470 lines). Full session protocol: GET home → extract CSRF from form input → POST agreement to `/search/home/` (form's `action=""` resolves to current URL, NOT `/search/`) → GET `/search/` to land on the search page → re-read rotated CSRF → POST `/search/report/data/` with multipart FormData → GET each PTR detail. Includes paper-PTR detector for amendment filings that ship as PDF embeds rather than HTML tables.
- ✅ **Three load-bearing fixes discovered the hard way** (each captured in Hard Lessons): empty `action=""` means submit-to-self (HTML spec), Django 4 CSRF requires explicit `Origin` header from Node fetch, agreement state only flips after a follow-up GET to the post-redirect destination on some Django configs. The reference browser scraper at `reference/congressional_scraper.js` had drifted — it posts to `/search/` which used to work via legacy URL routing but now silently re-renders the home page.
- ✅ **CLI commands added** in `src/scrape.ts`:
  - `senate [days] [--save] [--max=N]` — Senate PTRs for the last N days (default 7), optional cap on PTRs processed for testing.
  - `senate-ptr <PTR_ID> [--save]` — re-pull one specific PTR by ID. Useful for testing parser changes against a known filing.
- ✅ **`CongressionalTrade` and `CongressionalTradesQuery` types** added to `src/types.ts`. Same field shape as Capital Edge dashboard schema for portability, with `signal_weight` deliberately omitted (publisher-only posture).
- ✅ **`queryCongressionalTrades` and `saveCongressionalTrades`** added to `src/firestore.ts`. The substring-filter truncation fix from Day 3 morning is applied here too — when `member_name` substring is set, fetch up to 5000 records before client-side filtering rather than the user-set limit.
- ✅ **Third MCP tool registered: `get_congressional_trades`** (`src/tools/congressional-trades.ts`). Same filter/sort surface as the other two tools, plus congressional-specific params (`member_name`, `bioguide_id`, `chamber`, `owner`, `transaction_type`). `bioguide_id` validation regex `/^[A-Z]\d{6}$/` reserved for when the legislators catalog ingestion lands.
- ✅ **Server version bumped to 0.3.0**, three tools registered: `get_insider_transactions`, `get_institutional_holdings`, `get_congressional_trades`.
- ✅ **Real Senate data pulled and parsed clean.** 90-day window: 34 PTRs across 14 senators (Banks, Boozman, Capito, Whitehouse, Collins, Fetterman, Smith, McCormick, King, McConnell, Mullin, Hagerty, Hickenlooper) → **241 trades** with correct ticker symbols, owner attribution (Self/Spouse/Joint/Child), date format, amount ranges, reporting lag calculations. Municipal bonds and structured notes correctly preserved with `ticker: "--"` (no equity ticker exists for these instruments).
- ✅ **Dependencies added** to `package.json`: `cheerio` (HTML parsing), `fetch-cookie` + `tough-cookie` (cookie jar for session management). All TypeScript types resolve cleanly under strict mode.
- ✅ **`firestore.indexes.json` already includes** the `congressional_trades` composite index (ticker + disclosure_date desc) from Day 3 morning. First MCP query against `get_congressional_trades` may surface a FAILED_PRECONDITION with a one-click index-creation URL — same workflow as institutional_holdings yesterday.
- ✅ **Pushed to GitHub on `main`** late Day 3 afternoon.

**Day 3 evening — Senate proven end-to-end + Firebase deploy plumbing in place + v2 strategy locked (April 30):**

- ✅ **241 Senate trades written to Firestore** via `senate 90 --save`. Doc IDs deterministic (`senate-<ptr_id>-<row_index>`), idempotent re-runs.
- ✅ **Firebase config bootstrapped.** Created minimal `firebase.json` + `.firebaserc` so `firebase deploy --only firestore:indexes` works from this repo. Both files safe to commit (no secrets, just project ID and feature config). Future index deploys are now a one-liner.
- ✅ **All composite indexes deployed** via `firebase deploy --only firestore:indexes`. Five active indexes total: insider_trades (ticker + disclosure_date), institutional_holdings (ticker + market_value), congressional_trades (ticker + disclosure_date), congressional_trades (transaction_type + disclosure_date + amount_min), congressional_trades (owner + disclosure_date + amount_min).
- ✅ **Two new congressional_trades indexes added to firestore.indexes.json** (transaction_type-based and owner-based, both with disclosure_date + amount_min for filter-and-sort queries). Field directions verified by decoding the protobuf in Firestore's auto-generated index URLs — both use `disclosure_date DESCENDING + amount_min DESCENDING` to match the orderBy direction.
- ✅ **MCP tool `get_congressional_trades` proven end-to-end** through Claude Desktop:
  - NVDA ticker query → 3 real hits (Boozman bought 3/19, Whitehouse self+spouse sold 1/9)
  - Senate buys ≥ $50K since Jan 1 → 15 hits dominated by McCormick's PA muni-bond ladder ($500K–$1M positions in PA Turnpike, Allegheny Airport, Philadelphia Water bonds, GS structured notes), plus Mullin's $50–100K UNH purchase
  - Joint-account trades ≥ $100K → 0 hits (legitimately empty for the 90-day window — most Joint activity is small)
  - Mullin substring filter → ~45 records returned (substring-truncation fix from Day 3 morning carried over correctly to congressional_trades collection)
- ✅ **Three of five v1 tools officially proven** through real MCP queries against live Firestore. Server v0.3.0 stable.

**Strategic decisions locked Day 3 evening (do NOT re-litigate without explicit reason):**

- **Stay vertical.** The hub never expands to medical, legal, sports, or any other adjacent vertical. Expansion happens deeper into US public-disclosure data only. (Captured as a Hard Lesson above with full reasoning.)
- **v2 queue order is locked.** Greg explicitly chose: **House PTRs → Form 144 (planned insider sales) → 13D/13G (activist 5%+) → Lobbying disclosures (LDA) → 8-K material events.** Each closes a gap in the same customer's question set. Don't reorder without a strong reason.
- **Customer funnel is bottom-up.** Free tier → indie devs → small fintechs → midsize firms → institutional. Don't court Citadel cold; build something indie devs love and let it climb. (Captured as a Hard Lesson above.)
- **The product's working name in conversation is "the hub"** — short for "MCP data hub for US public disclosures." Not a final brand; just the term used internally so we don't have to keep saying "the MCP server / API / data product / repository."

## What's Open / Next Up

In rough priority order. Day 3 evening, Senate is shipped and proven, House is next:

1. **🔴 IMMEDIATE NEXT MOVE — Port the House scraper.** `reference/house_scraper.js` is the browser version. House Clerk index at https://disclosures-clerk.house.gov ships an XML feed of recent PTR filings; each PTR is a separately-formatted PDF that needs heuristic table extraction. Plan: `pdf-parse` (or `pdfjs-dist` as fallback) + cell-position heuristics for the trade table. Estimated 3-4 hours given Senate's reference is already proven. Closes the v1 congressional data picture.

2. **Form 144 — planned insider sales scraper.** Same EDGAR plumbing as Form 4, different filing type. Estimated 1.5-2 hours. Big differentiator — almost no aggregator exposes Form 144 cleanly, and it's a forward-looking signal (insiders REGISTER intent to sell large blocks before doing it).

3. **13D/13G — activist 5%+ ownership scraper.** Same EDGAR plumbing. Estimated 1.5-2 hours. Reveals takeover targets, activist campaigns, hostile bids. Not cleanly aggregated outside Bloomberg.

4. **Lobbying disclosures (LDA) scraper.** Senate Office of Public Records. New portal, new auth flow. Estimated 4-5 hours. Adjacent to congressional trades — same buyer profile asks for both ("what's Pfizer paying lobbyists for AND which senators are trading their stock").

5. **8-K material events scraper.** Free-text item-code parsing makes this the hardest of the v2 batch. Estimated 3-4 hours. Highest-volume real-time disclosure stream — acquisitions, executive departures, earnings warnings.

6. **`bioguide_id` catalog ingestion** for congressional member enrichment. Spec at `C:\CapitalEdge\CONGRESS_DATA_PIPELINE.md`. Source: https://github.com/unitedstates/congress-legislators YAML. Once loaded, every senate/house trade record gets enriched with `party`, `state`, `state_district`, photos, committee assignments at query time.

7. **Polish pass on Senate parser output (v1.1, optional)**:
   - Whitespace cleanup in bond `asset_name` fields (current output has `\n\n\n` runs from how eFD renders bond descriptors).
   - Back-fill ticker from `asset_name` when source has it inline (e.g., "GOOGL - Alphabet Inc.", "MRSH - Marsh & McLennan...").

8. **Implement remaining v1 tools:** `get_member_profile`, `get_company_filings_summary`. Full design in `TOOL_DESIGN.md`. Three of five v1 tools built. `get_member_profile` depends on the bioguide catalog; `get_company_filings_summary` is a thin aggregator over the other tools' data.

9. **Known v1.1 deferrals:**
   - **Wrong-issuer OpenFIGI mappings**: AMBAC → OSG, etc. Needs issuer-name cross-validation (compare OpenFIGI's returned `name` against 13F's `nameOfIssuer`, reject mismatches).
   - **Pre-2023 13F market values 1000× too small**: SEC's old "thousands" instruction. Era-boundary handling needed.
   - **Senate "paper PTR" amendments**: ~0% of observed disclosures. Skip+log in place; full handling needs separate PDF path.

10. **Deploy v1.0 as a remote MCP server.** Cloud Run or Firebase Functions in the `capitaledge-api` project. Needs Blaze plan upgrade.

11. **Commercial: brand, domain, customer validation, pricing, marketing site.** Not engineering. Don't build deployment infrastructure ahead of customer interest. Bottom-up funnel strategy applies (see Hard Lessons).

## Files In This Project

- `src/index.ts` — MCP server entry, stdio transport, dispatches list/call to the tool registry. Server version 0.3.0.
- `src/tools/index.ts` — registry of registered tools (3 active: insider, institutional, congressional)
- `src/tools/insider-transactions.ts` — first MCP tool (definition + handler + input validation)
- `src/tools/institutional-holdings.ts` — second MCP tool, exposes 13F holdings (Day 2)
- `src/tools/congressional-trades.ts` — third MCP tool, exposes Senate eFD PTRs (Day 3 afternoon). House data lands here too once that scraper ships.
- `src/scrapers/form4.ts` — Node/TS port of the Form 4 scraper
- `src/scrapers/13f.ts` — Node/TS port of the 13F scraper with sub-account aggregation, top-50 filter, position-change calc, closed-position synthesis (Day 2)
- `src/scrapers/senate.ts` — Node/TS port of the Senate eFD PTR scraper (Day 3 afternoon). Full session protocol with CSRF rotation, Origin header for Django 4 compatibility, multipart FormData on the data POST, paper-PTR detector. ~470 lines.
- `src/openfigi.ts` — OpenFIGI CUSIP→ticker enrichment with US-exchange preference, Firestore write-through cache, EDGAR-catalog cross-validation in `pickBestMatch`, single-char allowlist, USD-suffix rejection, and `searchOpenFigiByName` for the tertiary search-by-name fallback (Day 3)
- `src/sec-tickers.ts` — EDGAR `company_tickers_exchange.json` (Day 3 — switched from `company_tickers.json`) name fallback for CINS-coded foreign-domiciled CUSIPs and ticker-validation oracle. Exports `lookupTickerByName`, `isKnownUSTicker`, `searchEdgar`, `dumpEdgar`, `normalizeName`. Contains aggressive abbreviation-expansion table and jurisdiction-suffix stripping.
- `src/scrape.ts` — CLI runner for scrapers (`ping`, `form4`, `form4-feed`, `13f`, `13f-feed`, `funds`, `senate`, `senate-ptr`, plus Day 3 diagnostics: `test-normalize`, `search-edgar`, `dump-edgar`, `flush-cusip-cache`)
- `src/firestore.ts` — data layer with auto-detected stub vs live mode; `saveInsiderTransactions`, `saveInstitutionalHoldings`, `saveCongressionalTrades`, `queryInsiderTransactions`, `queryInstitutionalHoldings`, `queryCongressionalTrades`, `pingFirestore`, `getLiveDb`, `getDbIfLive`
- `src/types.ts` — shared types (`ResultEnvelope`, `InsiderTransaction`, `InstitutionalHolding`, `CongressionalTrade`, etc.)
- `package.json` — dependencies and scripts
- `tsconfig.json` — TypeScript config (strict mode, ES2022, NodeNext)
- `firebase.json` — Firebase CLI config (Day 3 evening). Currently just points to `firestore.indexes.json`. Will gain `rules` and `hosting` sections when those land.
- `.firebaserc` — Firebase project pin (Day 3 evening). Tells the CLI this folder = `capitaledge-api`. Both files safe to commit (no secrets).
- `.gitignore` — excludes `secrets/`, `node_modules/`, `dist/`
- `secrets/service-account.json` — Firebase service account key (NEVER commit; gitignored)
- `secrets/.gitkeep` — keeps the folder in version control without contents
- `reference/form4_scraper.js` — original browser-version scraper from Capital Edge (kept for diffing)
- `reference/congressional_scraper.js` — original Senate scraper (browser-version). **Ported Day 3 afternoon** to `src/scrapers/senate.ts` with three load-bearing fixes the reference had drifted on (see Hard Lessons). Kept for diffing.
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

April 30, 2026 — Day 3 late evening. **Senate end-to-end proven through the MCP tool.** 241 Senate trades in Firestore, three MCP queries returning real signal-rich data (NVDA buys/sells across senators, McCormick's $500K+ PA muni-bond ladder, Mullin's $50–100K UnitedHealth purchase). Three of five v1 tools officially passing the agent-native bar.

Firebase deploy plumbing is now permanent. Created `firebase.json` + `.firebaserc` so future index changes are one command (`firebase deploy --only firestore:indexes`) instead of clicking auto-generated URLs in the console. All five active composite indexes (insider, institutional, three congressional) deployed and live.

**Strategic clarity locked tonight that should outlast this session:** stay vertical (no medical/legal/sports — depth in US public disclosures only); v2 queue is **House → Form 144 → 13D/G → Lobbying → 8-K** in that order; customer funnel is bottom-up (free tier → indie devs → small fintechs → midsize firms → institutional, not the reverse). Both decisions captured as Hard Lessons with full reasoning.

**Immediate next move is item 1: port the House scraper.** Reference at `reference/house_scraper.js`. PDF parsing (each PTR is a separately-formatted PDF off the House Clerk XML index). Plan: `pdf-parse` library + heuristic table extraction. Estimated 3-4 hours given the Senate template is now proven. Closes the v1 congressional data picture (Senate ✓, House next), gives `get_congressional_trades` full coverage of both chambers.
