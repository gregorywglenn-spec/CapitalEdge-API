/**
 * Lobbying Disclosure Act (LDA) scraper — quarterly LD-2 reports and
 * related filings from the Senate Office of Public Records (SOPR).
 *
 * Public REST API at lda.gov/api/v1/filings/. No API key required for
 * read-only access. Standard Django REST Framework pagination
 * (count / next / previous / results). ~27,000 filings per quarter.
 *
 * Both lda.gov and lda.senate.gov proxy the same backend; we point at
 * lda.gov since lda.senate.gov retires June 30, 2026.
 *
 * Three modes:
 *   1. By registrant: scrape every filing where registrant.name matches.
 *   2. By client: every filing where client.name matches.
 *   3. By period: every filing for a given (year, quarter) — the live-feed
 *      / bulk path. Default page_size=25 with cursor-paginated follow-up.
 *
 * Each filing's `lobbying_activities` array is preserved nested, plus
 * three flattened summary arrays (`general_issue_codes`,
 * `government_entities`, `lobbyist_names`) at the top level for indexed
 * Firestore queries via `array-contains-any`. Activity descriptions are
 * truncated at 5000 chars to stay under Firestore's 1MB doc cap (some
 * real filings include 30KB+ free-text manifestos).
 */

import type { LobbyingActivity, LobbyingFiling } from "../types.js";

// ─── Config ─────────────────────────────────────────────────────────────────

const CONFIG = {
  USER_AGENT:
    process.env.SEC_USER_AGENT ?? "CapitalEdgeMCP/0.1 contact@capitaledge.app",
  BASE_URL: "https://lda.gov/api/v1",
  /**
   * 500ms between requests = 2 req/sec sustained. LDA's anonymous tier
   * cuts off around 4 req/sec; staying at 2 leaves headroom and avoids
   * triggering the 429 limiter on long bulk pulls. Earlier 250ms hit
   * the limit at page 16 of a Pfizer pull.
   */
  RATE_LIMIT_MS: 500,
  MAX_DESCRIPTION_CHARS: 5000,
  /** Max pages to follow on a paged query. 200 pages × 25 = 5000 records ceiling. */
  MAX_PAGES: 200,
  /** Retries on 429 (and 5xx) with exponential backoff: 2s, 4s, 8s. */
  RETRY_DELAYS_MS: [2000, 4000, 8000],
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET with rate-limit-aware retry. Honors Retry-After header on 429s
 * when present; otherwise uses exponential backoff. Retries also cover
 * transient 5xx. Re-throws after exhausting RETRY_DELAYS_MS.
 */
async function fetchJson(url: string): Promise<unknown> {
  await sleep(CONFIG.RATE_LIMIT_MS);

  for (let attempt = 0; attempt <= CONFIG.RETRY_DELAYS_MS.length; attempt++) {
    const res = await fetch(url, {
      headers: {
        "User-Agent": CONFIG.USER_AGENT,
        Accept: "application/json",
      },
    });
    if (res.ok) return res.json();

    const isRetryable = res.status === 429 || res.status >= 500;
    const lastAttempt = attempt === CONFIG.RETRY_DELAYS_MS.length;
    if (!isRetryable || lastAttempt) {
      throw new Error(`LDA ${res.status} ${res.statusText} — ${url}`);
    }

    const retryAfterHeader = res.headers.get("retry-after");
    const baseDelay = CONFIG.RETRY_DELAYS_MS[attempt] ?? 8000;
    const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 0;
    const wait = Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? retryAfterSec * 1000
      : baseDelay;
    console.error(
      `[lobbying] ${res.status} on attempt ${attempt + 1}; sleeping ${wait}ms before retry`,
    );
    await sleep(wait);
  }
  throw new Error(`LDA: retry loop exited unexpectedly — ${url}`);
}

/** Decimal strings → numbers, or null when missing/empty. */
function parseDecimal(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function truncate(s: string, max: number): { value: string; truncated: boolean } {
  if (typeof s !== "string") return { value: "", truncated: false };
  if (s.length <= max) return { value: s, truncated: false };
  return { value: s.slice(0, max), truncated: true };
}

function uniq(arr: string[]): string[] {
  return [...new Set(arr.filter((s) => s && s.length > 0))];
}

// ─── API response types (loose; we'll narrow during normalization) ─────────

interface ApiLobbyist {
  lobbyist?: {
    first_name?: string;
    middle_name?: string | null;
    last_name?: string;
    nickname?: string | null;
  };
  covered_position?: string | null;
}

interface ApiGovEntity {
  name?: string;
}

interface ApiActivity {
  general_issue_code?: string;
  general_issue_code_display?: string;
  description?: string;
  foreign_entity_issues?: string;
  lobbyists?: ApiLobbyist[];
  government_entities?: ApiGovEntity[];
}

interface ApiRegistrant {
  id?: number;
  name?: string;
  state?: string;
  country?: string;
}

interface ApiClient {
  id?: number;
  client_id?: number;
  name?: string;
  general_description?: string | null;
  state?: string;
  country?: string;
  client_government_entity?: boolean | null;
  client_self_select?: boolean | null;
}

interface ApiFiling {
  filing_uuid?: string;
  filing_type?: string;
  filing_type_display?: string;
  filing_year?: number;
  filing_period?: string;
  filing_period_display?: string;
  filing_document_url?: string;
  income?: string | number | null;
  expenses?: string | number | null;
  dt_posted?: string;
  termination_date?: string | null;
  registrant?: ApiRegistrant;
  client?: ApiClient;
  lobbying_activities?: ApiActivity[];
}

interface ApiPage {
  count?: number;
  next?: string | null;
  previous?: string | null;
  results?: ApiFiling[];
}

// ─── Normalization ──────────────────────────────────────────────────────────

function fullLobbyistName(l: ApiLobbyist): string {
  const lo = l.lobbyist ?? {};
  const first = (lo.first_name ?? "").trim();
  const middle = (lo.middle_name ?? "").trim();
  const last = (lo.last_name ?? "").trim();
  return [first, middle, last].filter((s) => s).join(" ");
}

function normalizeActivity(a: ApiActivity): LobbyingActivity {
  const desc = truncate(a.description ?? "", CONFIG.MAX_DESCRIPTION_CHARS);
  const lobbyistNames = uniq(
    (a.lobbyists ?? []).map(fullLobbyistName).filter((s) => s),
  );
  const govEntities = uniq(
    (a.government_entities ?? []).map((g) => g.name ?? "").filter((s) => s),
  );
  return {
    general_issue_code: a.general_issue_code ?? "",
    general_issue_code_display: a.general_issue_code_display ?? "",
    description: desc.value,
    description_truncated: desc.truncated,
    foreign_entity_issues: a.foreign_entity_issues ?? "",
    lobbyist_names: lobbyistNames,
    government_entities: govEntities,
  };
}

function normalizeFiling(f: ApiFiling): LobbyingFiling | null {
  if (!f.filing_uuid) return null;
  const activities = (f.lobbying_activities ?? []).map(normalizeActivity);
  const issueCodes = uniq(activities.map((a) => a.general_issue_code));
  const govEntities = uniq(activities.flatMap((a) => a.government_entities));
  const lobbyistNames = uniq(activities.flatMap((a) => a.lobbyist_names));

  return {
    id: f.filing_uuid,
    filing_uuid: f.filing_uuid,
    filing_type: f.filing_type ?? "",
    filing_type_display: f.filing_type_display ?? "",
    filing_year: f.filing_year ?? 0,
    filing_period: f.filing_period ?? "",
    filing_period_display: f.filing_period_display ?? "",
    filing_document_url: f.filing_document_url ?? "",
    income: parseDecimal(f.income),
    expenses: parseDecimal(f.expenses),
    dt_posted: f.dt_posted ?? "",
    termination_date: f.termination_date ?? "",
    registrant_id: f.registrant?.id ?? 0,
    registrant_name: f.registrant?.name ?? "",
    registrant_state: f.registrant?.state ?? "",
    registrant_country: f.registrant?.country ?? "",
    client_id: f.client?.id ?? f.client?.client_id ?? 0,
    client_name: f.client?.name ?? "",
    client_description: f.client?.general_description ?? "",
    client_state: f.client?.state ?? "",
    client_country: f.client?.country ?? "",
    client_is_government: Boolean(f.client?.client_government_entity),
    general_issue_codes: issueCodes,
    government_entities: govEntities,
    lobbyist_names: lobbyistNames,
    lobbying_activities: activities,
    data_source: "SENATE_LDA",
  };
}

// ─── Page-walker ────────────────────────────────────────────────────────────

/**
 * Walk paginated LDA endpoint results, yielding normalized LobbyingFiling[]
 * up to a max-records limit. Stops at MAX_PAGES regardless of API result
 * size to protect against runaway queries.
 */
async function paginate(
  startUrl: string,
  maxRecords: number,
): Promise<LobbyingFiling[]> {
  const out: LobbyingFiling[] = [];
  let url: string | null = startUrl;
  let pageNum = 0;
  while (url && out.length < maxRecords && pageNum < CONFIG.MAX_PAGES) {
    pageNum++;
    const data = (await fetchJson(url)) as ApiPage;
    const results = data.results ?? [];
    for (const raw of results) {
      const norm = normalizeFiling(raw);
      if (norm) out.push(norm);
      if (out.length >= maxRecords) break;
    }
    console.error(
      `[lobbying]   page ${pageNum}: ${results.length} results (running total ${out.length}/${maxRecords})`,
    );
    url = data.next ?? null;
  }
  return out;
}

// ─── Public scrapers ────────────────────────────────────────────────────────

/**
 * Scrape filings where the registrant (lobbying firm) name matches a
 * substring. The LDA API supports `registrant_name=` for exact-or-prefix
 * matching; we pass the user's term as-is and let the API handle it.
 */
export async function scrapeLobbyingByRegistrant(
  name: string,
  maxRecords = 500,
): Promise<LobbyingFiling[]> {
  const url = `${CONFIG.BASE_URL}/filings/?registrant_name=${encodeURIComponent(name)}&page_size=25`;
  console.error(`[lobbying] By registrant: "${name}"`);
  const filings = await paginate(url, maxRecords);
  console.error(`[lobbying] TOTAL: ${filings.length} filings for registrant "${name}"`);
  return filings;
}

/**
 * Scrape filings where the client (paying entity) name matches a substring.
 */
export async function scrapeLobbyingByClient(
  name: string,
  maxRecords = 500,
): Promise<LobbyingFiling[]> {
  const url = `${CONFIG.BASE_URL}/filings/?client_name=${encodeURIComponent(name)}&page_size=25`;
  console.error(`[lobbying] By client: "${name}"`);
  const filings = await paginate(url, maxRecords);
  console.error(`[lobbying] TOTAL: ${filings.length} filings for client "${name}"`);
  return filings;
}

/**
 * Bulk feed: every filing for a given (year, period). Useful for ingesting
 * the full quarterly slate. Default cap of 1000 records; pass higher to
 * pull more.
 *
 * Period values per the LDA API enum:
 *   - "first_quarter", "second_quarter", "third_quarter", "fourth_quarter"
 *   - "mid_year", "year_end" (LD-203 contributions windows)
 */
export async function scrapeLobbyingByPeriod(
  year: number,
  period: string,
  maxRecords = 1000,
): Promise<LobbyingFiling[]> {
  const url = `${CONFIG.BASE_URL}/filings/?filing_year=${year}&filing_period=${encodeURIComponent(period)}&page_size=25`;
  console.error(`[lobbying] By period: ${year} ${period}`);
  const filings = await paginate(url, maxRecords);
  console.error(`[lobbying] TOTAL: ${filings.length} filings for ${year} ${period}`);
  return filings;
}
