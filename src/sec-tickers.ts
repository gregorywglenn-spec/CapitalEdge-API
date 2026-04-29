/**
 * EDGAR ticker lookup by issuer name — fallback for OpenFIGI gaps.
 *
 * Why this exists: OpenFIGI's CUSIP-to-ticker lookup is excellent for most
 * US-domiciled securities, but for foreign-domiciled US-listed companies
 * (Chubb, AON, Allegion, Liberty Latin America — CUSIPs starting with G or
 * H per the CINS scheme), it sometimes returns only the foreign primary
 * listing or no result at all. We need a fallback for those.
 *
 * EDGAR's `company_tickers.json` is an authoritative SEC-published mapping
 * of every US-listed company (by CIK) to its primary ticker and registered
 * name. About 10K entries, ~1MB JSON. We use it as a name → ticker reverse
 * lookup for whatever OpenFIGI couldn't resolve.
 *
 * The mapping is cached in-memory for the life of the process. The file is
 * stable enough that one fetch per process is fine. (For longer-running
 * deployments, refresh once a week or on schedule.)
 */

const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const USER_AGENT =
  process.env.SEC_USER_AGENT ?? "CapitalEdgeMCP/0.1 contact@capitaledge.app";

interface SecTickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

interface NormalizedEntry {
  ticker: string;
  title: string;
  cik: number;
  /** Length of ticker — used to prefer primary listings on ambiguous names */
  tickerLen: number;
}

/** Map from normalized name → list of matching tickers (multiple share classes possible) */
let nameMap: Map<string, NormalizedEntry[]> | null = null;

/**
 * Normalize an issuer name for matching. Aggressive — strips suffixes,
 * punctuation, whitespace variations. Tuned to match what 13F filings
 * write ("CHUBB LIMITED") against what EDGAR registers ("Chubb Limited").
 */
export function normalizeName(name: string): string {
  return (
    name
      .toUpperCase()
      // Strip common corporate-form suffixes
      .replace(
        /\b(INC(ORPORATED)?|CORP(ORATION)?|CO(MPANY)?|LTD|LIMITED|PLC|LLC|N\.?V\.?|S\.?A\.?|LP|HOLDINGS|HLDGS|GROUP|GRP)\b/g,
        " ",
      )
      // Strip directional / state suffixes ("/DE", "(NEW)", "/PA/")
      .replace(/\(?\b(NEW|OLD|DE|PA|MD|NY|CA|MA)\b\)?/g, " ")
      .replace(/\/[A-Z]{2,3}\/?/g, " ")
      // Strip punctuation
      .replace(/[.,'"()\\\/&-]/g, " ")
      // Collapse whitespace
      .replace(/\s+/g, " ")
      .trim()
  );
}

async function loadMap(): Promise<Map<string, NormalizedEntry[]>> {
  if (nameMap) return nameMap;

  console.error("[sec-tickers] Loading EDGAR company_tickers.json...");
  const res = await fetch(SEC_TICKERS_URL, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`SEC tickers fetch failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as Record<string, SecTickerEntry>;

  const built = new Map<string, NormalizedEntry[]>();
  for (const entry of Object.values(data)) {
    const norm = normalizeName(entry.title);
    if (!norm) continue;
    const existing = built.get(norm) ?? [];
    existing.push({
      ticker: entry.ticker,
      title: entry.title,
      cik: entry.cik_str,
      tickerLen: entry.ticker.length,
    });
    built.set(norm, existing);
  }
  console.error(
    `[sec-tickers] Loaded ${Object.keys(data).length} tickers, ${built.size} unique normalized names`,
  );
  nameMap = built;
  return built;
}

/**
 * Look up a US ticker for an issuer name. Returns empty string if no match
 * found. When multiple tickers match the same normalized name (different
 * share classes), returns the one with the shortest ticker — usually the
 * primary / most-traded class.
 *
 * For Liberty Latin America (which has LILA and LILAK both registered with
 * the same name), this picks LILA. Customers who care about share class
 * specifically can join on the cusip field instead of ticker.
 */
export async function lookupTickerByName(
  issuerName: string,
): Promise<string> {
  if (!issuerName) return "";
  const map = await loadMap();
  const normalized = normalizeName(issuerName);
  if (!normalized) return "";

  const matches = map.get(normalized);
  if (matches && matches.length > 0) {
    return [...matches].sort((a, b) => a.tickerLen - b.tickerLen)[0]!.ticker;
  }

  return "";
}
