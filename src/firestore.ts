/**
 * Firestore client wrapper with two modes:
 *
 *   1. STUB MODE — secrets/service-account.json doesn't exist. Tool handlers
 *      return realistic mock data so the server is testable end-to-end without
 *      live credentials.
 *
 *   2. LIVE MODE — secrets/service-account.json exists. Real Firestore queries
 *      go to the MCP project's own Firestore database (sibling project, dual-
 *      scrape architecture — see DATA_REQUIREMENTS_FOR_DASHBOARD.md and the
 *      handoff doc for why we don't share a database with Capital Edge).
 *
 * Mode is auto-detected at module load. Drop a service-account.json into
 * secrets/ and restart to switch modes.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CongressionalTrade,
  CongressionalTradesQuery,
  Form144Filing,
  Form144FilingsQuery,
  Form3Holding,
  Form3HoldingsQuery,
  InsiderTransaction,
  InsiderTransactionsQuery,
  InstitutionalHolding,
  InstitutionalHoldingsQuery,
} from "./types.js";

// Resolve service-account.json relative to the project root, not cwd. This
// matters when the server is launched by an MCP client (Claude Desktop, etc.)
// whose working directory is not necessarily our project folder.
//
// In dev (tsx running src/firestore.ts), this module lives at <root>/src.
// In prod (node running dist/firestore.js), it lives at <root>/dist.
// Either way, project root is one level up.
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(MODULE_DIR, "..");
const SERVICE_ACCOUNT_PATH = resolve(
  PROJECT_ROOT,
  "secrets/service-account.json",
);

// ─── Mode detection ─────────────────────────────────────────────────────────

export function isStubMode(): boolean {
  return !existsSync(SERVICE_ACCOUNT_PATH);
}

// ─── Live-mode client (lazy init) ───────────────────────────────────────────

// Type-only imports — keep firebase-admin out of cold-start unless we
// actually use it. Important when running in stub mode (no SDK touched).
type FirestoreInstance = import("firebase-admin/firestore").Firestore;
type FirestoreQuery = import("firebase-admin/firestore").Query;

let liveDb: FirestoreInstance | null = null;

/**
 * Get the live Firestore instance, initializing the SDK on first call.
 * Throws if called in stub mode (no service account).
 *
 * Exported so other modules (scrapers, etc.) can pass the db handle into
 * helpers that take an optional Firestore. Use `getDbIfLive()` if you want
 * a null-or-db result without throwing.
 */
export async function getLiveDb(): Promise<FirestoreInstance> {
  if (liveDb) return liveDb;

  const { cert, initializeApp, getApps } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");

  const serviceAccount = JSON.parse(
    readFileSync(SERVICE_ACCOUNT_PATH, "utf8"),
  );

  // initializeApp is idempotent if an app already exists with this name
  const app =
    getApps().find((a) => a.name === "[DEFAULT]") ??
    initializeApp({ credential: cert(serviceAccount) });

  liveDb = getFirestore(app);
  return liveDb;
}

/**
 * Returns the live Firestore instance, or null in stub mode.
 * Convenient for code paths that work with-or-without live data.
 */
export async function getDbIfLive(): Promise<FirestoreInstance | null> {
  if (isStubMode()) return null;
  return getLiveDb();
}

// ─── Public query API ───────────────────────────────────────────────────────

export interface QueryResult<T> {
  results: T[];
  has_more: boolean;
}

export async function queryInsiderTransactions(
  query: InsiderTransactionsQuery,
): Promise<QueryResult<InsiderTransaction>> {
  if (isStubMode()) {
    return queryInsiderTransactionsStub(query);
  }
  return queryInsiderTransactionsLive(query);
}

// ─── Live mode implementation ───────────────────────────────────────────────

async function queryInsiderTransactionsLive(
  query: InsiderTransactionsQuery,
): Promise<QueryResult<InsiderTransaction>> {
  const db = await getLiveDb();
  let q: FirestoreQuery = db.collection("insider_trades");

  if (query.ticker) q = q.where("ticker", "==", query.ticker);
  if (query.company_cik) {
    q = q.where("company_cik", "==", query.company_cik);
  }
  if (query.transaction_type) {
    q = q.where("transaction_type", "==", query.transaction_type);
  }
  if (query.min_value !== undefined) {
    q = q.where("total_value", ">=", query.min_value);
  }

  const sortField = query.sort_by ?? "disclosure_date";
  const sortOrder = query.sort_order ?? "desc";

  // Date-range filters apply to the active sort field
  if (query.since) q = q.where(sortField, ">=", query.since);
  if (query.until) q = q.where(sortField, "<=", query.until);

  q = q.orderBy(sortField, sortOrder);

  const userLimit = query.limit ?? 50;

  // When a client-side substring filter is active (officer_name), we must
  // pull a much larger Firestore window — otherwise the global-top-N
  // truncation happens BEFORE the substring filter, and we silently miss
  // valid matches that didn't rank in the first N rows. The 5000 ceiling
  // is enough for v1's data volume (~hundreds of insider records) and
  // protects against runaway memory on later growth. See v1.1 polish item
  // for moving substring search to Firestore-side via tokenized indexes.
  const fetchLimit = query.officer_name ? 5000 : userLimit + 1;
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as InsiderTransaction);

  if (query.officer_name) {
    const needle = query.officer_name.toLowerCase();
    docs = docs.filter((t) =>
      (t.officer_name ?? "").toLowerCase().includes(needle),
    );
  }

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return { results, has_more };
}

/**
 * Save scraped insider transactions to Firestore.
 *
 * Each record uses its `id` as the document key, so re-running a scraper for
 * the same filings is idempotent — the same trades land at the same doc IDs
 * with `merge: true` semantics, no duplicates.
 *
 * Firestore caps batch size at 500 writes; we use 400 for headroom.
 *
 * Throws if called in stub mode (no service account) — the scrape CLI catches
 * this and prints a friendly message.
 */
export async function saveInsiderTransactions(
  trades: InsiderTransaction[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "insider_trades";
  if (trades.length === 0) {
    return { saved: 0, collection: COLLECTION };
  }

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < trades.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = trades.slice(i, i + BATCH_SIZE);
    for (const trade of chunk) {
      batch.set(collection.doc(trade.id), trade, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

// ─── Institutional holdings (13F) query ─────────────────────────────────────

export async function queryInstitutionalHoldings(
  query: InstitutionalHoldingsQuery,
): Promise<QueryResult<InstitutionalHolding>> {
  if (isStubMode()) {
    // No stub data for 13F yet — returns empty in stub mode. Tool descriptions
    // make it clear the data only exists once a 13f scrape has been run.
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();
  let q: FirestoreQuery = db.collection("institutional_holdings");

  if (query.ticker) q = q.where("ticker", "==", query.ticker);
  if (query.cusip) q = q.where("cusip", "==", query.cusip);
  if (query.fund_cik) q = q.where("fund_cik", "==", query.fund_cik);
  if (query.quarter) q = q.where("quarter", "==", query.quarter);
  if (query.position_change) {
    q = q.where("position_change", "==", query.position_change);
  }
  if (query.min_value !== undefined) {
    q = q.where("market_value", ">=", query.min_value);
  }

  const sortField = query.sort_by ?? "market_value";
  const sortOrder = query.sort_order ?? "desc";
  q = q.orderBy(sortField, sortOrder);

  const userLimit = query.limit ?? 50;

  // Same substring-filter consideration as queryInsiderTransactionsLive:
  // when fund_name is set, we must pull a much larger Firestore window so
  // the client-side substring filter sees the full universe. Without this,
  // a query for "Berkshire" returns only the top-N global positions that
  // happen to be Berkshire's — Berkshire's smaller positions silently miss.
  // 5000 ceiling protects memory; sufficient for v1's ~thousands of records.
  const fetchLimit = query.fund_name ? 5000 : userLimit + 1;
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as InstitutionalHolding);

  if (query.fund_name) {
    const needle = query.fund_name.toLowerCase();
    docs = docs.filter((h) =>
      (h.fund_name ?? "").toLowerCase().includes(needle),
    );
  }

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return { results, has_more };
}

/**
 * Save scraped institutional holdings to Firestore.
 *
 * Each record uses its `id` as the document key (`13f-{fundCik}-{cusip}-
 * {quarter}`), so re-running a scrape for the same filing is idempotent.
 *
 * Throws if called in stub mode (no service account).
 */
export async function saveInstitutionalHoldings(
  holdings: InstitutionalHolding[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "institutional_holdings";
  if (holdings.length === 0) {
    return { saved: 0, collection: COLLECTION };
  }

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < holdings.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = holdings.slice(i, i + BATCH_SIZE);
    for (const holding of chunk) {
      batch.set(collection.doc(holding.id), holding, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

// ─── Congressional trades query ─────────────────────────────────────────────

export async function queryCongressionalTrades(
  query: CongressionalTradesQuery,
): Promise<QueryResult<CongressionalTrade>> {
  if (isStubMode()) {
    // No stub data for congressional trades — returns empty in stub mode.
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();
  let q: FirestoreQuery = db.collection("congressional_trades");

  if (query.ticker) q = q.where("ticker", "==", query.ticker);
  if (query.bioguide_id) q = q.where("bioguide_id", "==", query.bioguide_id);
  if (query.chamber) q = q.where("chamber", "==", query.chamber);
  if (query.transaction_type) {
    q = q.where("transaction_type", "==", query.transaction_type);
  }
  if (query.owner) q = q.where("owner", "==", query.owner);
  if (query.min_amount !== undefined) {
    q = q.where("amount_min", ">=", query.min_amount);
  }

  const sortField = query.sort_by ?? "disclosure_date";
  const sortOrder = query.sort_order ?? "desc";

  if (query.since) q = q.where(sortField, ">=", query.since);
  if (query.until) q = q.where(sortField, "<=", query.until);

  q = q.orderBy(sortField, sortOrder);

  const userLimit = query.limit ?? 50;

  // Same substring-filter consideration as queryInsiderTransactionsLive: when
  // member_name (substring filter) is set, pull a much larger Firestore window
  // so the client-side filter sees the full universe.
  const fetchLimit = query.member_name ? 5000 : userLimit + 1;
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as CongressionalTrade);

  if (query.member_name) {
    const needle = query.member_name.toLowerCase();
    docs = docs.filter((t) =>
      (t.member_name ?? "").toLowerCase().includes(needle),
    );
  }

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return { results, has_more };
}

/**
 * Save scraped congressional trades to Firestore. Idempotent — re-running
 * the scraper on the same PTRs writes the same doc IDs (`senate-{ptrId}-{i}`
 * or `house-{docId}-{i}`) with merge:true semantics.
 *
 * Throws if called in stub mode (no service account).
 */
export async function saveCongressionalTrades(
  trades: CongressionalTrade[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "congressional_trades";
  if (trades.length === 0) {
    return { saved: 0, collection: COLLECTION };
  }

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < trades.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = trades.slice(i, i + BATCH_SIZE);
    for (const trade of chunk) {
      batch.set(collection.doc(trade.id), trade, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

// ─── Planned insider sales (Form 144) query ────────────────────────────────

export async function queryForm144Filings(
  query: Form144FilingsQuery,
): Promise<QueryResult<Form144Filing>> {
  if (isStubMode()) {
    // No stub data for Form 144 yet — returns empty in stub mode.
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();
  let q: FirestoreQuery = db.collection("planned_insider_sales");

  if (query.ticker) q = q.where("ticker", "==", query.ticker);
  if (query.company_cik) {
    q = q.where("company_cik", "==", query.company_cik);
  }
  if (query.min_value !== undefined) {
    q = q.where("aggregate_market_value", ">=", query.min_value);
  }

  const sortField = query.sort_by ?? "filing_date";
  const sortOrder = query.sort_order ?? "desc";

  if (query.since) q = q.where(sortField, ">=", query.since);
  if (query.until) q = q.where(sortField, "<=", query.until);

  q = q.orderBy(sortField, sortOrder);

  const userLimit = query.limit ?? 50;

  // Same substring-filter consideration as the other collections: when
  // filer_name is set, pull a much larger Firestore window so the client-side
  // filter sees the full universe.
  const fetchLimit = query.filer_name ? 5000 : userLimit + 1;
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as Form144Filing);

  if (query.filer_name) {
    const needle = query.filer_name.toLowerCase();
    docs = docs.filter((f) =>
      (f.filer_name ?? "").toLowerCase().includes(needle),
    );
  }

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return { results, has_more };
}

/**
 * Save scraped Form 144 filings to Firestore. Idempotent — re-running the
 * scraper for the same accession writes the same doc IDs (`{accession}-
 * {ticker}-{lineNumber}`) with merge:true semantics, no duplicates.
 *
 * Throws if called in stub mode (no service account).
 */
export async function saveForm144Filings(
  filings: Form144Filing[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "planned_insider_sales";
  if (filings.length === 0) {
    return { saved: 0, collection: COLLECTION };
  }

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < filings.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = filings.slice(i, i + BATCH_SIZE);
    for (const filing of chunk) {
      batch.set(collection.doc(filing.id), filing, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

// ─── Initial ownership baselines (Form 3) query ────────────────────────────

export async function queryForm3Holdings(
  query: Form3HoldingsQuery,
): Promise<QueryResult<Form3Holding>> {
  if (isStubMode()) {
    // No stub data for Form 3 yet — returns empty in stub mode.
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();
  let q: FirestoreQuery = db.collection("initial_ownership_baselines");

  if (query.ticker) q = q.where("ticker", "==", query.ticker);
  if (query.company_cik) {
    q = q.where("company_cik", "==", query.company_cik);
  }
  if (query.filer_cik) q = q.where("filer_cik", "==", query.filer_cik);
  if (query.is_derivative !== undefined) {
    q = q.where("is_derivative", "==", query.is_derivative);
  }

  const sortField = query.sort_by ?? "filing_date";
  const sortOrder = query.sort_order ?? "desc";

  if (query.since) q = q.where(sortField, ">=", query.since);
  if (query.until) q = q.where(sortField, "<=", query.until);

  q = q.orderBy(sortField, sortOrder);

  const userLimit = query.limit ?? 50;

  // Same substring-filter consideration as the other collections: when
  // filer_name is set, pull a much larger Firestore window so the client-side
  // filter sees the full universe.
  const fetchLimit = query.filer_name ? 5000 : userLimit + 1;
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as Form3Holding);

  if (query.filer_name) {
    const needle = query.filer_name.toLowerCase();
    docs = docs.filter((f) =>
      (f.filer_name ?? "").toLowerCase().includes(needle),
    );
  }

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return { results, has_more };
}

/**
 * Save scraped Form 3 holdings to Firestore. Idempotent — re-running the
 * scraper for the same accession writes the same doc IDs (`{accession}-
 * {ticker}-ND-{lineNumber}` for non-derivative or `-D-{lineNumber}` for
 * derivative) with merge:true semantics, no duplicates.
 *
 * Throws if called in stub mode (no service account).
 */
export async function saveForm3Holdings(
  holdings: Form3Holding[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "initial_ownership_baselines";
  if (holdings.length === 0) {
    return { saved: 0, collection: COLLECTION };
  }

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < holdings.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = holdings.slice(i, i + BATCH_SIZE);
    for (const holding of chunk) {
      batch.set(collection.doc(holding.id), holding, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

/**
 * Lightweight Firestore connection check — fetches the Firestore project ID
 * and runs a no-op read against a sentinel collection. Returns project info
 * on success; throws on auth/connectivity failures with a useful message.
 *
 * Used by the `tsx src/scrape.ts ping` CLI command to verify credentials are
 * working before spending time on a real scrape run.
 */
export async function pingFirestore(): Promise<{
  mode: "live" | "stub";
  projectId?: string;
  collectionsSeen?: number;
}> {
  if (isStubMode()) {
    return { mode: "stub" };
  }
  const db = await getLiveDb();
  // listCollections returns top-level collections — fast, free metadata read
  const collections = await db.listCollections();
  const projectId =
    (db as unknown as { projectId?: string; _projectId?: string }).projectId ??
    (db as unknown as { projectId?: string; _projectId?: string })._projectId;
  return {
    mode: "live",
    ...(projectId !== undefined ? { projectId } : {}),
    collectionsSeen: collections.length,
  };
}

// ─── Stub mode implementation ───────────────────────────────────────────────

function queryInsiderTransactionsStub(
  query: InsiderTransactionsQuery,
): QueryResult<InsiderTransaction> {
  const filtered = STUB_INSIDER_TRADES.filter((t) => {
    if (query.ticker && t.ticker !== query.ticker.toUpperCase()) return false;
    if (query.company_cik && t.company_cik !== query.company_cik) return false;
    if (
      query.officer_name &&
      !t.officer_name
        .toLowerCase()
        .includes(query.officer_name.toLowerCase())
    ) {
      return false;
    }
    if (
      query.transaction_type &&
      t.transaction_type !== query.transaction_type
    ) {
      return false;
    }
    if (query.min_value !== undefined && t.total_value < query.min_value) {
      return false;
    }
    const sortField = query.sort_by ?? "disclosure_date";
    const dateField =
      sortField === "total_value" ? "disclosure_date" : sortField;
    if (query.since && t[dateField] < query.since) return false;
    if (query.until && t[dateField] > query.until) return false;
    return true;
  });

  const sortField = query.sort_by ?? "disclosure_date";
  const sortOrder = query.sort_order ?? "desc";
  const sorted = [...filtered].sort((a, b) => {
    const av = a[sortField];
    const bv = b[sortField];
    if (av === bv) return 0;
    const cmp = av < bv ? -1 : 1;
    return sortOrder === "desc" ? -cmp : cmp;
  });

  const limit = query.limit ?? 50;
  return {
    results: sorted.slice(0, limit),
    has_more: sorted.length > limit,
  };
}

// ─── Stub data ──────────────────────────────────────────────────────────────

/**
 * Realistic mock Form 4 transactions. Mirrors the schema the runner actually
 * writes to Firestore (see C:\CapitalEdge\run-scraper.js scrapeForm4) plus the
 * fields requested in DATA_REQUIREMENTS_FOR_DASHBOARD.md fix #3 — so when the
 * dashboard ports the standalone scraper's richer field set, the live data
 * matches the stub shape and no client-side parsing changes.
 *
 * Mix of buys/sells and tickers so handlers can be exercised against varied
 * filter combinations without needing live data.
 */
const STUB_INSIDER_TRADES: InsiderTransaction[] = [
  {
    id: "0000320193-26-000071-2026-04-15-S-50000",
    ticker: "AAPL",
    company_name: "Apple Inc.",
    company_cik: "0000320193",
    officer_name: "Timothy D. Cook",
    officer_title: "Chief Executive Officer",
    is_director: false,
    transaction_type: "sell",
    transaction_code: "S",
    security_title: "Common Stock",
    transaction_date: "2026-04-15",
    disclosure_date: "2026-04-17",
    reporting_lag_days: 2,
    shares: 50000,
    price_per_share: 198.42,
    total_value: 9921000,
    shares_owned_after: 3340000,
    acquired_disposed: "D",
    accession_number: "0000320193-26-000071",
    sec_filing_url:
      "https://www.sec.gov/Archives/edgar/data/320193/000032019326000071/",
    data_source: "SEC_EDGAR_FORM4",
  },
  {
    id: "0000320193-26-000068-2026-04-08-S-12500",
    ticker: "AAPL",
    company_name: "Apple Inc.",
    company_cik: "0000320193",
    officer_name: "Luca Maestri",
    officer_title: "Chief Financial Officer",
    is_director: false,
    transaction_type: "sell",
    transaction_code: "S",
    security_title: "Common Stock",
    transaction_date: "2026-04-08",
    disclosure_date: "2026-04-10",
    reporting_lag_days: 2,
    shares: 12500,
    price_per_share: 196.15,
    total_value: 2451875,
    shares_owned_after: 287000,
    acquired_disposed: "D",
    accession_number: "0000320193-26-000068",
    sec_filing_url:
      "https://www.sec.gov/Archives/edgar/data/320193/000032019326000068/",
    data_source: "SEC_EDGAR_FORM4",
  },
  {
    id: "0001045810-26-000044-2026-03-22-P-25000",
    ticker: "NVDA",
    company_name: "NVIDIA Corporation",
    company_cik: "0001045810",
    officer_name: "Jen-Hsun Huang",
    officer_title: "President and Chief Executive Officer",
    is_director: true,
    transaction_type: "buy",
    transaction_code: "P",
    security_title: "Common Stock",
    transaction_date: "2026-03-22",
    disclosure_date: "2026-03-24",
    reporting_lag_days: 2,
    shares: 25000,
    price_per_share: 142.78,
    total_value: 3569500,
    shares_owned_after: 87234500,
    acquired_disposed: "A",
    accession_number: "0001045810-26-000044",
    sec_filing_url:
      "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000044/",
    data_source: "SEC_EDGAR_FORM4",
  },
  {
    id: "0000789019-26-000128-2026-04-22-S-8000",
    ticker: "MSFT",
    company_name: "Microsoft Corporation",
    company_cik: "0000789019",
    officer_name: "Satya Nadella",
    officer_title: "Chief Executive Officer",
    is_director: true,
    transaction_type: "sell",
    transaction_code: "S",
    security_title: "Common Stock",
    transaction_date: "2026-04-22",
    disclosure_date: "2026-04-24",
    reporting_lag_days: 2,
    shares: 8000,
    price_per_share: 425.6,
    total_value: 3404800,
    shares_owned_after: 794200,
    acquired_disposed: "D",
    accession_number: "0000789019-26-000128",
    sec_filing_url:
      "https://www.sec.gov/Archives/edgar/data/789019/000078901926000128/",
    data_source: "SEC_EDGAR_FORM4",
  },
  {
    id: "0001045810-26-000041-2026-02-14-P-100000",
    ticker: "NVDA",
    company_name: "NVIDIA Corporation",
    company_cik: "0001045810",
    officer_name: "Mark A. Stevens",
    officer_title: "Director",
    is_director: true,
    transaction_type: "buy",
    transaction_code: "P",
    security_title: "Common Stock",
    transaction_date: "2026-02-14",
    disclosure_date: "2026-02-18",
    reporting_lag_days: 2,
    shares: 100000,
    price_per_share: 138.05,
    total_value: 13805000,
    shares_owned_after: 412000,
    acquired_disposed: "A",
    accession_number: "0001045810-26-000041",
    sec_filing_url:
      "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000041/",
    data_source: "SEC_EDGAR_FORM4",
  },
];
