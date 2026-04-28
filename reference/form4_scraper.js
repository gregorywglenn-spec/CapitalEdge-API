(function() {
/**
 * Capital Edge — Form 4 Insider Trade Scraper
 * Sources: SEC EDGAR data.sec.gov (free, no API key required)
 * Writes to: Firestore insider_trades collection (API-ready schema)
 *
 * TESTED: April 22, 2026 — confirmed pulling live data from EDGAR
 *
 * EDGAR Rate Limits: 10 requests/second max
 * Required header: User-Agent with app name and contact email
 *
 * Two modes:
 *   1. Live feed mode — scrapes all Form 4s filed in last N days (production)
 *   2. By ticker mode — scrapes all Form 4s for one company (watchlist)
 *
 * Usage:
 *   const scraper = new Form4Scraper();
 *   await scraper.scrapeLatestInsiderTrades();   // all recent filings
 *   await scraper.scrapeByTicker('AAPL');        // one ticker
 */

// ─── Configuration ────────────────────────────────────────────────────────────

const CONFIG = {
  USER_AGENT: 'CapitalEdge/1.0 greg@capitaledge.app',
  BASE_URL: 'https://data.sec.gov',
  EDGAR_URL: 'https://www.sec.gov',
  SEARCH_URL: 'https://efts.sec.gov/LATEST/search-index',
  RATE_LIMIT_MS: 150,        // 150ms between requests (~6/sec, under 10/sec limit)
  MAX_FILINGS_PER_RUN: 100,  // How many Form 4s to process per run
  LOOKBACK_DAYS: 2,          // How far back to look for new filings
  MIN_TRADE_VALUE: 5000,     // Skip trades under this value — not meaningful signals
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const fetchWithHeaders = async (url, type = 'json') => {
  await sleep(CONFIG.RATE_LIMIT_MS);
  const response = await fetch(url, {
    headers: {
      'User-Agent': CONFIG.USER_AGENT,
      'Accept': 'application/json',
    }
  });
  if (!response.ok) {
    throw new Error(`EDGAR fetch failed: ${response.status} ${response.statusText} — ${url}`);
  }
  return type === 'json' ? response.json() : response.text();
};

const formatAccessionForUrl = (a) => a.replace(/-/g, '');

const businessDaysBetween = (date1, date2) => {
  if (!date1 || !date2) return null;
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  let count = 0;
  const current = new Date(Math.min(d1, d2));
  const end = new Date(Math.max(d1, d2));
  while (current < end) {
    const day = current.getDay();
    if (day !== 0 && day !== 6) count++;
    current.setDate(current.getDate() + 1);
  }
  return count;
};

// ─── Ticker to CIK Lookup ─────────────────────────────────────────────────────

class TickerCIKMap {
  constructor() {
    this.map = null;
  }

  async load() {
    if (this.map) return this.map;
    console.log('[CapitalEdge] Loading ticker→CIK map from EDGAR...');
    const data = await fetchWithHeaders(`${CONFIG.EDGAR_URL}/files/company_tickers.json`);
    this.map = {};
    Object.values(data).forEach(({ ticker, cik_str, title }) => {
      this.map[ticker.toUpperCase()] = {
        cik: String(cik_str).padStart(10, '0'),
        cikRaw: String(cik_str),
        name: title
      };
    });
    console.log(`[CapitalEdge] Loaded ${Object.keys(this.map).length} tickers`);
    return this.map;
  }

  async getCIK(ticker) {
    const map = await this.load();
    return map[ticker.toUpperCase()] || null;
  }
}

// ─── Form 4 XML Parser ────────────────────────────────────────────────────────

class Form4Parser {
  /**
   * Parse Form 4 XML into structured trade records
   * Only captures open-market buys (P) and sells (S)
   * Filters out grants, awards, option exercises
   */
  parse(xmlText, filingMeta) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'text/xml');
    const trades = [];

    const reportingOwner = doc.querySelector('reportingOwner');
    if (!reportingOwner) return trades;

    const officerName = this._get(reportingOwner, 'rptOwnerName');
    const isDirector = this._get(reportingOwner, 'isDirector') === '1';
    const officerTitle = this._get(reportingOwner, 'officerTitle') ||
      (isDirector ? 'Director' : '');

    const issuer = doc.querySelector('issuer');
    const ticker = this._get(issuer, 'issuerTradingSymbol');
    const companyName = this._get(issuer, 'issuerName');
    const cik = this._get(issuer, 'issuerCik');

    doc.querySelectorAll('nonDerivativeTransaction').forEach(tx => {
      const code = this._get(tx, 'transactionCode');

      // P = open-market purchase, S = open-market sale
      // Skip A (grant), M (option exercise), F (tax withholding), etc.
      if (!['P', 'S'].includes(code)) return;

      const shares = parseFloat(this._get(tx, 'transactionShares value')) || 0;
      const price = parseFloat(this._get(tx, 'transactionPricePerShare value')) || 0;
      const date = this._get(tx, 'transactionDate value');
      const sharesAfter = parseFloat(this._get(tx, 'sharesOwnedFollowingTransaction value')) || 0;
      const acqDisp = this._get(tx, 'transactionAcquiredDisposedCode value');
      const value = shares * price;

      if (value < CONFIG.MIN_TRADE_VALUE) return;

      const trade = {
        // Unique ID — prevents duplicate saves
        id: `${filingMeta.accession}-${date}-${code}-${Math.round(shares)}`,

        // Filing metadata
        sec_filing_url: filingMeta.url,
        accession_number: filingMeta.accession,
        data_source: 'SEC_EDGAR_FORM4',

        // Company
        ticker: ticker || '',
        company_name: companyName || '',
        cik: cik || filingMeta.companyCik || '',

        // Officer
        officer_name: officerName || '',
        officer_title: officerTitle || '',

        // Transaction
        transaction_type: code === 'P' ? 'buy' : 'sell',
        transaction_code: code,
        security_title: this._get(tx, 'securityTitle value') || 'Common Stock',
        transaction_date: date || '',
        disclosure_date: filingMeta.filedAt || '',
        reporting_lag_days: businessDaysBetween(date, filingMeta.filedAt),

        // Amounts
        shares: shares,
        price_per_share: price,
        total_value: value,
        shares_owned_after: sharesAfter,
        acquired_disposed: acqDisp,

        // Signal intelligence — used by convergence scorer
        signal_weight: this._signalWeight(value, code, officerTitle),

        // Timestamps
        created_at: new Date().toISOString(),
      };

      trades.push(trade);
    });

    return trades;
  }

  /**
   * Signal weight for convergence scorer
   * Large buys by senior officers = high weight
   * Sells weighted lower (insiders sell for many reasons)
   */
  _signalWeight(value, code, title) {
    let w = 1.0;

    if (value > 1000000)     w *= 3.0;
    else if (value > 500000) w *= 2.5;
    else if (value > 100000) w *= 2.0;
    else if (value > 50000)  w *= 1.5;

    const t = (title || '').toUpperCase();
    if (t.includes('CEO') || t.includes('CHIEF EXECUTIVE')) w *= 2.0;
    else if (t.includes('CFO') || t.includes('CHIEF FINANCIAL')) w *= 1.8;
    else if (t.includes('PRESIDENT')) w *= 1.5;
    else if (t.includes('DIRECTOR')) w *= 1.2;

    if (code === 'S') w *= 0.7; // sells carry less signal

    return Math.round(w * 10) / 10;
  }

  _get(parent, selector) {
    return parent?.querySelector(selector)?.textContent?.trim() || '';
  }
}

// ─── Main Scraper ─────────────────────────────────────────────────────────────

class Form4Scraper {
  constructor(firestoreDb = null) {
    this.db = firestoreDb;
    this.parser = new Form4Parser();
    this.tickerMap = new TickerCIKMap();
    this.stats = { fetched: 0, parsed: 0, saved: 0, errors: 0 };
  }

  /**
   * PRODUCTION MODE
   * Scrape all Form 4s filed in the last N days from EDGAR live feed
   * Called by morning routine agent every day
   * This is how we get EVERYTHING — not just watched tickers
   */
  async scrapeLatestInsiderTrades() {
    console.log('[CapitalEdge] === Form 4 Scraper Starting (Live Feed Mode) ===');
    this.stats = { fetched: 0, parsed: 0, saved: 0, errors: 0 };

    try {
      const filings = await this._getRecentFilingsFromFeed();
      console.log(`[CapitalEdge] ${filings.length} Form 4 filings found — processing ${Math.min(filings.length, CONFIG.MAX_FILINGS_PER_RUN)}...`);

      for (const filing of filings.slice(0, CONFIG.MAX_FILINGS_PER_RUN)) {
        try {
          await this._processFiling(filing);
          this.stats.fetched++;
        } catch (err) {
          this.stats.errors++;
        }
      }
    } catch (err) {
      console.error('[CapitalEdge] Scraper error:', err.message);
    }

    console.log('[CapitalEdge] === Complete ===', this.stats);
    return this.stats;
  }

  /**
   * WATCHLIST MODE
   * Scrape Form 4s for a specific ticker when user adds it to watchlist
   */
  async scrapeByTicker(ticker) {
    console.log(`[CapitalEdge] Scraping Form 4s for ${ticker}...`);

    const tickerData = await this.tickerMap.getCIK(ticker);
    if (!tickerData) {
      console.warn(`[CapitalEdge] No CIK found for: ${ticker}`);
      return [];
    }

    const { cik, cikRaw, name } = tickerData;
    console.log(`[CapitalEdge] ${ticker} = ${name} (CIK: ${cik})`);

    const subs = await fetchWithHeaders(`${CONFIG.BASE_URL}/submissions/CIK${cik}.json`);
    const form4s = this._extractForm4sFromSubmissions(subs, cikRaw);
    console.log(`[CapitalEdge] ${form4s.length} Form 4 filings for ${ticker}`);

    const allTrades = [];
    for (const filing of form4s.slice(0, 20)) {
      try {
        const trades = await this._processFiling(filing);
        allTrades.push(...trades);
      } catch (err) {
        this.stats.errors++;
      }
    }

    console.log(`[CapitalEdge] ${allTrades.length} open-market trades found for ${ticker}`);
    return allTrades;
  }

  /**
   * QUERY — used by app UI and API layer
   * Get trades for a specific ticker from local database
   */
  async getTradesForTicker(ticker, limit = 50) {
    if (!this.db) return [];
    const snap = await this.db
      .collection('insider_trades')
      .where('ticker', '==', ticker.toUpperCase())
      .orderBy('transaction_date', 'desc')
      .limit(limit)
      .get();
    return snap.docs.map(d => d.data());
  }

  /**
   * SIGNALS DASHBOARD — top insider buys by value
   */
  async getRecentBuySignals(minValue = 50000, limit = 20) {
    if (!this.db) return [];
    const snap = await this.db
      .collection('insider_trades')
      .where('transaction_type', '==', 'buy')
      .where('total_value', '>=', minValue)
      .orderBy('total_value', 'desc')
      .limit(limit)
      .get();
    return snap.docs.map(d => d.data());
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  /**
   * EDGAR full-text search feed — returns all Form 4s in date range
   * Returns structured filing objects with correct CIK and URL
   * TESTED April 22 2026 — confirmed working, returns _source.ciks[] and _source.adsh
   */
  async _getRecentFilingsFromFeed() {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - CONFIG.LOOKBACK_DAYS);
    const startStr = start.toISOString().split('T')[0];
    const endStr = end.toISOString().split('T')[0];

    const url = `${CONFIG.SEARCH_URL}?q=%22%22&forms=4&dateRange=custom&startdt=${startStr}&enddt=${endStr}`;

    try {
      const data = await fetchWithHeaders(url);
      const hits = data?.hits?.hits || [];

      return hits.map(hit => {
        const src = hit._source;
        // ciks[1] = company, ciks[0] = reporting officer/filer
        const companyCik = (src.ciks?.[1] || src.ciks?.[0] || '').replace(/^0+/, '');
        const accession = src.adsh || '';
        const filename = (hit._id || '').split(':')[1] || '';

        return {
          accession,
          companyCik,
          filedAt: src.file_date || '',
          entityName: src.display_names?.[1] || src.display_names?.[0] || '',
          url: `${CONFIG.EDGAR_URL}/Archives/edgar/data/${companyCik}/${formatAccessionForUrl(accession)}/${filename}`
        };
      }).filter(f => f.accession && f.companyCik && f.url && !f.url.endsWith('/'));

    } catch (err) {
      console.error('[CapitalEdge] Feed fetch error:', err.message);
      return [];
    }
  }

  _extractForm4sFromSubmissions(submissions, cikRaw) {
    const recent = submissions?.filings?.recent;
    if (!recent) return [];

    const filings = [];
    const forms = recent.form || [];
    const accessions = recent.accessionNumber || [];
    const filingDates = recent.filingDate || [];
    const primaryDocs = recent.primaryDocument || [];

    forms.forEach((form, i) => {
      if (form === '4' || form === '4/A') {
        filings.push({
          accession: accessions[i],
          companyCik: cikRaw,
          filedAt: filingDates[i],
          url: `${CONFIG.EDGAR_URL}/Archives/edgar/data/${cikRaw}/${formatAccessionForUrl(accessions[i])}/${primaryDocs[i]}`
        });
      }
    });

    return filings;
  }

  async _processFiling(filing) {
    const xmlText = await fetchWithHeaders(filing.url, 'text');
    const trades = this.parser.parse(xmlText, filing);
    this.stats.parsed += trades.length;
    for (const trade of trades) {
      await this._saveTrade(trade);
    }
    return trades;
  }

  async _saveTrade(trade) {
    if (!trade.ticker || !trade.transaction_date) return;

    if (this.db) {
      // Save to Firestore
      try {
        await this.db
          .collection('insider_trades')
          .doc(trade.id)
          .set(trade, { merge: true });
        this.stats.saved++;
        console.log(`[CapitalEdge] ✓ ${trade.ticker} ${trade.transaction_type.toUpperCase()} $${trade.total_value.toLocaleString()} — ${trade.officer_name} (${trade.officer_title})`);
      } catch (err) {
        console.error('[CapitalEdge] Firestore error:', err);
        this.stats.errors++;
      }
    } else {
      // Dry run — log to console
      const flag = trade.transaction_type === 'buy' ? '🟢 BUY' : '🔴 SELL';
      console.log(`[DRY RUN] ${flag} ${trade.ticker} | ${trade.officer_name} (${trade.officer_title}) | $${trade.total_value.toLocaleString()} | ${trade.transaction_date} | lag: ${trade.reporting_lag_days} days | weight: ${trade.signal_weight}`);
      this.stats.saved++;
    }
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.Form4Scraper = Form4Scraper;
  window.TickerCIKMap = TickerCIKMap;
  window.Form4Parser = Form4Parser;
}

if (typeof module !== 'undefined') {
  module.exports = { Form4Scraper, TickerCIKMap, Form4Parser };
}

/**
 * ─── Test in Browser Console ──────────────────────────────────────────────────
 *
 * // Test 1: Pull latest filings across all companies
 * const scraper = new Form4Scraper();
 * scraper.scrapeLatestInsiderTrades();
 *
 * // Test 2: Pull filings for one ticker
 * const scraper = new Form4Scraper();
 * scraper.scrapeByTicker('NVDA');
 *
 * // With Firestore connected:
 * const scraper = new Form4Scraper(firebase.firestore());
 * scraper.scrapeLatestInsiderTrades();
 */

})();
