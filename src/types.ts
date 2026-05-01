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
  /**
   * When true, the response includes matching Form 3 baseline records under
   * a `baselines` field. Lets agents stitch initial-ownership context onto
   * Form 4 deltas without a second tool call. Requires ticker or company_cik
   * to be set (otherwise the baseline lookup would be unbounded).
   */
  include_baseline?: boolean;
}

/**
 * Extended response envelope for get_insider_transactions when
 * include_baseline=true. Standard ResultEnvelope shape plus an optional
 * baselines array of Form 3 rows matching the active ticker/officer filters.
 *
 * Form 3 baselines snapshot the insider's *starting* position (filed when
 * they first became an insider). Agents pair them with Form 4 deltas to
 * reconstruct full ownership history without a second tool call.
 */
export interface InsiderTransactionsEnvelope
  extends ResultEnvelope<InsiderTransaction> {
  baselines?: Form3Holding[];
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

// ─── Activist / 5%+ ownership disclosures (Schedule 13D / 13G) ─────────────

/**
 * One row from a Schedule 13D or 13G filing — beneficial-ownership disclosure
 * by anyone holding ≥5% of a registered class of equity securities. Reveals
 * activist campaigns, takeover targets, hostile bids, large institutional
 * accumulations.
 *
 * Two flavors with the same conceptual data but **structurally different
 * XML schemas** (captured as a Hard Lesson):
 *
 *   - **13D**: filer signals intent to influence control. Activist filing.
 *     namespace=schedule13D, fields under `reportingPersons.reportingPersonInfo.*`,
 *     `aggregateAmountOwned`, `percentOfClass`, `dateOfEvent`.
 *
 *   - **13G**: filer is passive (institutional, no intent to influence).
 *     namespace=schedule13g, fields under `coverPageHeaderReportingPersonDetails.*`,
 *     `reportingPersonBeneficiallyOwnedAggregateNumberOfShares`,
 *     `classPercent`, `eventDateRequiresFilingThisStatement`.
 *
 * Both populate this single output type; the parser branches on submissionType.
 *
 * `is_activist` is the structural signal — true for any SCHEDULE 13D variant,
 * false for any 13G. The full "Item 4: Purpose of Transaction" narrative is
 * NOT in the structured XML — it's on the HTML side. v1.1 polish to extract.
 *
 * One filing can have multiple reporting persons (joint filers). Each emits
 * its own ActivistOwnership row.
 */
export interface ActivistOwnership {
  id: string;
  ticker: string;
  company_name: string | null;
  company_cik: string;
  cusip: string;
  filer_name: string;
  /**
   * Filer CIK (zero-padded). Empty string when filer doesn't have a CIK
   * (rare — `<reportingPersonNoCIK>` flag in 13D schema; some individuals).
   */
  filer_cik: string;
  /**
   * Type-of-reporting-person code from the form: "IN" individual, "CO"
   * corporation, "OO" other, "PN" partnership, "BD" broker-dealer,
   * "IA" investment adviser, "EP" employee benefit plan, etc.
   */
  filer_type: string;
  /**
   * Free-text country/state of citizenship (for individuals) or place of
   * organization (for entities). Examples: "USA", "Delaware", "Cayman Islands".
   */
  citizenship_or_organization: string;
  filing_type: "SCHEDULE 13D" | "SCHEDULE 13D/A" | "SCHEDULE 13G" | "SCHEDULE 13G/A";
  /** True for any 13D variant, false for any 13G. Structural activist signal. */
  is_activist: boolean;
  /** Aggregate beneficial ownership (shares). */
  shares_owned: number;
  /** Percent of class beneficially owned. From form's percentOfClass / classPercent field. */
  percent_of_class: number;
  sole_voting_power: number;
  shared_voting_power: number;
  sole_dispositive_power: number;
  shared_dispositive_power: number;
  /** ISO date of the event triggering the filing (acquisition crossing 5%, material change, etc.). */
  event_date: string;
  filing_date: string;
  accession_number: string;
  sec_filing_url: string;
  data_source: "SEC_EDGAR_13D" | "SEC_EDGAR_13G";
}

/**
 * Validated query parameters for the (eventual) get_activist_stakes MCP tool.
 */
export interface ActivistOwnershipQuery {
  ticker?: string;
  company_cik?: string;
  cusip?: string;
  filer_name?: string;
  filer_cik?: string;
  is_activist?: boolean;
  filing_type?: "SCHEDULE 13D" | "SCHEDULE 13D/A" | "SCHEDULE 13G" | "SCHEDULE 13G/A";
  min_percent_of_class?: number;
  since?: string;
  until?: string;
  sort_by?: "filing_date" | "event_date" | "percent_of_class" | "shares_owned";
  sort_order?: "desc" | "asc";
  limit?: number;
}

// ─── Initial ownership baselines (Form 3) ──────────────────────────────────

/**
 * One row from a Form 3 filing — the *initial* statement of beneficial
 * ownership filed when someone first becomes an insider (officer, director,
 * 10%+ holder, or other qualifying person). One filing produces one record
 * per security class held: typically common stock plus any derivatives
 * (options, RSUs, warrants).
 *
 * Form 3 is the *baseline* that gives Form 4 deltas meaning. Without it,
 * "Tim Cook sold 50,000 shares" floats with no anchor — you don't know if
 * that's 1% or 50% of his position. With Form 3, the agent can stitch
 * together: "filed Form 3 in 2011 with 1.0M shares, then years of Form 4
 * grants/sales net to current holdings of 3.3M."
 *
 * Unlike Form 4 (transactions only), Form 3 records have no transaction
 * shares/price/date — only `shares_owned` (the snapshot).
 *
 * Field set deliberately mirrors what raw EDGAR exposes — pure-publisher
 * posture per TOOL_DESIGN.md. No derived intelligence.
 */
export interface Form3Holding {
  id: string;
  ticker: string;
  company_name: string | null;
  company_cik: string;
  /** Insider's full name (multiple owners joined with " / " — same as Form 4). */
  filer_name: string;
  /** Insider's CIK. Persistent across Form 3 / Form 4 filings — useful join key. */
  filer_cik: string;
  /** Officer title at issuer (empty when filer is purely a director or 10%+ holder). */
  officer_title: string;
  is_director: boolean;
  is_officer: boolean;
  is_ten_percent_owner: boolean;
  /** True when reportingOwnerRelationship.isOther is set; describes the relationship in `other_text`. */
  is_other: boolean;
  other_text: string;
  filing_date: string;
  /** "Common Stock", "Restricted Stock Unit", "Stock Option", etc. */
  security_title: string;
  /**
   * True for derivative securities (options, warrants, convertibles).
   * False for non-derivative (common stock, RSUs in some forms, preferred).
   */
  is_derivative: boolean;
  /**
   * Total shares owned of this security at the time of filing — the BASELINE.
   * For derivative rows this is the count of underlying contracts/units, not
   * the underlying share equivalent (which is in `underlying_security_shares`).
   */
  shares_owned: number;
  /** "D" (direct, in own name) or "I" (indirect, e.g., via trust/spouse). */
  direct_or_indirect: "D" | "I" | null;
  /** Free-text describing the indirect ownership ("By Trust", "By Spouse", etc.). Empty for direct. */
  nature_of_indirect_ownership: string;
  /** Strike price for an option, conversion price for a convertible. Null for non-derivative. */
  conversion_or_exercise_price: number | null;
  /** ISO date the derivative becomes exercisable. Null for non-derivative or immediate. */
  exercise_date: string | null;
  /** ISO date the derivative expires. Null for non-derivative. */
  expiration_date: string | null;
  /** For derivatives: title of the security the derivative converts into (usually "Common Stock"). */
  underlying_security_title: string | null;
  /** For derivatives: number of underlying shares the derivative represents. */
  underlying_security_shares: number | null;
  accession_number: string;
  sec_filing_url: string;
  data_source: "SEC_EDGAR_FORM3";
}

/**
 * Validated query parameters for the (eventual) Form 3 baseline query path.
 * No dedicated MCP tool yet — Form 3 data may be exposed by extending
 * get_insider_transactions with an `include_baseline` flag, or rolled into
 * get_company_filings_summary when that aggregator tool ships.
 */
export interface Form3HoldingsQuery {
  ticker?: string;
  company_cik?: string;
  filer_name?: string;
  filer_cik?: string;
  is_derivative?: boolean;
  since?: string;
  until?: string;
  sort_by?: "filing_date" | "shares_owned";
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
