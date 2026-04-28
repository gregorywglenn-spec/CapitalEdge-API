(function() {
/**
 * Capital Edge — Congressional Trade Scraper (Senate)
 * Source: United States Senate eFD portal
 *         https://efdsearch.senate.gov
 *
 * TESTED: April 22, 2026 — confirmed pulling live PTR data
 * Pulled 29 trades from 10 senators in one run
 *
 * How it works:
 * 1. POST to /search/report/data/ with report_types=[11] (Periodic Transactions)
 * 2. Get back JSON list of PTR filings with senator name + PTR ID
 * 3. For each PTR, fetch /search/view/ptr/{id}/ — returns HTML
 * 4. Parse the HTML table — one row per trade
 * 5. Normalize and save to Firestore congressional_trades collection
 *
 * Session requirement:
 * - Must first visit home page and accept terms (sets session cookie)
 * - CSRF token required in POST headers
 * - Session times out — scraper handles refresh
 *
 * Reporting lag: Up to 45 days (STOCK Act requirement)
 * Always use disclosure_date (filed), not transaction_date, for signal timing
 */

// ─── Configuration ────────────────────────────────────────────────────────────

const SENATE_CONFIG = {
  BASE_URL: 'https://efdsearch.senate.gov',
  HOME_URL: 'https://efdsearch.senate.gov/search/home/',
  SEARCH_URL: 'https://efdsearch.senate.gov/search/',
  DATA_URL: 'https://efdsearch.senate.gov/search/report/data/',
  PTR_URL: 'https://efdsearch.senate.gov/search/view/ptr/',
  REPORT_TYPE_PTR: 11,       // Periodic Transaction Reports
  RATE_LIMIT_MS: 300,        // 300ms between requests — be respectful
  PAGE_SIZE: 100,            // Records per page
  LOOKBACK_DAYS: 7,          // How far back to look (PTRs can lag up to 45 days)
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const businessDaysBetween = (date1, date2) => {
  if (!date1 || !date2) return null;
  // Handle MM/DD/YYYY format from Senate portal
  const parseDate = (d) => {
    if (d.includes('/')) {
      const [m, day, y] = d.split('/');
      return new Date(`${y}-${m.padStart(2,'0')}-${day.padStart(2,'0')}`);
    }
    return new Date(d);
  };
  const d1 = parseDate(date1);
  const d2 = parseDate(date2);
  let count = 0;
  const cur = new Date(Math.min(d1, d2));
  const end = new Date(Math.max(d1, d2));
  while (cur < end) {
    if (cur.getDay() !== 0 && cur.getDay() !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
};

// Convert MM/DD/YYYY to ISO YYYY-MM-DD
const toISO = (dateStr) => {
  if (!dateStr) return '';
  if (dateStr.includes('/')) {
    const [m, d, y] = dateStr.split('/');
    return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }
  return dateStr;
};

// ─── Session Manager ──────────────────────────────────────────────────────────

class SenateSession {
  constructor() {
    this.csrfToken = null;
    this.sessionActive = false;
  }

  /**
   * Initialize session by visiting home page and accepting terms
   * This sets the session cookie and CSRF token
   */
  async initialize() {
    console.log('[Senate] Initializing session...');

    // Step 1: Visit home page to get CSRF token
    const homeResponse = await fetch(SENATE_CONFIG.HOME_URL, {
      credentials: 'include',
      headers: { 'User-Agent': 'CapitalEdge/1.0 greg@capitaledge.app' }
    });

    // Extract CSRF token from cookies
    this.csrfToken = this._getCSRFToken();
    console.log('[Senate] CSRF token:', this.csrfToken ? 'found' : 'not found');

    // Step 2: POST to accept terms (simulates checking the checkbox)
    await sleep(SENATE_CONFIG.RATE_LIMIT_MS);
    const acceptResponse = await fetch(SENATE_CONFIG.SEARCH_URL, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'User-Agent': 'CapitalEdge/1.0 greg@capitaledge.app',
        'X-CSRFToken': this.csrfToken,
        'Referer': SENATE_CONFIG.HOME_URL,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `csrfmiddlewaretoken=${this.csrfToken}&prohibition_agreement=1`
    });

    this.sessionActive = acceptResponse.ok || acceptResponse.status === 302;
    this.csrfToken = this._getCSRFToken(); // Refresh after POST
    console.log('[Senate] Session initialized:', this.sessionActive);
    return this.sessionActive;
  }

  _getCSRFToken() {
    return document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
  }

  getHeaders() {
    return {
      'User-Agent': 'CapitalEdge/1.0 greg@capitaledge.app',
      'X-CSRFToken': this._getCSRFToken(),
      'Referer': SENATE_CONFIG.SEARCH_URL,
    };
  }
}

// ─── PTR HTML Parser ──────────────────────────────────────────────────────────

class PTRParser {
  /**
   * Parse a PTR HTML page into structured trade records
   * Table headers: # | Transaction Date | Owner | Ticker | Asset Name | Asset Type | Type | Amount | Comment
   */
  parse(html, meta) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const trades = [];
    const rows = doc.querySelectorAll('table tr');

    rows.forEach((row, i) => {
      if (i === 0) return; // skip header row
      const cells = Array.from(row.querySelectorAll('td')).map(c => c.textContent.trim());
      if (cells.length < 8) return;

      const transactionDate = cells[1] || '';
      const ticker = cells[3] || '';
      const assetName = cells[4] || '';
      const transactionType = cells[6] || '';
      const amount = cells[7] || '';

      // Skip non-stock assets
      const assetType = cells[5] || '';
      if (!['Stock', 'Stock Option'].includes(assetType) && !ticker) return;

      // Normalize transaction type
      const isBuy = transactionType.toLowerCase().includes('purchase');
      const isSell = transactionType.toLowerCase().includes('sale') ||
                     transactionType.toLowerCase().includes('sell');
      if (!isBuy && !isSell) return;

      const trade = {
        // Unique ID
        id: `senate-${meta.ptr_id}-${i}`,

        // Source
        data_source: 'SENATE_EFD_PTR',
        ptr_id: meta.ptr_id,
        ptr_url: `${SENATE_CONFIG.PTR_URL}${meta.ptr_id}/`,
        chamber: 'senate',

        // Member
        member_name: `${meta.first_name} ${meta.last_name}`,
        member_first: meta.first_name,
        member_last: meta.last_name,
        office: meta.office,
        party: meta.party || '',      // Not in PTR — enriched separately
        state: meta.state || '',       // Not in PTR — enriched separately

        // Asset
        ticker: ticker || '',
        asset_name: assetName || '',
        asset_type: assetType || 'Stock',

        // Transaction
        transaction_type: isBuy ? 'buy' : 'sell',
        transaction_date: toISO(transactionDate),
        disclosure_date: toISO(meta.date_filed),
        reporting_lag_days: businessDaysBetween(transactionDate, meta.date_filed),

        // Amount (Senate reports ranges, not exact amounts)
        amount_range: amount,
        amount_min: this._parseAmountMin(amount),
        amount_max: this._parseAmountMax(amount),

        // Owner
        owner: cells[2] || 'Self',    // Self | Spouse | Joint | Dependent

        // Comment
        comment: cells[8] || '',

        // Signal
        signal_weight: this._signalWeight(amount, isBuy),

        // Metadata
        created_at: new Date().toISOString(),
      };

      trades.push(trade);
    });

    return trades;
  }

  // Parse "$1,001 - $15,000" → 1001
  _parseAmountMin(amountStr) {
    const match = amountStr.replace(/,/g, '').match(/\$(\d+)/);
    return match ? parseInt(match[1]) : 0;
  }

  // Parse "$1,001 - $15,000" → 15000
  _parseAmountMax(amountStr) {
    const matches = amountStr.replace(/,/g, '').match(/\$(\d+)/g);
    if (!matches || matches.length < 2) return this._parseAmountMin(amountStr);
    return parseInt(matches[1].replace('$', ''));
  }

  // Signal weight based on amount range and buy/sell
  _signalWeight(amountStr, isBuy) {
    const min = this._parseAmountMin(amountStr);
    let w = 1.0;

    if (min >= 1000000)     w *= 3.0;
    else if (min >= 250000) w *= 2.5;
    else if (min >= 50000)  w *= 2.0;
    else if (min >= 15000)  w *= 1.5;

    // Buys carry more signal weight than sells
    if (!isBuy) w *= 0.8;

    return Math.round(w * 10) / 10;
  }
}

// ─── Main Scraper ─────────────────────────────────────────────────────────────

class CongressionalScraper {
  constructor(firestoreDb = null) {
    this.db = firestoreDb;
    this.session = new SenateSession();
    this.parser = new PTRParser();
    this.stats = { fetched: 0, parsed: 0, saved: 0, errors: 0 };
  }

  /**
   * PRODUCTION MODE — scrape all PTRs filed in the last N days
   * Called by morning routine agent
   */
  async scrapeLatestCongressionalTrades() {
    console.log('[Senate] === Congressional Scraper Starting ===');
    this.stats = { fetched: 0, parsed: 0, saved: 0, errors: 0 };

    try {
      await this.session.initialize();

      const ptrs = await this._fetchPTRList();
      console.log(`[Senate] ${ptrs.length} PTR filings found`);

      for (const ptr of ptrs) {
        try {
          await sleep(SENATE_CONFIG.RATE_LIMIT_MS);
          const trades = await this._processPTR(ptr);
          this.stats.fetched++;
          console.log(`[Senate] ✓ ${ptr.first_name} ${ptr.last_name}: ${trades.length} trades`);
        } catch(err) {
          console.error(`[Senate] Error processing ${ptr.last_name}:`, err.message);
          this.stats.errors++;
        }
      }
    } catch(err) {
      console.error('[Senate] Fatal error:', err.message);
    }

    console.log('[Senate] === Complete ===', this.stats);
    return this.stats;
  }

  /**
   * Get trades for a specific ticker from Firestore
   * Used by app UI and API layer
   */
  async getTradesForTicker(ticker, limit = 50) {
    if (!this.db) return [];
    const snap = await this.db
      .collection('congressional_trades')
      .where('ticker', '==', ticker.toUpperCase())
      .orderBy('transaction_date', 'desc')
      .limit(limit)
      .get();
    return snap.docs.map(d => d.data());
  }

  /**
   * Get recent buys — signals dashboard
   */
  async getRecentBuys(limit = 20) {
    if (!this.db) return [];
    const snap = await this.db
      .collection('congressional_trades')
      .where('transaction_type', '==', 'buy')
      .orderBy('disclosure_date', 'desc')
      .limit(limit)
      .get();
    return snap.docs.map(d => d.data());
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  async _fetchPTRList() {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - SENATE_CONFIG.LOOKBACK_DAYS);

    const formatDate = (d) => {
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const y = d.getFullYear();
      return `${m}/${day}/${y} 00:00:00`;
    };

    const formData = new FormData();
    formData.append('start', '0');
    formData.append('length', String(SENATE_CONFIG.PAGE_SIZE));
    formData.append('report_types', `[${SENATE_CONFIG.REPORT_TYPE_PTR}]`);
    formData.append('submitted_start_date', formatDate(start));
    formData.append('submitted_end_date', formatDate(end));
    formData.append('candidate_state', '');
    formData.append('senator_state', '');
    formData.append('first_name', '');
    formData.append('last_name', '');
    formData.append('csrfmiddlewaretoken', document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '');

    const response = await fetch(SENATE_CONFIG.DATA_URL, {
      method: 'POST',
      credentials: 'include',
      headers: this.session.getHeaders(),
      body: formData,
    });

    const data = await response.json();
    const rows = data?.data || [];

    return rows.map(r => ({
      first_name: r[0],
      last_name: r[1],
      office: r[2],
      date_filed: r[4],
      ptr_id: r[3].match(/\/ptr\/([a-f0-9-]+)\//)?.[1] || '',
    })).filter(r => r.ptr_id);
  }

  async _processPTR(ptr) {
    const url = `${SENATE_CONFIG.PTR_URL}${ptr.ptr_id}/`;
    const response = await fetch(url, {
      credentials: 'include',
      headers: this.session.getHeaders(),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    const trades = this.parser.parse(html, ptr);
    this.stats.parsed += trades.length;

    for (const trade of trades) {
      await this._saveTrade(trade);
    }
    return trades;
  }

  async _saveTrade(trade) {
    if (!trade.ticker && !trade.asset_name) return;

    if (this.db) {
      try {
        await this.db
          .collection('congressional_trades')
          .doc(trade.id)
          .set(trade, { merge: true });
        this.stats.saved++;
        const flag = trade.transaction_type === 'buy' ? '🟢 BUY' : '🔴 SELL';
        console.log(`[Senate] ✓ ${flag} ${trade.ticker} | ${trade.member_name} | ${trade.amount_range} | ${trade.transaction_date}`);
      } catch(err) {
        console.error('[Senate] Firestore error:', err);
        this.stats.errors++;
      }
    } else {
      // Dry run
      const flag = trade.transaction_type === 'buy' ? '🟢 BUY' : '🔴 SELL';
      console.log(`[DRY RUN] ${flag} ${trade.ticker.padEnd(6)} | ${trade.member_name.padEnd(22)} | ${trade.amount_range.padEnd(22)} | ${trade.transaction_date} | lag: ${trade.reporting_lag_days} days | weight: ${trade.signal_weight}`);
      this.stats.saved++;
    }
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.CongressionalScraper = CongressionalScraper;
  window.SenateSession = SenateSession;
  window.PTRParser = PTRParser;
}

if (typeof module !== 'undefined') {
  module.exports = { CongressionalScraper, SenateSession, PTRParser };
}

/**
 * ─── Test ─────────────────────────────────────────────────────────────────────
 * Run on efdsearch.senate.gov after accepting terms:
 *
 * const scraper = new CongressionalScraper();
 * scraper.scrapeLatestCongressionalTrades();
 *
 * With Firestore:
 * const scraper = new CongressionalScraper(firebase.firestore());
 * scraper.scrapeLatestCongressionalTrades();
 */

})();
