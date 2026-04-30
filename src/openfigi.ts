/**
 * OpenFIGI integration — CUSIP → ticker enrichment.
 *
 * Why this exists: the SEC 13F informationTable XML identifies positions by
 * 9-digit CUSIP, not by ticker. Customers expect to query by ticker. So we
 * need a CUSIP→ticker lookup. OpenFIGI is Bloomberg's free public mapping
 * service — same data the rest of the industry uses.
 *
 * Free tier (no API key):
 *   - 25 requests/minute
 *   - up to 5 jobs per request
 *   = ~125 mappings per minute steady state
 *
 * With API key (set OPENFIGI_API_KEY env var):
 *   - 50 requests/minute
 *   - up to 100 jobs per request
 *   = ~5000 mappings per minute steady state
 *
 * Get a free key at https://www.openfigi.com/api (just register an email).
 *
 * Caching: every successful mapping is written to Firestore at
 * `cusip_map/{cusip}` so subsequent scrape runs hit the cache rather than
 * the OpenFIGI API. First run is the only slow one.
 */

import { isKnownUSTicker } from "./sec-tickers.js";

const OPENFIGI_URL = "https://api.openfigi.com/v3/mapping";
const API_KEY = process.env.OPENFIGI_API_KEY ?? "";
const JOBS_PER_REQUEST = API_KEY ? 100 : 5;
const REQUESTS_PER_MINUTE = API_KEY ? 50 : 25;
const REQUEST_DELAY_MS = Math.ceil(60_000 / REQUESTS_PER_MINUTE);

/**
 * Allowlist for single-character tickers — these are real, currently-active
 * US-listed equities. Single-letter tickers outside this set are almost
 * always Bloomberg internal codes or stale listings (like "P" for Pandora,
 * delisted in 2019) and should be rejected as a `pickBestMatch` candidate.
 */
const SINGLE_CHAR_ALLOWLIST = new Set([
  "V", // Visa
  "C", // Citigroup
  "F", // Ford
  "T", // AT&T
  "S", // SentinelOne
  "X", // U.S. Steel
  "K", // Kellogg / Kellanova
  "M", // Macy's
  "O", // Realty Income
  "U", // Unity Software
  "Z", // Zillow
]);

/**
 * Reject any ticker that's not a plausible equity ticker. Catches:
 *   - USD-suffix foreign cross-listings (NCSUSD, SGENUSD, GTT1USD)
 *   - Non-allowlisted single-letter tickers (delisted-Pandora "P", etc.)
 *   - Options contracts. OpenFIGI's `/v3/search` returns equity OPTIONS in
 *     addition to common stock and doesn't reliably populate `securityType`
 *     in search responses — so options leak through the common-stock filter.
 *     Options tickers always contain a space ("RNA 09/16/22 P5", "DAY
 *     12/20/24 C50"). Real equity tickers are at most 6 chars (BRK-A, JPM-PC,
 *     LLYVK) and never contain whitespace. Rejecting whitespace is the
 *     simplest correct test.
 */
function isObviouslyBadTicker(ticker: string): boolean {
  if (!ticker) return true;
  if (/\s/.test(ticker)) return true;
  if (/USD$/i.test(ticker)) return true;
  if (ticker.length === 1 && !SINGLE_CHAR_ALLOWLIST.has(ticker.toUpperCase())) {
    return true;
  }
  return false;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface CusipMapping {
  cusip: string;
  ticker: string;
  name: string | null;
  market_sector: string | null;
  /** ISO date when this mapping was verified (set on cache write) */
  last_verified: string;
}

interface OpenFigiJob {
  idType: "ID_CUSIP";
  idValue: string;
}

interface OpenFigiResultItem {
  ticker?: string;
  name?: string;
  marketSector?: string;
  exchCode?: string;
  securityType?: string;
}

interface OpenFigiResult {
  data?: OpenFigiResultItem[];
  error?: string;
  warning?: string;
}

// Type-only — avoid loading firebase-admin in stub mode
type FirestoreInstance = import("firebase-admin/firestore").Firestore;

/**
 * Result type for `lookupCusips` — includes the OpenFIGI-returned issuer
 * name so the caller can do issuer-name cross-validation against the 13F's
 * `nameOfIssuer` to detect wrong-issuer mappings (e.g., OpenFIGI returning
 * ticker OSG/Overseas Shipholding for Ambac Financial's CUSIP).
 */
export interface CusipLookupResult {
  ticker: string;
  /** OpenFIGI's name for the security (matches CusipMapping.name) */
  name: string | null;
}

/**
 * Look up tickers for a batch of CUSIPs. Returns a map of CUSIP → result
 * containing both the resolved ticker and the OpenFIGI-returned issuer name.
 * Missing CUSIPs (no mapping found) are present in the map with empty
 * ticker and null name.
 *
 * Uses Firestore as a write-through cache when `db` is provided. Without a db,
 * every CUSIP hits OpenFIGI directly — fine for ad-hoc CLI runs.
 *
 * Prefers US-listed common stock when multiple matches exist (e.g., a CUSIP
 * that maps to both NYSE-listed common and a preferred share). Picks the
 * most reasonable single ticker for the position, not all variants.
 *
 * Note: this function does not validate the OpenFIGI name against the 13F's
 * issuer name. That validation happens at the call site (in 13f.ts) so we
 * preserve cache hits even when names mismatch — the customer-visible
 * filtering happens there, not here.
 */
export async function lookupCusips(
  cusips: string[],
  db?: FirestoreInstance,
): Promise<Map<string, CusipLookupResult>> {
  const result = new Map<string, CusipLookupResult>();
  const unique = Array.from(new Set(cusips.map((c) => c.trim()))).filter(
    (c) => c.length > 0,
  );
  if (unique.length === 0) return result;

  // 1. Hit the cache for any we already know
  const uncached: string[] = [];
  if (db) {
    const cached = await readCacheBatch(db, unique);
    for (const cusip of unique) {
      const hit = cached.get(cusip);
      if (hit) {
        result.set(cusip, { ticker: hit.ticker, name: hit.name });
      } else {
        uncached.push(cusip);
      }
    }
  } else {
    uncached.push(...unique);
  }

  if (uncached.length === 0) return result;

  console.error(
    `[openfigi] ${unique.length - uncached.length} hit cache, ${uncached.length} need lookup`,
  );

  // 2. Batch the rest into OpenFIGI requests
  for (let i = 0; i < uncached.length; i += JOBS_PER_REQUEST) {
    const batch = uncached.slice(i, i + JOBS_PER_REQUEST);
    try {
      const mappings = await openFigiBatch(batch);
      for (const mapping of mappings) {
        result.set(mapping.cusip, {
          ticker: mapping.ticker,
          name: mapping.name,
        });
        // Write through to cache (fire and forget — OK if it fails)
        if (db) {
          db.collection("cusip_map")
            .doc(mapping.cusip)
            .set(mapping, { merge: true })
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`[openfigi] cache write failed: ${msg}`);
            });
        }
      }
      // Any CUSIP in batch that didn't get a mapping → record empty so we
      // don't keep retrying it on subsequent runs
      for (const cusip of batch) {
        if (!result.has(cusip)) {
          result.set(cusip, { ticker: "", name: null });
          if (db) {
            db.collection("cusip_map")
              .doc(cusip)
              .set(
                {
                  cusip,
                  ticker: "",
                  name: null,
                  market_sector: null,
                  last_verified: new Date().toISOString(),
                },
                { merge: true },
              )
              .catch(() => undefined);
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[openfigi] batch failed: ${msg}`);
      for (const cusip of batch) result.set(cusip, { ticker: "", name: null });
    }
    // Pace requests to stay under the rate limit
    if (i + JOBS_PER_REQUEST < uncached.length) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  return result;
}

// Pace search calls — OpenFIGI's /v3/search endpoint is rate-limited at
// 5 req/min on free tier, 25 req/min with API key. Mapping is more permissive
// (25/100). We track last-call timestamp and sleep to enforce the floor.
const SEARCH_REQUESTS_PER_MINUTE = API_KEY ? 25 : 5;
const SEARCH_DELAY_MS = Math.ceil(60_000 / SEARCH_REQUESTS_PER_MINUTE);
let lastSearchCallAt = 0;

/**
 * Fallback path: search OpenFIGI by issuer name when CUSIP mapping and the
 * EDGAR name lookup both fail. Used for names like Hologic, CyberArk,
 * Confluent that aren't in SEC's `company_tickers_exchange.json` catalog
 * even though they're real US-listed equities.
 *
 * Uses OpenFIGI's `/v3/search` endpoint which searches Bloomberg's full
 * security database. Rate-limited harder than mapping (5 req/min on free
 * tier vs 25 req/min for mapping) so this is reserved as a last resort.
 *
 * Returns the best-matching US-listed common stock ticker, or null if no
 * acceptable match. Filters and tiebreakers are the same as `pickBestMatch`
 * for consistency.
 */
export async function searchOpenFigiByName(
  name: string,
): Promise<{ ticker: string; name: string | null } | null> {
  if (!name) return null;

  // Enforce rate limit: sleep until enough time has passed since last call
  const elapsed = Date.now() - lastSearchCallAt;
  if (elapsed < SEARCH_DELAY_MS) {
    await sleep(SEARCH_DELAY_MS - elapsed);
  }
  lastSearchCallAt = Date.now();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (API_KEY) headers["X-OPENFIGI-APIKEY"] = API_KEY;

  // Restrict to equity securities — avoids noise from bond/derivative matches
  // for the same issuer name.
  const body = {
    query: name,
    marketSecDes: "Equity",
  };

  let response: Response;
  try {
    response = await fetch("https://api.openfigi.com/v3/search", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[openfigi search] network error for "${name}": ${msg}`);
    return null;
  }

  if (!response.ok) {
    // 429 (rate-limited) is the most common failure here. Don't crash the
    // scrape — just return null and the holding stays empty for this run.
    if (response.status === 429) {
      console.error(
        `[openfigi search] rate-limited for "${name}" — try setting OPENFIGI_API_KEY`,
      );
    } else {
      console.error(
        `[openfigi search] ${response.status} ${response.statusText} for "${name}"`,
      );
    }
    return null;
  }

  const result = (await response.json()) as {
    data?: OpenFigiResultItem[];
    next?: string;
  };
  if (!result.data || result.data.length === 0) return null;

  const best = await pickBestMatch(result.data);
  if (!best?.ticker) return null;

  return {
    ticker: best.ticker,
    name: best.name ?? null,
  };
}

async function openFigiBatch(cusips: string[]): Promise<CusipMapping[]> {
  const jobs: OpenFigiJob[] = cusips.map((cusip) => ({
    idType: "ID_CUSIP",
    idValue: cusip,
  }));

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (API_KEY) headers["X-OPENFIGI-APIKEY"] = API_KEY;

  const response = await fetch(OPENFIGI_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(jobs),
  });

  if (!response.ok) {
    throw new Error(`OpenFIGI ${response.status} ${response.statusText}`);
  }

  const results = (await response.json()) as OpenFigiResult[];
  if (!Array.isArray(results) || results.length !== cusips.length) {
    throw new Error("OpenFIGI returned malformed response");
  }

  const mappings: CusipMapping[] = [];
  for (let i = 0; i < cusips.length; i++) {
    const cusip = cusips[i]!;
    const r = results[i]!;
    if (r.error || !r.data || r.data.length === 0) continue;
    const best = await pickBestMatch(r.data);
    if (!best?.ticker) continue;
    mappings.push({
      cusip,
      ticker: best.ticker,
      name: best.name ?? null,
      market_sector: best.marketSector ?? null,
      last_verified: new Date().toISOString(),
    });
  }
  return mappings;
}

/**
 * When a CUSIP maps to multiple securities (e.g., a US common stock + the
 * same security cross-listed on a foreign exchange + preferred + ADR), pick
 * the one most likely to be what an investor means by "the ticker."
 *
 * Heuristic, in priority order:
 *   1. US-exchange listing (exchCode is one of US, UN, UQ, UR, UW, UA, UV,
 *      UF, UP, UD, UB) — without this, big-cap US stocks were resolving to
 *      their Frankfurt/XETRA tickers (CVX → CHV, GOOGL → ABEA, MCO → DUT).
 *   2. Reject obviously-bad tickers (USD-suffix foreign cross-listings like
 *      NCSUSD/SGENUSD/GTT1USD, single-letter tickers not in allowlist).
 *   3. Common stock (securityType contains "Common")
 *   4. Validate against EDGAR's company_tickers.json catalog. A US-exchange
 *      listing that isn't in EDGAR's authoritative US-ticker set is almost
 *      always a Bloomberg internal code or stale listing (e.g., "P" for
 *      Pure Storage's CUSIP — that's Pandora's old NYSE ticker, delisted
 *      2019). Prefer EDGAR-validated tickers.
 *   5. Shortest ticker — usually the primary listing wins
 *   6. First result if all else equal
 *
 * Returns undefined if no acceptable candidate exists; the caller then falls
 * back to the EDGAR name-based lookup in sec-tickers.ts.
 */
async function pickBestMatch(
  items: OpenFigiResultItem[],
): Promise<OpenFigiResultItem | undefined> {
  if (items.length === 0) return undefined;

  // OpenFIGI exchange codes for US listings — broad set covering NYSE,
  // NASDAQ tiers, NYSE American, NYSE Arca, BATS, IEX, OTC, etc.
  const US_EXCHANGES = new Set([
    "US",
    "UN",
    "UQ",
    "UR",
    "UW",
    "UA",
    "UV",
    "UF",
    "UP",
    "UD",
    "UB",
  ]);

  const usListings = items.filter((i) =>
    US_EXCHANGES.has((i.exchCode ?? "").toUpperCase()),
  );

  // If OpenFIGI doesn't return any US listing for this CUSIP, return
  // undefined and let the EDGAR name fallback (sec-tickers.ts) handle it.
  if (usListings.length === 0) return undefined;

  // Reject obviously-bad tickers up front — USD suffix or non-allowlisted
  // single character. Catches NCSUSD, SGENUSD, GTT1USD, "P" (Pandora not
  // Pure Storage), "L" / "E" / "B" etc. Bloomberg-internal codes.
  let pool = usListings.filter(
    (i) => !isObviouslyBadTicker(i.ticker ?? ""),
  );
  if (pool.length === 0) return undefined;

  const common = pool.filter((i) =>
    (i.securityType ?? "").toLowerCase().includes("common"),
  );
  if (common.length > 0) pool = common;

  // EDGAR-validation pass: prefer tickers that appear in EDGAR's
  // company_tickers.json. The catalog only includes currently-active US
  // tickers, so this filters out Bloomberg-internal codes and stale picks.
  const edgarValidated: OpenFigiResultItem[] = [];
  for (const item of pool) {
    if (await isKnownUSTicker(item.ticker ?? "")) {
      edgarValidated.push(item);
    }
  }
  if (edgarValidated.length > 0) pool = edgarValidated;

  return [...pool].sort((a, b) => {
    const at = a.ticker ?? "";
    const bt = b.ticker ?? "";
    return at.length - bt.length;
  })[0];
}

async function readCacheBatch(
  db: FirestoreInstance,
  cusips: string[],
): Promise<Map<string, CusipMapping>> {
  const result = new Map<string, CusipMapping>();
  // Firestore getAll takes individual DocumentReference objects; chunk to
  // stay under any practical cap (no hard cap, but huge batches are slow)
  const collection = db.collection("cusip_map");
  const CHUNK = 100;
  for (let i = 0; i < cusips.length; i += CHUNK) {
    const refs = cusips
      .slice(i, i + CHUNK)
      .map((cusip) => collection.doc(cusip));
    const snaps = await db.getAll(...refs);
    for (const snap of snaps) {
      if (snap.exists) {
        const data = snap.data() as CusipMapping;
        if (data?.cusip) result.set(data.cusip, data);
      }
    }
  }
  return result;
}
