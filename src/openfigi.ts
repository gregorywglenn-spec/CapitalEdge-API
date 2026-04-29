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

const OPENFIGI_URL = "https://api.openfigi.com/v3/mapping";
const API_KEY = process.env.OPENFIGI_API_KEY ?? "";
const JOBS_PER_REQUEST = API_KEY ? 100 : 5;
const REQUESTS_PER_MINUTE = API_KEY ? 50 : 25;
const REQUEST_DELAY_MS = Math.ceil(60_000 / REQUESTS_PER_MINUTE);

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
 * Look up tickers for a batch of CUSIPs. Returns a map of CUSIP → ticker.
 * Missing CUSIPs (no mapping found) are present in the map with empty string.
 *
 * Uses Firestore as a write-through cache when `db` is provided. Without a db,
 * every CUSIP hits OpenFIGI directly — fine for ad-hoc CLI runs.
 *
 * Prefers US-listed common stock when multiple matches exist (e.g., a CUSIP
 * that maps to both NYSE-listed common and a preferred share). Picks the
 * most reasonable single ticker for the position, not all variants.
 */
export async function lookupCusips(
  cusips: string[],
  db?: FirestoreInstance,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
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
        result.set(cusip, hit.ticker);
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
        result.set(mapping.cusip, mapping.ticker);
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
          result.set(cusip, "");
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
      for (const cusip of batch) result.set(cusip, "");
    }
    // Pace requests to stay under the rate limit
    if (i + JOBS_PER_REQUEST < uncached.length) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  return result;
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
    const best = pickBestMatch(r.data);
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
 *   2. Common stock (securityType contains "Common")
 *   3. Shortest ticker — usually the primary listing wins
 *   4. First result if all else equal
 */
function pickBestMatch(
  items: OpenFigiResultItem[],
): OpenFigiResultItem | undefined {
  if (items.length === 0) return undefined;
  if (items.length === 1) return items[0];

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
  let pool = usListings.length > 0 ? usListings : items;

  const common = pool.filter((i) =>
    (i.securityType ?? "").toLowerCase().includes("common"),
  );
  if (common.length > 0) pool = common;

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
