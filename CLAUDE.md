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
- **Owner-code regex for House PTRs must allow `\S`, not `[A-Z]` or even `[A-Za-z]`.** House PTR rows that involve a non-Self owner prefix the owner code (`SP` / `JT` / `DC`) directly onto the asset name with no separator: `SPApple`, `SPiShares`, `DCBJ`, `DCSTERIS`, `DCEMCOR`, `JTT.` (T. Rowe Price), `JTO'` (O'Reilly), `JT3M` (3M). The character right after the code can be uppercase, lowercase, a digit, a period, or an apostrophe — anything but whitespace. Initial regex `[A-Z][A-Z]` broke on lowercase (SPiShares) and digits. Second pass `[A-Za-z][A-Za-z]` broke on punctuation (JTT., JTO'). Final regex `^(SP|JT|DC)\S` accepts every observed case while correctly rejecting "JT Air" / "SP Plus" (legitimate non-owner-code phrases starting with those letters but separated by space). Captured during the House port — same shape will hit any future PDF-derived parser where columns aren't whitespace-delimited.
- **PDF text extraction adds invisible quirks the parser must defend against.** Three real ones from House PTRs: (1) URL-shaped strings get auto-linkified — `Amazon.com` becomes `[Amazon.com](http://Amazon.com)` in the extracted text, even though the source PDF shows plain text. Cosmetic; doesn't break ticker resolution since AMZN is matched separately. (2) Long asset names that wrap to a second line emit a *phantom partial row* with `asset_type: "Stock"` (the literal word) instead of `"ST"` (the code) — seen in Cisneros JLL row 8, Salazar Whirlpool row 25, McCormick UnitedHealth row 16. The real row immediately follows with correct `asset_type`, so dedup is the v1.1 fix. (3) Multi-line member-narrative comments (Larsen's "advisor explanation" rows, Cisneros's CNL Properties note) overflow into the *next* trade's asset_name field. Heuristic fix: detect asset_name longer than 200 chars or containing `. ` mid-string, strip to the ticker-bearing tail. Same root cause across all three: PDF line breaks aren't reliable row boundaries; the line-walker needs schema-aware row reconstruction. None blocking; all v1.1.
- **EDGAR's `primaryDocument` field points to XSL-rendered HTML, not raw XML.** The submissions API and full-text search both surface paths like `xsl144X01/primary_doc.xml` — that subdirectory is the human-readable rendering through an XSL stylesheet. The actual structured XML lives at the *sibling* path `primary_doc.xml` in the archive root. Without stripping the `xsl<schema>/` prefix, the parser fetches HTML and silently produces zero records (no error — the XML parse "succeeds" against the HTML, just yields nothing under the expected element paths). Caught during the Form 144 build; fix is a one-liner regex strip (`primaryDoc.replace(/^xsl[A-Z0-9]+\//, "")`). Same fix needed in any future scraper for SEC filing types that ship structured XML (Form 144, Form 13F, etc.).
- **Form 144 XML schema is wildly different from Form 4 — and "securitiesToBeSold" is misnamed in the spec.** Three real surprises from Form 144's `edgarSubmission` structured doc: (1) **No ticker symbol anywhere in the XML** — only `issuerCik`. Need CIK→ticker reverse lookup against EDGAR's `company_tickers.json`, which means the ticker cache has to be bidirectional (added `cikToTicker` index alongside the existing `tickerCache` keyed by ticker). (2) **The insider's name is at `issuerInfo.nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold`**, NOT in `filerInfo.filer.name`. The `filerInfo.filer.filerCredentials` block holds the *filing AGENT's* CIK (typically a law firm or filing service) — not the insider. Easy mistake to make if you assume `filerInfo` = "person who filed = insider." (3) **The `<securitiesToBeSold>` element is misnamed in the schema** — it's actually the *acquisition history* block (when the shares were originally acquired, nature of acquisition, payment date). The actual planned-sale data lives under `<securitiesInformation>` (`noOfUnitsSold`, `aggregateMarketValue`, `approxSaleDate`, `brokerOrMarketmakerDetails.name`). Counter-intuitive to the point of being deliberately confusing. (4) **Dates are MM/DD/YYYY**, not ISO. Convert to YYYY-MM-DD on parse so they're consistent with rest of system. All of these are spec-side, not parser bugs — the SEC's Form 144 schema reflects pre-XML form-design choices.
- **10b5-1 plan adoption date is a forward-looking-signal differentiator.** Form 144 includes `noticeSignature.planAdoptionDates.planAdoptionDate` when the planned sale falls under a Rule 10b5-1 trading plan (pre-arranged, automated). When that field is null, the sale is *discretionary* — the insider decided to sell because of something, not because the calendar said so. Capture as `plan_adoption_date` (string) plus `is_10b5_1_plan` (derived boolean) for agent convenience. Real example signal from Day 3 night's pull: Larry Fink's $35.6M BlackRock filing was discretionary; Tim Cook's $33M Apple filings were under a 10b5-1 plan adopted 2024-05-21. Different agent question gets different evidence.
- **CIK→ticker reverse lookup picks preferred-share tickers when the catalog has multiple entries.** EDGAR's `company_tickers.json` lists each ticker class as a separate entry — so a company with common stock and three preferred series shows up as four rows, all with the same CIK. Our naive reverse loop (last write wins) sometimes lands on the preferred-series ticker instead of common. Real Day 3 night examples: AGNC Investment Corp resolved to AGNCL (a preferred class) instead of AGNC; Live Oak Bancshares resolved to LOB-PA instead of LOB; Wintrust Financial resolved to WTFCN instead of WTFC. CIK is correct, just suboptimal ticker. v1.1 fix: prefer entries whose ticker has no hyphen-suffix or "-P" pattern (preferred-series indicator).
- **The XSL-prefix URL gotcha is universal across SEC ownership forms (3 / 4 / 4/A / 5 / 144).** Confirmed Day 4: Apple's Form 3 filings 100% ship the `xslF345X02/wk-form3_*.xml` path in `primaryDocument`, and ~40% of all Form 3 filings across a 7-day live-feed window did. Without `rawXmlPath()` to strip the prefix, the parser fetches XSL-rendered HTML and silently returns 0 records — fastest possible "looks fine, produces nothing" failure mode. The Form 144 Hard Lesson above is now generalized: **always strip `^xsl[A-Z0-9]+/` from any SEC ownership-form primaryDocument before fetching.** Add this to every new SEC-XML scraper as the very first thing. Form 4 hasn't been audited for the same issue — works empirically on Apple but unaudited on smaller filers; v1.1 polish.
- **`issuerTradingSymbol` in Form 3 XML is filer-supplied, not from a controlled vocabulary.** Trinity Industries' Form 3 (April 27, 2026) has `NYSE/TRN` in `issuerTradingSymbol` instead of just `TRN`. Two cascading problems: (1) the slash is illegal in Firestore document IDs (path separator), so saving fails with `"documentPath" must point to a document, but was "...-NYSE/TRN-ND-1"`. (2) Even after sanitizing the doc ID, agents querying `where ticker == "TRN"` won't match `NYSE/TRN`. Both fixed in `src/scrapers/form3.ts`: `normalizeTicker()` strips everything before the last slash (`NYSE/TRN` → `TRN`); `sanitizeForDocId()` replaces any remaining path-illegal char as defense in depth. Form 4 has the same conceptual exposure but hasn't surfaced yet — its ticker-from-XML reads are unaudited. Form 144 dodges this entirely by reverse-looking-up ticker from CIK (no XML ticker field at all), which is more authoritative but requires the bidirectional cache.
- **Form 3 derivative `shares_owned` is misleading for RSUs.** Form 3 reports `postTransactionAmounts.sharesOwnedFollowingTransaction` per holding, but most filers leave it empty (or 0) for derivatives like RSUs and stock options. The actual count lives at `underlyingSecurity.underlyingSecurityShares`. Our parser surfaces both fields faithfully, but agents reading `shares_owned` on an RSU row see 0 and conclude "no position" — that's wrong. The meaningful number for derivatives is `underlying_security_shares` (the count of underlying shares the derivative converts into). Document in the tool description; v1.1 polish would add a derived `effective_shares` field that picks the right one per row type.
- **MCP-tool extension beats new-tool when one filing anchors another.** Form 3 = baseline; Form 4 = deltas. Conceptually one query, one round trip. The cheap move was extending `get_insider_transactions` with `include_baseline:boolean` (default false) — when true, the response gains an optional `baselines: Form3Holding[]` field with matching Form 3 rows fetched in parallel via the same ticker/company_cik/officer_name filters. Preserves the locked 5-tool surface, doesn't change existing query shapes (purely additive), and gives agents the full ownership story without a second tool call. Same pattern will apply when 13D activist stakes anchor 13G ownership updates, when Form 144 planned-sales tie back to actual Form 4 execution, etc. Don't add new tools; add params that fold related data into the existing query path.

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

**Day 3 late evening — House port complete + cross-chamber MCP query proven (April 30):**

- ✅ **House scraper ported to Node/TS** (`src/scrapers/house.ts`, ~470 lines). Two-stage pipeline: (1) fetch the House Clerk yearly XML index at `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/<year>FD.xml` and parse with `fast-xml-parser` (`parseTagValue: false` to preserve DocIDs as strings), (2) for each PTR DocID, fetch the per-filing PDF, extract text via `pdf-parse` (lazy-loaded through dynamic import to avoid CommonJS/ESM tussle), and walk the lines using a transaction-signature anchor regex to identify trade rows.
- ✅ **Three CLI commands added** in `src/scrape.ts`:
  - `house-index [days]` — fetches XML index, prints PTR count + first/last 5 entries. Diagnostic.
  - `house-text <ptr_id>` — dumps the full extracted PDF text for one PTR. Diagnostic — used heavily during parser debugging.
  - `house [days] [--extract] [--save] [--max=N]` — the production command. `--extract` runs the per-trade parser, `--save` writes to Firestore, `--max=N` caps PTR count for testing.
- ✅ **Owner-code regex iterated 4 times to find the right shape.** Started at `[A-Z][A-Z]` (broke on lowercase second char in iShares), expanded to `[A-Za-z][A-Za-z]` (broke on JTT. and JTO'), settled on `^(SP|JT|DC)\S` after seeing real PTRs with digits, periods, apostrophes, and lowercase chars all appearing right after the owner code. Captured as a Hard Lesson above.
- ✅ **Programmatic control-char regex builder** in house.ts. `Edit` tool was injecting literal control bytes when the regex was written inline; rewrote as `String.fromCharCode(...)` programmatic construction. Workaround for tool-induced corruption — would have been silently broken otherwise.
- ✅ **340 House trades written to Firestore** via `house 30 --extract --save`. Idempotent doc IDs (`house-<ptr_id>-<row_idx>`), zero parse errors, full schema match with Senate records (chamber field correctly set to "house").
- ✅ **Cross-chamber MCP query proven end-to-end** through Claude Desktop:
  - "What congressional trades happened in NVDA in the last 30 days?" → 6 hits across both chambers: Tim Moore (R-NC) sell $15K-$50K, Daniel Meuser spouse partial sells x2 (PA), Gilbert Cisneros (D-CA) buy + sell same week, John Boozman (R-AR) joint buy. **5 sells vs 1 buy across both chambers — directional signal in one round-trip.**
- ✅ **Total `congressional_trades` collection**: 241 Senate + 340 House = **581 records spanning both chambers from one MCP tool.** v1 congressional data picture officially closed.
- ✅ **Pushed to GitHub on `main`** late Day 3.

**Day 3 night — Form 144 scraper + 4th MCP tool live (April 30, deep evening):**

- ✅ **Form 144 scraper ported to Node/TS** (`src/scrapers/form144.ts`, ~370 lines). Same EDGAR submissions-API + full-text-search plumbing as Form 4. Schema is meaningfully different — captured as Hard Lessons above. Three iterations to get the URL right (XSL-rendered HTML vs raw XML), then one clean rewrite once the actual schema was visible from the live response dump.
- ✅ **`Form144Filing` type** added to `src/types.ts` with 22 fields. Includes `is_10b5_1_plan` (boolean) and `plan_adoption_date` (string) for the discretionary-vs-scheduled-sale signal. Also `exchange`, `notice_date`, `pct_of_outstanding` (computed from `shares_to_be_sold` / `shares_outstanding`).
- ✅ **`saveForm144Filings` + `queryForm144Filings`** added to `src/firestore.ts` → new collection `planned_insider_sales`. Same idempotent doc-id scheme (`{accession}-{ticker}-{lineNumber}`), same substring-filter truncation handling for `filer_name`.
- ✅ **CLI commands** `form144 <ticker> [--save]` and `form144-feed [days] [--save]` added to `src/scrape.ts`.
- ✅ **MCP tool `get_planned_insider_sales`** registered (`src/tools/planned-insider-sales.ts`, the 4th of 5 v1 tools). Filter surface: ticker, company_cik, filer_name, min_value, since/until, sort_by (filing_date | approximate_sale_date | aggregate_market_value), sort_order, limit. Tool description emphasizes the forward-looking-vs-Form-4-realized distinction.
- ✅ **Server version bumped to 0.4.0** in `src/index.ts`. Four tools registered: `get_insider_transactions`, `get_institutional_holdings`, `get_congressional_trades`, `get_planned_insider_sales`.
- ✅ **Three new Firestore composite indexes** added to `firestore.indexes.json` for the new collection: ticker+filing_date desc, ticker+aggregate_market_value desc, ticker+approximate_sale_date asc. Awaits `firebase deploy --only firestore:indexes` to go live.
- ✅ **20 AAPL Form 144 filings parsed clean** as the first sanity check — Tim Cook's recurring $30M+ planned sales under 10b5-1 plan adopted 2024-05-21, plus 5 Arthur Levinson (Apple Chairman) discretionary sales of 2001-vintage stock totaling ~$66M. Levinson's filings have null `plan_adoption_date` — discretionary, not scheduled. Exactly the agent-native signal the type was designed to capture.
- ✅ **90 Form 144 filings saved to Firestore** via `form144-feed 7 --save` (89% success rate; 11 SKIPs split between fast-xml-parser's max-nested-tags default and transient SEC 503s). Signal-rich pull across the week:
  - Larry Fink (BlackRock): 33,900 shares, $35.6M, **discretionary** (no 10b5-1)
  - Steve Sanghi (Microchip): 416,581 shares, $36.9M, 10b5-1 plan
  - WEST CLAY CAPITAL LLC (CoreWeave Director/Officer): 300,000 founders shares, $33M, 10b5-1
  - Niraj Shah (Wayfair Officer/Director): 113,863 founders shares acquired 2002, $8.8M, 10b5-1
  - Nathan Blecharczyk (Airbnb Officer/Director): 11,538 founders shares acquired 2008, $1.6M, 10b5-1
  - The Narayen Family Trust (Adobe Officer): 75,000 shares, $18.3M, **discretionary**
  - DSS INC (Impact Biomedical 10% Stockholder): 31.9M shares = **29.6% of outstanding**, $23M (whole-position exit)
  - Cambrian BioPharma (Sensei Biotherapeutics 10% Stockholder): 11.6% of outstanding being sold
  - Grayscale crypto trusts (DCG International) constantly filing 144s for GAVA, GTAO, GSNR, DEFG, GDOG, MANA, STCK, GLNK, GXLM — interesting data exhaust nobody else exposes
- ✅ **Four of five v1 tools officially built and serving real Firestore data.** `get_member_profile` is the last one and depends on the bioguide catalog ingestion (item 5 in What's Open). MCP-side test of `get_planned_insider_sales` deferred to next session — needs Claude Desktop restart to pick up the new tool registration.

**Day 3 night v1.1 polish queue (Form 144 observed, none blocking):**

- **Preferred-share-class ticker reverse lookup ambiguity** — captured as a Hard Lesson. AGNCL/AGNC, LOB-PA/LOB, BFH-PA/BFH, CFG-PI/CFG, WTFCN/WTFC, SCHW-PJ/SCHW, MCHPP/MCHP. CIK is correct, ticker is suboptimal. Fix: prefer entries with no hyphen-suffix or "-P" pattern when multiple tickers share a CIK.
- **8 "Maximum nested tags exceeded" SKIPs** — fast-xml-parser default limit (32 nested levels?) hit on some Form 144s. Bump `maxNestingDepth` in the parser config in v1.1.
- **3 transient SEC 503 SKIPs** — server overload. Add bounded retry with exponential backoff in `fetchText` (3 retries at 1s/2s/4s, then give up).
- **`primary_doc.xml` URL fragility** — only one filing format observed. If a filing ships text-only or PDF-only (older paper-filed 144s), the parser silently skips. Acceptable for v1 since Form 144 has been mandatory electronic since late 2022; flag if pre-2022 filings ever become a query target.

**Day 3 late evening v1.1 polish queue (observed in House data, none blocking):**

- **Cisneros AMZN rows** — `[Amazon.com](http://Amazon.com)` markdown-link garbage from PDF text extraction. Strip in v1.1.
- **Larsen records 6, 8, 9** — comment-overflow contamination ("based company, purchased those assets in March...NextEra Energy"). Same root cause as phantom rows — PDF line breaks aren't row boundaries.
- **Salazar row 25, McCormick row 16, Cisneros row 8** — phantom partial rows with `asset_type: "Stock"` instead of `"ST"`. Asset-name wrap onto second PDF line creates orphan synthetic row.
- **OpenFIGI maps Alibaba CUSIP to BABAF (OTC pink-sheet) instead of BABA (NYSE ADR).** Add to wrong-issuer list alongside AMBAC→OSG. Issuer-name cross-validation fix from v1.1 deferral list will catch this category.
- **FISV ticker for Fiserv** — Fiserv was renamed FI in 2024. Catalog gap in `company_tickers_exchange.json`. Will resolve once SEC updates their file or via OpenFIGI search-by-name fallback on next cusip_map flush.

**Day 4 morning — Form 3 scraper + include_baseline live (May 1, 2026):**

- ✅ **Form 3 scraper ported to Node/TS** (`src/scrapers/form3.ts`, ~440 lines). Same EDGAR plumbing as Form 4 / Form 144 — third use of the SEC-XML template, fastest port yet. Schema is Form 4's sibling: `ownershipDocument` root, multi-owner OR-handling, `parseTagValue:false`, but `nonDerivativeHolding` / `derivativeHolding` instead of `...Transaction`. No transaction shares — just position snapshots. One row per security class held.
- ✅ **`Form3Holding` type** added to `src/types.ts` with 26 fields. Distinguishes derivative (options/warrants/RSUs) from non-derivative (common/preferred). Captures `direct_or_indirect`, `nature_of_indirect_ownership`, `conversion_or_exercise_price`, `exercise_date`, `expiration_date`, `underlying_security_title`, `underlying_security_shares`, `is_director` / `is_officer` / `is_ten_percent_owner` / `is_other` flags.
- ✅ **`saveForm3Holdings` + `queryForm3Holdings`** added to `src/firestore.ts` → new collection `initial_ownership_baselines`. Idempotent doc IDs (`{accession}-{ticker}-ND-{lineNumber}` for non-derivative, `-D-` for derivative). Same substring-filter truncation handling for `filer_name`.
- ✅ **CLI commands** `form3 <TICKER> [--save]` and `form3-feed [days] [--save]` added to `src/scrape.ts`. Sibling shape to `form144` / `form4`.
- ✅ **MCP-tool extension (NOT a new tool — preserves the locked 5-tool surface):** `get_insider_transactions` gains an `include_baseline:boolean` param (default false). When true, parallel-fetches matching Form 3 rows via `queryForm3Holdings` (same ticker / company_cik / officer_name filters) and attaches them under a `baselines` field on the response envelope. Constraint: requires `ticker` or `company_cik` to be set (avoids unbounded baseline queries). One round trip stitches Form 4 deltas to Form 3 starting positions. Captured as a Hard Lesson.
- ✅ **Server version bumped to 0.5.0** in `src/index.ts`.
- ✅ **Three new Firestore composite indexes** added to `firestore.indexes.json` for the new collection: `ticker+filing_date desc`, `filer_cik+filing_date desc`, `is_derivative+filing_date desc`. Deployed via `firebase deploy --only firestore:indexes` Day 4 morning.
- ✅ **38 AAPL Form 3 rows backfilled** as the first sanity check. Sabih Khan as new COO: 999,759 common direct + 31,632 family trust + 7 RSU tranches (22K-66K underlying each). Kevan Parekh CFO RSU stack. Apple director starting positions back to 2015 — Bell, Lozano, Austin, Gorsky, Adams, Srouji, O'Brien, Newstead.
- ✅ **60 Form 3 rows from 7-day live feed saved to Firestore** (60% parse rate; the other 40 filings fell to the XSL-prefix bug *before* the fix landed). Standouts: Pershing Square IPO insiders (Gonnella CFO 2.8M common + 5.6M M-units underlying, Healey 76K), Goldman Sachs as 10%+ holder of QVC preferreds, HRT Financial as 10%+ on Fitness Champs, Schmid Group N.V. CEO with 4.9M+10.3M ordinary shares + 2M private warrants.
- ✅ **Two bugs caught and fixed during smoke testing — captured as Hard Lessons above:**
  - XSL-prefix URL strip — Form 3 filings (especially modern WK Group filings and Apple 100% of the time) ship `xslF345X02/...` paths in `primaryDocument`. Without `rawXmlPath()` the parser silently produces 0 records.
  - Exchange-prefixed `issuerTradingSymbol` — Trinity Industries' Form 3 has `NYSE/TRN` instead of `TRN`. Slash breaks Firestore doc IDs and ticker-equality queries. Added `normalizeTicker()` to strip the prefix and `sanitizeForDocId()` for defense in depth.
- ✅ **Pushed to GitHub on `main`** as commit `5f8f9dd` Day 4 morning. v0.5.0 milestone.

**Day 4 morning v1.1 polish queue (Form 3 observed, none blocking):**

- **One stale Firestore doc** — `0000099780-26-000031-NYSE-TRN-ND-1` from the pre-fix run sits as an orphan in `initial_ownership_baselines`. The fixed run wrote `0000099780-26-000031-TRN-ND-1`. Not worth a cleanup script.
- **Derivative `shares_owned` is misleading for RSUs** — captured as a Hard Lesson. v1.1 fix: add an `effective_shares` derived field that picks `underlying_security_shares` for derivatives, `shares_owned` for non-derivative.
- **Multi-owner `filer_cik` formatting** — joins multiple owners with `" / "` (e.g., `"0000886982 / 0000769993"` for Goldman's two-entity Form 3 on QVC preferreds). Strict-match Firestore queries on `filer_cik` won't work across multi-owner filings. v1.1 fix: also write a `primary_filer_cik` field with just the first CIK for index-friendly equality matching.
- **Form 4 XSL-prefix audit unfinished** — `src/scrapers/form4.ts` doesn't strip the prefix, but Form 4 has been working empirically on Apple. Could be silently dropping coverage on smaller filers. Worth a one-time audit run with the strip applied to compare row counts.

## What's Open / Next Up

In rough priority order. Day 4 morning, **Form 3 baselines are live, server is at v0.5.0, and `get_insider_transactions` has the `include_baseline` extension.** Indexes deployed. Code pushed to GitHub. Only the MCP-side smoke-test is left before moving to 13D/G:

1. **🔴 IMMEDIATE NEXT MOVE — Restart Claude Desktop and smoke-test the v0.5.0 tools end-to-end.** Two tools changed since the running Desktop instance was started: `get_planned_insider_sales` was added (Day 3 night, never verified through MCP), and `get_insider_transactions` got the `include_baseline` param (Day 4 morning). Restart Claude Desktop so it re-spawns the MCP server, then run two queries:
   - **Form 144 sanity check** (Day 3 night carry-over): "What insiders filed planned-sale notices in the last week sorted by aggregate market value?" Should surface Sanghi/Microchip $36.9M, Fink/BlackRock $35.6M, CoreWeave WEST CLAY $33M. Filter `is_10b5_1_plan: false` and Fink + Narayen + Levinson should dominate.
   - **Form 3 baseline stitching** (Day 4 new): "What insider trades happened at AAPL in the last 90 days, and what were the baselines?" Should call `get_insider_transactions(ticker:"AAPL", include_baseline:true, since:...)` and return Form 4 trades alongside the 38 Form 3 baselines we just loaded — Khan COO at 1M, Parekh CFO RSU stack, the rest of the exec onboarding history back to 2015.

2. **13D/13G — activist 5%+ ownership scraper.** Same EDGAR plumbing as Form 4 / Form 144 / Form 3 — fourth use of the SEC-XML template. With `rawXmlPath()`, `normalizeTicker()`, multi-owner OR-handling, and CIK reverse-lookup all proven, this should be the fastest port yet. Estimated under an hour. Reveals takeover targets, activist campaigns, hostile bids. Not cleanly aggregated outside Bloomberg.

3. **Lobbying disclosures (LDA) scraper.** Senate Office of Public Records. New portal, new auth flow. Estimated 4–5 hours. Adjacent to congressional trades — same buyer profile asks for both ("what's Pfizer paying lobbyists for AND which senators are trading their stock").

4. **8-K material events scraper.** Free-text item-code parsing makes this the hardest of the v2 batch. Estimated 3–4 hours. Highest-volume real-time disclosure stream — acquisitions, executive departures, earnings warnings.

5. **`bioguide_id` catalog ingestion** for congressional member enrichment. Spec at `C:\CapitalEdge\CONGRESS_DATA_PIPELINE.md`. Source: https://github.com/unitedstates/congress-legislators YAML. Once loaded, every senate/house trade record gets enriched with `party`, `state`, `state_district`, photos, committee assignments at query time. Unblocks `get_member_profile` MCP tool.

6. **Polish pass on Senate parser output (v1.1, optional)**:
   - Whitespace cleanup in bond `asset_name` fields (current output has `\n\n\n` runs from how eFD renders bond descriptors).
   - Back-fill ticker from `asset_name` when source has it inline (e.g., "GOOGL - Alphabet Inc.", "MRSH - Marsh & McLennan...").

7. **Polish pass on House parser output (v1.1, optional)** — captured Day 3 late evening:
   - Strip markdown-link auto-formatting from asset names (`[Amazon.com](http://Amazon.com)` → `Amazon.com`).
   - Detect + dedup phantom partial rows where `asset_type` is the literal word `"Stock"` instead of `"ST"` (Cisneros JLL, Salazar Whirlpool, McCormick UnitedHealth pattern).
   - Detect + strip comment-overflow contamination where multi-line member-narrative bleeds into the next row's asset_name (Larsen "advisor explanation" pattern). Heuristic: asset_name > 200 chars or contains mid-sentence period.

8. **Implement remaining v1 tools:** `get_member_profile`, `get_company_filings_summary`. Full design in `TOOL_DESIGN.md`. Three of five v1 tools built and proven. `get_member_profile` depends on the bioguide catalog (item 5); `get_company_filings_summary` is a thin aggregator over the other tools' data.

9. **Known v1.1 deferrals:**
   - **Wrong-issuer OpenFIGI mappings**: AMBAC → OSG, BABAF (Alibaba OTC) instead of BABA (Alibaba NYSE ADR), etc. Needs issuer-name cross-validation (compare OpenFIGI's returned `name` against 13F's `nameOfIssuer`, reject mismatches).
   - **Pre-2023 13F market values 1000× too small**: SEC's old "thousands" instruction. Era-boundary handling needed.
   - **Senate "paper PTR" amendments**: ~0% of observed disclosures. Skip+log in place; full handling needs separate PDF path.
   - **FISV ticker stale** — Fiserv was renamed FI in 2024. Catalog gap in `company_tickers_exchange.json`. Will resolve via OpenFIGI search-by-name on next cusip_map flush.

10. **Deploy v1.0 as a remote MCP server.** Cloud Run or Firebase Functions in the `capitaledge-api` project. Needs Blaze plan upgrade.

11. **Commercial: brand, domain, customer validation, pricing, marketing site.** Not engineering. Don't build deployment infrastructure ahead of customer interest. Bottom-up funnel strategy applies (see Hard Lessons).

12. **Open architectural question (Greg flagged Day 3 late evening, parking for now):** should the dashboard at `C:\CapitalEdge` consume from the hub's Firestore directly (Option B) or keep the locked dual-scrape posture (Option A)? Data shapes are deliberately compatible — `congressional_trades`, `insider_trades`, `institutional_holdings` here match the dashboard's planned schema. Re-opening this depends on Derek's actual scraper-pipeline state and partnership-friction tolerance. Greg said "I will revisit the question." Don't decide for him.

## Files In This Project

- `src/index.ts` — MCP server entry, stdio transport, dispatches list/call to the tool registry. Server version 0.5.0.
- `src/tools/index.ts` — registry of registered tools (4 active: insider, institutional, congressional, planned-insider-sales)
- `src/tools/insider-transactions.ts` — first MCP tool (definition + handler + input validation). Day 4: gained `include_baseline:boolean` param — when true, parallel-fetches matching Form 3 rows from `initial_ownership_baselines` and attaches them under a `baselines` field on the response envelope. Lets agents stitch Form 4 deltas + Form 3 starting positions in one round trip.
- `src/tools/institutional-holdings.ts` — second MCP tool, exposes 13F holdings (Day 2)
- `src/tools/congressional-trades.ts` — third MCP tool, exposes both Senate eFD PTRs and House Clerk PTRs (Day 3 afternoon + late evening). 581 records combined as of Day 3 wrap. Cross-chamber NVDA query proven through Claude Desktop.
- `src/tools/planned-insider-sales.ts` — fourth MCP tool, exposes Form 144 planned-sale notices (Day 3 night). 90 records initial pull. Tool name `get_planned_insider_sales`. Forward-looking complement to `get_insider_transactions` (Form 4 = realized; 144 = intent).
- `src/scrapers/form3.ts` — Node/TS port of the Form 3 scraper (Day 4 morning, ~440 lines). Third use of the SEC-XML template after Form 4 and Form 144 — fastest port yet. `ownershipDocument` root with `nonDerivativeHolding` / `derivativeHolding` tables (Form 4 has `...Transaction` instead). One row per security class; multi-owner OR-handling; `parseTagValue:false` to protect numeric-looking strings; `rawXmlPath()` to strip the `xsl<schema>/` prefix from primaryDocument; `normalizeTicker()` for exchange-prefixed symbols (`NYSE/TRN` → `TRN`); `sanitizeForDocId()` for Firestore doc-ID safety.
- `src/scrapers/form4.ts` — Node/TS port of the Form 4 scraper
- `src/scrapers/13f.ts` — Node/TS port of the 13F scraper with sub-account aggregation, top-50 filter, position-change calc, closed-position synthesis (Day 2)
- `src/scrapers/senate.ts` — Node/TS port of the Senate eFD PTR scraper (Day 3 afternoon). Full session protocol with CSRF rotation, Origin header for Django 4 compatibility, multipart FormData on the data POST, paper-PTR detector. ~470 lines.
- `src/scrapers/house.ts` — Node/TS port of the House Clerk PTR scraper (Day 3 late evening). Two-stage pipeline: yearly XML index from `disclosures-clerk.house.gov` → per-PTR PDF text extraction via lazy-loaded `pdf-parse` → heuristic line-walker with TX_SIG_RE anchor regex for trade rows. Owner-code regex `^(SP|JT|DC)\S` handles all observed punctuation/case mixes (SPiShares, DCBJ, JTT., JTO', etc.). Programmatic control-char regex via `String.fromCharCode` (workaround for tool-induced byte injection). ~470 lines.
- `src/scrapers/form144.ts` — Node/TS port of the Form 144 scraper (Day 3 night). Same EDGAR submissions-API + full-text-search plumbing as Form 4. Real schema is wildly different from Form 4 (no ticker, MM/DD/YYYY dates, insider-name-in-issuerInfo, mis-named `securitiesToBeSold` element holding acquisition history not sale data) — captured as Hard Lessons. Loads ticker cache bidirectionally (ticker→cik AND cik→ticker) since Form 144 only includes CIK. Captures the 10b5-1 plan adoption date as a discretionary-vs-scheduled-sale signal. Strips `xsl<schema>/` URL prefix to reach raw XML rather than XSL-rendered HTML. ~370 lines.
- `src/openfigi.ts` — OpenFIGI CUSIP→ticker enrichment with US-exchange preference, Firestore write-through cache, EDGAR-catalog cross-validation in `pickBestMatch`, single-char allowlist, USD-suffix rejection, and `searchOpenFigiByName` for the tertiary search-by-name fallback (Day 3)
- `src/sec-tickers.ts` — EDGAR `company_tickers_exchange.json` (Day 3 — switched from `company_tickers.json`) name fallback for CINS-coded foreign-domiciled CUSIPs and ticker-validation oracle. Exports `lookupTickerByName`, `isKnownUSTicker`, `searchEdgar`, `dumpEdgar`, `normalizeName`. Contains aggressive abbreviation-expansion table and jurisdiction-suffix stripping.
- `src/scrape.ts` — CLI runner for scrapers (`ping`, `form3`, `form3-feed`, `form4`, `form4-feed`, `form144`, `form144-feed`, `13f`, `13f-feed`, `funds`, `senate`, `senate-ptr`, `house`, `house-index`, `house-text`, plus Day 3 diagnostics: `test-normalize`, `search-edgar`, `dump-edgar`, `flush-cusip-cache`)
- `src/firestore.ts` — data layer with auto-detected stub vs live mode; `saveInsiderTransactions`, `saveInstitutionalHoldings`, `saveCongressionalTrades`, `saveForm144Filings`, `saveForm3Holdings`, `queryInsiderTransactions`, `queryInstitutionalHoldings`, `queryCongressionalTrades`, `queryForm144Filings`, `queryForm3Holdings`, `pingFirestore`, `getLiveDb`, `getDbIfLive`
- `src/types.ts` — shared types (`ResultEnvelope`, `InsiderTransaction`, `InstitutionalHolding`, `CongressionalTrade`, `Form144Filing`, `Form3Holding`, `InsiderTransactionsEnvelope`, etc.)
- `package.json` — dependencies and scripts
- `tsconfig.json` — TypeScript config (strict mode, ES2022, NodeNext)
- `firebase.json` — Firebase CLI config (Day 3 evening). Currently just points to `firestore.indexes.json`. Will gain `rules` and `hosting` sections when those land.
- `.firebaserc` — Firebase project pin (Day 3 evening). Tells the CLI this folder = `capitaledge-api`. Both files safe to commit (no secrets).
- `.gitignore` — excludes `secrets/`, `node_modules/`, `dist/`
- `secrets/service-account.json` — Firebase service account key (NEVER commit; gitignored)
- `secrets/.gitkeep` — keeps the folder in version control without contents
- `reference/form4_scraper.js` — original browser-version scraper from Capital Edge (kept for diffing)
- `reference/congressional_scraper.js` — original Senate scraper (browser-version). **Ported Day 3 afternoon** to `src/scrapers/senate.ts` with three load-bearing fixes the reference had drifted on (see Hard Lessons). Kept for diffing.
- `reference/house_scraper.js` — original House scraper (browser-version). **Ported Day 3 late evening** to `src/scrapers/house.ts` with iterative owner-code regex hardening (4 rounds) and programmatic control-char regex builder (workaround for byte-corruption during inline regex authoring). Kept for diffing.
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
npx tsx src/scrape.ts ping                       # confirms credentials
npx tsx src/scrape.ts form3 AAPL                 # AAPL initial-ownership baselines (Form 3)
npx tsx src/scrape.ts form3-feed 7 --save        # 7-day Form 3 across all companies, saves
npx tsx src/scrape.ts form4 AAPL                 # hits SEC, prints AAPL trades
npx tsx src/scrape.ts form4-feed 1 --save        # 1-day live feed, saves to Firestore
npx tsx src/scrape.ts form144 AAPL               # AAPL planned-sale notices
npx tsx src/scrape.ts form144-feed 7 --save      # 7-day Form 144 across all companies, saves
npx tsx src/scrape.ts senate 7 --save            # 7-day Senate PTRs, saves
npx tsx src/scrape.ts house 7 --extract --save   # 7-day House PTRs, saves
npm run dev                                       # boots MCP server in LIVE MODE
```

## Last Updated

May 1, 2026 — Day 4 morning. **Form 3 scraper + `include_baseline` extension on `get_insider_transactions` live.** Server v0.5.0. Code pushed (commit `5f8f9dd`); Firestore indexes deployed.

State at session wrap:
- 76 Form 4 insider trades (`insider_trades`)
- 42+ Berkshire 13F holdings (`institutional_holdings`)
- 241 Senate + 340 House = 581 congressional trades (`congressional_trades`)
- 90 Form 144 planned-sale notices (`planned_insider_sales`)
- 98 Form 3 initial-ownership rows (`initial_ownership_baselines`) ← new today (38 AAPL backfill + 60 from 7-day live feed)

Four MCP tools registered and serving: `get_insider_transactions` (now with `include_baseline`), `get_institutional_holdings`, `get_congressional_trades`, `get_planned_insider_sales`. The fifth (`get_member_profile`) depends on the bioguide catalog ingestion (item 5 in What's Open) and is unblocked technically — just hasn't been built yet.

**Form 3 highlights from today's pull** (the data nobody else exposes as a clean baseline):
- Sabih Khan as Apple's new COO: 999,759 common direct + 31,632 via family trust + 7 RSU tranches (22K-66K underlying each). The baseline that anchors every future Khan Form 4.
- Pershing Square's IPO: Gonnella CFO 2.8M common + 5.6M M-units underlying, Healey 76K, Pershing Square Management LLC special voting share.
- Goldman Sachs as 10%+ holder of QVC Group preferreds (2.97M Series A Cumulative Redeemable).
- HRT Financial as 10%+ on Fitness Champs Holdings (484K Class A).
- Schmid Group N.V. CEO Christian Schmid: 4.97M + 10.34M ordinary shares + 2M private warrants at $11.50 strike.
- Apple director starting positions back to 2015 — Bell, Lozano, Austin, Gorsky, Adams, Srouji, O'Brien, Newstead, Parekh, Borders.

**The `include_baseline:boolean` extension** on `get_insider_transactions` is the load-bearing agent-side win. One round trip now returns Form 4 deltas (e.g. Tim Cook sold 50K shares) AND the matching Form 3 baselines (e.g. Cook started at X). No second tool call needed. Same pattern (extend-don't-add) will apply for 13D-anchors-13G, Form 144-anchors-Form-4-execution, etc. Captured as a Hard Lesson.

**Strategic clarity locked Day 3 that still holds:** stay vertical (no medical/legal/sports — depth in US public disclosures only); v2 queue is **House ✓ → Form 144 ✓ → Form 3 ✓ → 13D/G → Lobbying → 8-K** with Form 3 just shipped (slotted ahead of 13D/G per Greg's Day 4 re-rank — Form 3 baseline closes the v1 ownership gap, 13D/G is independent activist data); customer funnel stays bottom-up.

**Immediate next move on session resume:**
1. Restart Claude Desktop so the v0.5.0 server picks up the `include_baseline` param plus the still-unverified `get_planned_insider_sales` tool.
2. Smoke-test through Claude Desktop with two queries:
   - **Form 144 carry-over from Day 3 night**: "What insiders filed planned-sale notices in the last week sorted by aggregate market value?" Should surface Sanghi/Microchip $36.9M, Fink/BlackRock $35.6M, CoreWeave WEST CLAY $33M. Filter `is_10b5_1_plan: false` and Fink + Narayen + Levinson should dominate.
   - **Form 3 baseline stitching**: "What insider trades happened at AAPL in the last 90 days, and what were the baselines?" Should call `get_insider_transactions(ticker:"AAPL", include_baseline:true, since:...)` and return Form 4 trades alongside the 38 Form 3 baselines.
3. Move to v2 item #2: **13D/13G activist 5%+ ownership scraper.** Same SEC-XML template (fourth use), with `rawXmlPath()` and `normalizeTicker()` already proven. Should be fastest port yet — under an hour.

**Open architectural question (parking, not deciding):** Greg flagged the dashboard-vs-hub data sourcing question late Day 3 — should `C:\CapitalEdge` consume from the hub's Firestore directly (Option B) or keep the locked dual-scrape posture (Option A)? Field shapes are deliberately compatible. Deferred until Greg revisits. See item 12 in "What's Open / Next Up" for the full framing.
