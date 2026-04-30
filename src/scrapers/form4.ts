/**
 * Form 4 scraper — open-market insider transactions from SEC EDGAR.
 *
 * Ported from C:\CapitalEdge-API\reference\form4_scraper.js (browser version)
 * to Node + TypeScript:
 *   - DOMParser/querySelector → fast-xml-parser
 *   - Browser-only IIFE wrapper dropped → ES module exports
 *   - Direct Firestore write removed → returns InsiderTransaction[],
 *     caller decides what to do with the results (save, return, etc.)
 *   - MIN_TRADE_VALUE filter dropped → API/MCP customer should filter,
 *     not the scraper
 *   - signal_weight dropped from output → that's a derived field that
 *     belongs to the dashboard product, not the data product (MCP/API
 *     stays in pure-publisher posture per TOOL_DESIGN.md)
 *
 * Data source: SEC EDGAR (https://data.sec.gov, free, no API key).
 * Rate limit: 10 req/sec per IP. We use 150ms delays = ~6 req/sec.
 * Required header: User-Agent identifying the requester.
 */

import { XMLParser } from "fast-xml-parser";
import type { InsiderTransaction } from "../types.js";

// ─── Config ─────────────────────────────────────────────────────────────────

const CONFIG = {
  USER_AGENT:
    process.env.SEC_USER_AGENT ?? "CapitalEdgeMCP/0.1 contact@capitaledge.app",
  BASE_URL: "https://data.sec.gov",
  EDGAR_URL: "https://www.sec.gov",
  SEARCH_URL: "https://efts.sec.gov/LATEST/search-index",
  RATE_LIMIT_MS: 150,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url: string): Promise<unknown> {
  await sleep(CONFIG.RATE_LIMIT_MS);
  const res = await fetch(url, {
    headers: {
      "User-Agent": CONFIG.USER_AGENT,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`EDGAR ${res.status} ${res.statusText} — ${url}`);
  }
  return res.json();
}

async function fetchText(url: string): Promise<string> {
  await sleep(CONFIG.RATE_LIMIT_MS);
  const res = await fetch(url, {
    headers: { "User-Agent": CONFIG.USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`EDGAR ${res.status} ${res.statusText} — ${url}`);
  }
  return res.text();
}

const formatAccession = (a: string): string => a.replace(/-/g, "");

function businessDaysBetween(start: string, end: string): number | null {
  if (!start || !end) return null;
  const d1 = new Date(start);
  const d2 = new Date(end);
  if (Number.isNaN(d1.getTime()) || Number.isNaN(d2.getTime())) return null;
  let count = 0;
  const cur = new Date(Math.min(d1.getTime(), d2.getTime()));
  const stop = new Date(Math.max(d1.getTime(), d2.getTime()));
  while (cur < stop) {
    const day = cur.getDay();
    if (day !== 0 && day !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

/**
 * Form 4 XML uses <value> wrappers on fields that may carry footnote refs.
 * fast-xml-parser yields either a bare string/number or { value: ... }.
 * This walks either shape and returns a string.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function read(node: any): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (typeof node === "object" && node.value !== undefined) {
    return read(node.value);
  }
  return "";
}

// ─── Ticker → CIK lookup ────────────────────────────────────────────────────

interface TickerInfo {
  /** 10-digit zero-padded CIK */
  cik: string;
  /** un-padded CIK, used in EDGAR archive URL paths */
  cikRaw: string;
  /** Issuer name */
  name: string;
}

let tickerCache: Record<string, TickerInfo> | null = null;

export async function getTickerInfo(ticker: string): Promise<TickerInfo | null> {
  if (!tickerCache) {
    const data = (await fetchJson(
      `${CONFIG.EDGAR_URL}/files/company_tickers.json`,
    )) as Record<string, { ticker: string; cik_str: number; title: string }>;
    tickerCache = {};
    for (const entry of Object.values(data)) {
      tickerCache[entry.ticker.toUpperCase()] = {
        cik: String(entry.cik_str).padStart(10, "0"),
        cikRaw: String(entry.cik_str),
        name: entry.title,
      };
    }
  }
  return tickerCache[ticker.toUpperCase()] ?? null;
}

// ─── Filing metadata ────────────────────────────────────────────────────────

interface FilingMeta {
  accession: string;
  companyCik: string;
  filedAt: string;
  url: string;
}

// ─── XML parsing ────────────────────────────────────────────────────────────

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

/**
 * Parse a Form 4 XML document into structured trade records.
 * Only captures open-market purchases (P) and sales (S).
 * Skips grants (A), option exercises (M), tax-withholding (F), etc.
 */
export function parseForm4Xml(
  xmlText: string,
  meta: FilingMeta,
): InsiderTransaction[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parsed: any = xml.parse(xmlText);
  const doc = parsed.ownershipDocument;
  if (!doc) return [];

  // Handle the multi-owner case. 10%+ holder / fund-entity filings often have
  // multiple reportingOwner elements — the primary entity plus sub-accounts.
  // fast-xml-parser returns an array in that case; without this guard, every
  // such filing's officer_name silently became "unknown" (caught April 29 in
  // the Avis Budget Group sell-spree records).
  const reportingOwnerRaw = doc.reportingOwner;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reportingOwners: any[] = Array.isArray(reportingOwnerRaw)
    ? reportingOwnerRaw
    : reportingOwnerRaw
      ? [reportingOwnerRaw]
      : [];

  const ownerNames = reportingOwners
    .map((o) => read(o?.reportingOwnerId?.rptOwnerName))
    .filter((n) => n);
  const officerName =
    ownerNames.length > 0 ? ownerNames.join(" / ") : "unknown";

  const titles = reportingOwners
    .map((o) => read(o?.reportingOwnerRelationship?.officerTitle))
    .filter((t) => t);
  const isDirector = reportingOwners.some(
    (o) => read(o?.reportingOwnerRelationship?.isDirector) === "1",
  );
  const officerTitle =
    titles.length > 0 ? titles[0]! : isDirector ? "Director" : "";

  const issuer = doc.issuer;
  const ticker = read(issuer?.issuerTradingSymbol).toUpperCase();
  const companyName = read(issuer?.issuerName) || null;
  const cik = read(issuer?.issuerCik) || meta.companyCik;

  const txnsRaw = doc.nonDerivativeTable?.nonDerivativeTransaction;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const txArray: any[] = Array.isArray(txnsRaw)
    ? txnsRaw
    : txnsRaw
      ? [txnsRaw]
      : [];

  const trades: InsiderTransaction[] = [];

  for (const tx of txArray) {
    const code = read(tx.transactionCoding?.transactionCode);
    if (code !== "P" && code !== "S") continue;

    const shares =
      parseFloat(read(tx.transactionAmounts?.transactionShares)) || 0;
    const price =
      parseFloat(read(tx.transactionAmounts?.transactionPricePerShare)) || 0;
    const txDate = read(tx.transactionDate);
    const sharesAfterRaw = read(
      tx.postTransactionAmounts?.sharesOwnedFollowingTransaction,
    );
    const sharesAfter = sharesAfterRaw ? parseFloat(sharesAfterRaw) : null;
    const acqDispRaw = read(
      tx.transactionAmounts?.transactionAcquiredDisposedCode,
    );
    const securityTitle = read(tx.securityTitle) || null;
    const totalValue = shares * price;

    if (!txDate || shares === 0) continue;

    trades.push({
      id: `${meta.accession}-${txDate}-${code}-${Math.round(shares)}`,
      ticker,
      company_name: companyName,
      company_cik: cik,
      officer_name: officerName,
      officer_title: officerTitle,
      is_director: isDirector,
      transaction_type: code === "P" ? "buy" : "sell",
      transaction_code: code,
      security_title: securityTitle,
      transaction_date: txDate,
      disclosure_date: meta.filedAt,
      reporting_lag_days: businessDaysBetween(txDate, meta.filedAt),
      shares,
      price_per_share: price,
      total_value: totalValue,
      shares_owned_after: sharesAfter,
      acquired_disposed:
        acqDispRaw === "A" || acqDispRaw === "D" ? acqDispRaw : null,
      accession_number: meta.accession,
      sec_filing_url: meta.url,
      data_source: "SEC_EDGAR_FORM4",
    });
  }

  return trades;
}

// ─── Fetcher ────────────────────────────────────────────────────────────────

interface SubmissionsResponse {
  filings?: {
    recent?: {
      form: string[];
      accessionNumber: string[];
      filingDate: string[];
      primaryDocument?: string[];
    };
  };
}

/**
 * Fetch all open-market P/S Form 4 trades for a ticker. Pulls up to
 * `maxFilings` most-recent filings from EDGAR and parses each one.
 */
export async function scrapeForm4ByTicker(
  ticker: string,
  maxFilings = 20,
): Promise<InsiderTransaction[]> {
  const info = await getTickerInfo(ticker);
  if (!info) {
    throw new Error(`No CIK found for ticker: ${ticker}`);
  }
  console.error(`[form4] ${ticker} = ${info.name} (CIK ${info.cik})`);

  const subs = (await fetchJson(
    `${CONFIG.BASE_URL}/submissions/CIK${info.cik}.json`,
  )) as SubmissionsResponse;
  const recent = subs.filings?.recent;
  if (!recent) return [];

  const filings: FilingMeta[] = [];
  for (let i = 0; i < recent.form.length && filings.length < maxFilings; i++) {
    const form = recent.form[i];
    if (form !== "4" && form !== "4/A") continue;
    const accession = recent.accessionNumber[i];
    const filedAt = recent.filingDate[i];
    if (!accession || !filedAt) continue;
    const accessionNoSlash = formatAccession(accession);
    const primaryDoc = recent.primaryDocument?.[i] ?? "";
    filings.push({
      accession,
      companyCik: info.cikRaw,
      filedAt,
      url: `${CONFIG.EDGAR_URL}/Archives/edgar/data/${info.cikRaw}/${accessionNoSlash}/${primaryDoc}`,
    });
  }

  console.error(`[form4] Found ${filings.length} Form 4 filings`);

  const allTrades: InsiderTransaction[] = [];
  for (const filing of filings) {
    try {
      const xmlText = await fetchText(filing.url);
      const trades = parseForm4Xml(xmlText, filing);
      allTrades.push(...trades);
      console.error(`[form4]   ${filing.accession}: ${trades.length} trades`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[form4]   ${filing.accession}: SKIP — ${msg}`);
    }
  }

  console.error(
    `[form4] TOTAL: ${allTrades.length} open-market P/S trades for ${ticker}`,
  );
  return allTrades;
}

interface EdgarSearchHit {
  _id?: string;
  _source?: {
    ciks?: string[];
    adsh?: string;
    file_date?: string;
    display_names?: string[];
  };
}

/**
 * Live-feed mode: scan EDGAR full-text search for recent Form 4 filings
 * across all companies. Useful for "what just got filed today" queries.
 */
export async function scrapeForm4LiveFeed(
  lookbackDays = 2,
  maxFilings = 100,
): Promise<InsiderTransaction[]> {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - lookbackDays);
  const startStr = start.toISOString().split("T")[0];
  const endStr = end.toISOString().split("T")[0];

  const url = `${CONFIG.SEARCH_URL}?q=%22%22&forms=4&dateRange=custom&startdt=${startStr}&enddt=${endStr}`;
  const data = (await fetchJson(url)) as { hits?: { hits?: EdgarSearchHit[] } };
  const hits = data.hits?.hits ?? [];

  console.error(`[form4 live] ${hits.length} Form 4 filings in last ${lookbackDays}d`);

  const filings: FilingMeta[] = [];
  for (const hit of hits.slice(0, maxFilings)) {
    const src = hit._source;
    if (!src) continue;
    const companyCik = (src.ciks?.[1] ?? src.ciks?.[0] ?? "").replace(
      /^0+/,
      "",
    );
    const accession = src.adsh ?? "";
    const filedAt = src.file_date ?? "";
    const filename = (hit._id ?? "").split(":")[1] ?? "";
    if (!accession || !companyCik || !filename) continue;
    filings.push({
      accession,
      companyCik,
      filedAt,
      url: `${CONFIG.EDGAR_URL}/Archives/edgar/data/${companyCik}/${formatAccession(accession)}/${filename}`,
    });
  }

  const allTrades: InsiderTransaction[] = [];
  for (const filing of filings) {
    try {
      const xmlText = await fetchText(filing.url);
      const trades = parseForm4Xml(xmlText, filing);
      allTrades.push(...trades);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[form4 live]   ${filing.accession}: SKIP — ${msg}`);
    }
  }

  console.error(`[form4 live] TOTAL: ${allTrades.length} P/S trades`);
  return allTrades;
}
