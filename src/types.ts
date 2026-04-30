/**
 * Shared types across the MCP server.
 *
 * Two layers of types:
 *   1. Data shapes — what's actually stored in Firestore (or the stub)
 *   2. Tool envelopes — what tool responses look like over the wire
 */

// ─── Tool response envelope ──────────────────────────────────────────────────

/**
 * Every list-returning tool wraps its results in this envelope so agents get
 * pagination signals and an echo of the query that was run.
 */
export interface ResultEnvelope<T> {
  results: T[];
  count: number;
  has_more: boolean;
  query: Record<string, unknown>;
}

/**
 * Every single-result tool wraps its result like this. `result` is null when no
 * record matched.
 */
export interface SingleResultEnvelope<T> {
  result: T | null;
  query: Record<string, unknown>;
}

// ─── Insider transactions (Form 4) ──────────────────────────────────────────

/**
 * One open-market insider transaction line item from a Form 4 filing.
 *
 * Field set is what the MCP server returns to customers — a subset of the raw
 * Firestore document, which may also contain dashboard-only fields like
 * signal_weight that we deliberately do not expose.
 */
export interface InsiderTransaction {
  id: string;
  ticker: string;
  company_name: string | null;
  company_cik: string;
  officer_name: string;
  officer_title: string;
  is_director: boolean | null;
  transaction_type: "buy" | "sell";
  transaction_code: string;
  security_title: string | null;
  transaction_date: string;
  disclosure_date: string;
  reporting_lag_days: number | null;
  shares: number;
  price_per_share: number;
  total_value: number;
  shares_owned_after: number | null;
  acquired_disposed: "A" | "D" | null;
  accession_number: string;
  sec_filing_url: string;
  data_source: "SEC_EDGAR_FORM4";
}

/**
 * Validated query parameters for get_insider_transactions.
 * Matches the inputSchema declared in tools/insider-transactions.ts.
 */
export interface InsiderTransactionsQuery {
  ticker?: string;
  company_cik?: string;
  officer_name?: string;
  transaction_type?: "buy" | "sell";
  min_value?: number;
  since?: string;
  until?: string;
  sort_by?: "disclosure_date" | "transaction_date" | "total_value";
  sort_order?: "desc" | "asc";
  limit?: number;
}

// ─── Planned insider sales (Form 144) ──────────────────────────────────────

/**
 * One Form 144 filing — a notice of proposed sale filed under Rule 144 of the
 * Securities Act. Insiders (officers, directors, 10%+ holders) must file
 * Form 144 BEFORE selling restricted or control stock blocks of ≥5,000 shares
 * OR ≥$50,000 aggregate value. The actual sale later lands as a Form 4.
 *
 * Form 144 is *forward-looking* — it tells you what's about to happen, not
 * what already did. The aggregate_market_value is the insider's estimate at
 * filing time; the actual sale price/value can differ. The approximate_sale_date
 * is also an estimate — the real Form 4 transaction_date may be days later.
 *
 * Field set deliberately mirrors what raw EDGAR exposes — no derived signals,
 * no convergence scores. Pure-publisher posture per TOOL_DESIGN.md.
 *
 * Almost no aggregator exposes Form 144 cleanly — Bloomberg buries it, Capitol
 * Trades doesn't carry it, Quiver doesn't either. This is a real differentiator
 * for the hub.
 */
export interface Form144Filing {
  id: string;
  ticker: string;
  company_name: string | null;
  company_cik: string;
  filer_name: string;
  filer_relationship: string;
  security_title: string | null;
  shares_to_be_sold: number;
  aggregate_market_value: number;
  approximate_sale_date: string;
  shares_outstanding: number | null;
  pct_of_outstanding: number | null;
  broker_name: string | null;
  exchange: string | null;
  acquisition_date: string | null;
  nature_of_acquisition: string | null;
  /**
   * Date a 10b5-1 trading plan was adopted, if this sale falls under one.
   * Non-null means the sale is pre-arranged (not discretionary). Significant
   * agent signal — distinguishes "this was scheduled months ago" from "this
   * is a tactical decision to sell now."
   */
  plan_adoption_date: string | null;
  is_10b5_1_plan: boolean;
  notice_date: string | null;
  filing_date: string;
  accession_number: string;
  sec_filing_url: string;
  data_source: "SEC_EDGAR_FORM144";
}

/**
 * Validated query parameters for get_planned_insider_sales.
 * Matches the inputSchema declared in tools/planned-insider-sales.ts.
 */
export interface Form144FilingsQuery {
  ticker?: string;
  company_cik?: string;
  filer_name?: string;
  min_value?: number;
  since?: string;
  until?: string;
  sort_by?: "filing_date" | "approximate_sale_date" | "aggregate_market_value";
  sort_order?: "desc" | "asc";
  limit?: number;
}

// ─── Institutional holdings (13F) ───────────────────────────────────────────

/**
 * One position held by an institutional investment manager, sourced from a
 * Form 13F-HR filing. Each record represents (fund, security, quarter).
 *
 * `position_change`, `shares_change`, and `shares_change_pct` are computed
 * during ingestion by comparing this quarter's holding to the same fund's
 * prior-quarter holding for the same CUSIP. On first ingestion (no prior
 * data in Firestore), all positions show position_change="new".
 *
 * `ticker` is enriched via OpenFIGI CUSIP→ticker lookup. Empty string when
 * no mapping is available (private securities, foreign issuers without a
 * US ticker, etc).
 */
export interface InstitutionalHolding {
  id: string;
  fund_name: string;
  fund_cik: string;
  issuer_name: string;
  cusip: string;
  ticker: string;
  share_type: string;
  investment_discretion: string | null;
  shares_held: number;
  market_value: number;
  market_value_thousands: number;
  quarter: string;
  filing_date: string;
  position_change:
    | "new"
    | "increased"
    | "decreased"
    | "closed"
    | "unchanged"
    | null;
  shares_change: number | null;
  shares_change_pct: number | null;
  accession_number: string;
  filing_url: string;
  data_source: "SEC_EDGAR_13F";
}

/**
 * Validated query parameters for get_institutional_holdings.
 * Matches the inputSchema declared in tools/institutional-holdings.ts (TBD).
 */
export interface InstitutionalHoldingsQuery {
  ticker?: string;
  cusip?: string;
  fund_name?: string;
  fund_cik?: string;
  quarter?: string;
  position_change?:
    | "new"
    | "increased"
    | "decreased"
    | "closed"
    | "unchanged";
  min_value?: number;
  sort_by?: "market_value" | "shares_held" | "shares_change_pct";
  sort_order?: "desc" | "asc";
  limit?: number;
}

// ─── Congressional trades (STOCK Act PTRs) ──────────────────────────────────

/**
 * One disclosed congressional trade — a single line item from a Periodic
 * Transaction Report filed under the STOCK Act. Each record is one
 * (member, asset, transaction date) tuple.
 *
 * Senate PTRs come from the Senate eFD portal as HTML tables. House PTRs
 * come from the House Clerk as PDFs (parser TBD). Both normalize to this
 * shape so the MCP tool surface is uniform.
 *
 * STOCK Act mandates filing within 30 days of trade awareness or 45 days
 * of the transaction itself, whichever is earlier. `reporting_lag_days`
 * is computed against business days for clarity.
 *
 * `bioguide_id` is the permanent member identifier (e.g., "C001098" for
 * Susan Collins). Populated from the unitedstates/congress-legislators
 * catalog when that ingestion lands; empty for now.
 */
export interface CongressionalTrade {
  id: string;
  ticker: string;
  asset_name: string;
  asset_type: string;
  member_name: string;
  member_first: string;
  member_last: string;
  bioguide_id: string;
  chamber: "senate" | "house";
  party: string;
  state: string;
  state_district: string;
  office: string;
  transaction_type: "buy" | "sell";
  transaction_date: string;
  disclosure_date: string;
  reporting_lag_days: number | null;
  amount_range: string;
  amount_min: number;
  amount_max: number;
  owner: string;
  comment: string;
  ptr_id: string;
  report_url: string;
  data_source: "SENATE_EFD_PTR" | "HOUSE_CLERK_PTR";
}

/**
 * Validated query parameters for get_congressional_trades.
 * Matches the inputSchema declared in tools/congressional-trades.ts (TBD).
 */
export interface CongressionalTradesQuery {
  ticker?: string;
  member_name?: string;
  bioguide_id?: string;
  chamber?: "senate" | "house";
  transaction_type?: "buy" | "sell";
  owner?: "Self" | "Spouse" | "Joint" | "Dependent";
  since?: string;
  until?: string;
  min_amount?: number;
  sort_by?: "disclosure_date" | "transaction_date";
  sort_order?: "desc" | "asc";
  limit?: number;
}
