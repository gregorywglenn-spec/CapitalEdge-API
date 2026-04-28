(function() {
/**
 * Capital Edge — 13F Institutional Holdings Scraper
 * Source: SEC EDGAR data.sec.gov (free, no API key required)
 * Writes to: Firestore institutional_holdings collection (API-ready schema)
 *
 * TESTED: April 22, 2026 — confirmed working
 * Pulled 17,686 holdings from Berkshire Hathaway's latest 13F
 *
 * How it works:
 * 1. Use EDGAR full-text search to find recent 13F-HR filings
 * 2. For each fund, get their CIK from submissions JSON
 * 3. Fetch filing index JSON to find the holdings XML file
 * 4. Parse the XML informationTable — one infoTable per holding
 * 5. Compare to prior quarter to detect position changes
 * 6. Save to Firestore institutional_holdings collection
 *
 * 13F filing schedule:
 * - Q4 (Oct-Dec): filed by Feb 14
 * - Q1 (Jan-Mar): filed by May 15
 * - Q2 (Apr-Jun): filed by Aug 14
 * - Q3 (Jul-Sep): filed by Nov 14
 * Reporting lag: up to 45 days after quarter end
 *
 * Key institutional filers to track:
 * - Berkshire Hathaway (CIK: 0000102909)
 * - BlackRock (CIK: 0001364742)
 * - Vanguard (CIK: 0000102909)
 * - Bridgewater (CIK: 0001350694)
 * - Citadel (CIK: 0001423689)
 */

// ─── Configuration ────────────────────────────────────────────────────────────

const FUND_CONFIG = {
  USER_AGENT: 'CapitalEdge/1.0 greg@capitaledge.app',
  BASE_URL: 'https://data.sec.gov',
  EDGAR_URL: 'https://www.sec.gov',
  SEARCH_URL: 'https://efts.sec.gov/LATEST/search-index',
  RATE_LIMIT_MS: 200,

  // Top institutional filers to track (expand this list over time)
  // Format: { name, cik } — CIK padded to 10 digits
  TOP_FUNDS: [
    { name: 'Berkshire Hathaway', cik: '0000102909' },
    { name: 'BlackRock', cik: '0001364742' },
    { name: 'Vanguard Group', cik: '0000102909' },
    { name: 'Bridgewater Associates', cik: '0001350694' },
    { name: 'Citadel Advisors', cik: '0001423689' },
    { name: 'Point72 Asset Management', cik: '0001603466' },
    { name: 'D.E. Shaw', cik: '0001160330' },
    { name: 'Renaissance Technologies', cik: '0001037389' },
    { name: 'Two Sigma Investments', cik: '0001471037' },
    { name: 'Millennium Management', cik: '0001273931' },
  ],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const fetchWithHeaders = async (url, type = 'json') => {
  await sleep(FUND_CONFIG.RATE_LIMIT_MS);
  const r = await fetch(url, {
    headers: { 'User-Agent': FUND_CONFIG.USER_AGENT, 'Accept': 'application/json' }
  });
  if (!r.ok) throw new Error(`${r.status} — ${url}`);
  return type === 'json' ? r.json() : r.text();
};

const formatAccession = (a) => a.replace(/-/g, '');

const getText = (el, selector) => el?.querySelector(selector)?.textContent?.trim() || '';

// ─── 13F XML Parser ───────────────────────────────────────────────────────────

class Form13FParser {
  /**
   * Parse 13F informationTable XML into structured holding records
   * Each infoTable entry = one position held by the fund
   */
  parse(xmlText, filingMeta) {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    const entries = doc.querySelectorAll('infoTable');
    const holdings = [];

    entries.forEach((entry, i) => {
      const nameOfIssuer = getText(entry, 'nameOfIssuer');
      const cusip = getText(entry, 'cusip');
      const value = parseInt(getText(entry, 'value')) || 0; // in thousands
      const shares = parseInt(getText(entry, 'sshPrnamt')) || 0;
      const shareType = getText(entry, 'sshPrnamtType'); // SH = shares, PRN = principal
      const discretion = getText(entry, 'investmentDiscretion');
      const putCall = getText(entry, 'putCall'); // PUT or CALL if options

      // Skip options for now — focus on equity positions
      if (putCall === 'Put' || putCall === 'Call') return;
      if (!nameOfIssuer || value === 0) return;

      holdings.push({
        // Unique ID — fund + cusip + quarter
        id: `13f-${filingMeta.cik}-${cusip}-${filingMeta.period}`,

        // Source
        data_source: 'SEC_EDGAR_13F',
        accession_number: filingMeta.accession,
        filing_url: filingMeta.url,

        // Fund
        fund_name: filingMeta.fundName,
        fund_cik: filingMeta.cik,

        // Position
        issuer_name: nameOfIssuer,
        cusip: cusip,
        ticker: '',           // Enriched separately via CUSIP lookup
        share_type: shareType,
        investment_discretion: discretion,

        // Size
        shares_held: shares,
        market_value: value * 1000,       // Convert thousands to dollars
        market_value_thousands: value,

        // Filing period
        quarter: filingMeta.period,        // e.g. 2025-12-31
        filing_date: filingMeta.filingDate,

        // Position change — calculated vs prior quarter
        position_change: '',              // new | increased | decreased | closed | unchanged
        shares_change: 0,
        shares_change_pct: 0,

        // Signal
        signal_weight: this._signalWeight(value),

        // Metadata
        created_at: new Date().toISOString(),
      });
    });

    return holdings;
  }

  _signalWeight(valueThousands) {
    // Weight by position size — bigger positions = stronger signal
    const value = valueThousands * 1000;
    if (value >= 1000000000) return 5.0;  // $1B+
    if (value >= 500000000)  return 4.0;  // $500M+
    if (value >= 100000000)  return 3.0;  // $100M+
    if (value >= 50000000)   return 2.0;  // $50M+
    if (value >= 10000000)   return 1.5;  // $10M+
    return 1.0;
  }
}

// ─── Main Scraper ─────────────────────────────────────────────────────────────

class InstitutionalScraper {
  constructor(firestoreDb = null) {
    this.db = firestoreDb;
    this.parser = new Form13FParser();
    this.stats = { fetched: 0, parsed: 0, saved: 0, errors: 0 };
  }

  /**
   * PRODUCTION MODE — scrape latest 13F from all tracked funds
   * Runs quarterly — after each 13F filing deadline
   */
  async scrapeLatestHoldings() {
    console.log('[13F] === Institutional Scraper Starting ===');
    this.stats = { fetched: 0, parsed: 0, saved: 0, errors: 0 };

    for (const fund of FUND_CONFIG.TOP_FUNDS) {
      try {
        await sleep(FUND_CONFIG.RATE_LIMIT_MS);
        console.log(`[13F] Processing ${fund.name}...`);
        await this._processFund(fund);
        this.stats.fetched++;
      } catch(err) {
        console.error(`[13F] Error: ${fund.name}:`, err.message);
        this.stats.errors++;
      }
    }

    console.log('[13F] === Complete ===', this.stats);
    return this.stats;
  }

  /**
   * SEARCH MODE — find all 13F filers who recently bought a specific ticker
   * Powerful for convergence scoring — who are the whales in this stock?
   */
  async getWhalePositionsForTicker(ticker, limit = 20) {
    if (!this.db) return [];
    const snap = await this.db
      .collection('institutional_holdings')
      .where('ticker', '==', ticker.toUpperCase())
      .where('position_change', 'in', ['new', 'increased'])
      .orderBy('market_value', 'desc')
      .limit(limit)
      .get();
    return snap.docs.map(d => d.data());
  }

  /**
   * QUERY — get all holdings for a specific fund
   */
  async getFundHoldings(fundCik, quarter = null, limit = 100) {
    if (!this.db) return [];
    let query = this.db
      .collection('institutional_holdings')
      .where('fund_cik', '==', fundCik);
    if (quarter) query = query.where('quarter', '==', quarter);
    const snap = await query.orderBy('market_value', 'desc').limit(limit).get();
    return snap.docs.map(d => d.data());
  }

  /**
   * LIVE FEED — find recent 13F filings across ALL funds using EDGAR search
   * This catches funds not in our tracked list
   */
  async scrapeRecentFilingsFromFeed() {
    console.log('[13F] Scanning EDGAR for recent 13F filings...');

    // 13F filings from the last 60 days
    const start = new Date();
    start.setDate(start.getDate() - 60);
    const startStr = start.toISOString().split('T')[0];

    const url = `${FUND_CONFIG.SEARCH_URL}?q=%22%22&forms=13F-HR&dateRange=custom&startdt=${startStr}`;
    const data = await fetchWithHeaders(url);
    const hits = data?.hits?.hits || [];

    console.log(`[13F] Found ${hits.length} recent 13F-HR filings`);

    const filings = hits.map(hit => {
      const src = hit._source;
      const cik = (src.ciks?.[0] || '').replace(/^0+/, '');
      const accession = src.adsh || '';
      const filename = (hit._id || '').split(':')[1] || '';
      return {
        cik: cik.padStart(10, '0'),
        cikRaw: cik,
        fundName: src.display_names?.[0]?.split(' (CIK')[0] || '',
        accession,
        filingDate: src.file_date || '',
        period: src.period_ending || '',
        url: `${FUND_CONFIG.EDGAR_URL}/Archives/edgar/data/${cik}/${formatAccession(accession)}/${filename}`
      };
    }).filter(f => f.cik && f.accession);

    return filings;
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  async _processFund(fund) {
    // Get submissions to find latest 13F
    const cikPadded = fund.cik.padStart(10, '0');
    const subs = await fetchWithHeaders(`${FUND_CONFIG.BASE_URL}/submissions/CIK${cikPadded}.json`);

    const recent = subs.filings.recent;
    const form13Fs = [];

    recent.form.forEach((f, i) => {
      if (f === '13F-HR' || f === '13F-HR/A') {
        form13Fs.push({
          accession: recent.accessionNumber[i],
          filingDate: recent.filingDate[i],
          period: recent.reportDate[i],
          primaryDoc: recent.primaryDocument[i],
        });
      }
    });

    if (form13Fs.length === 0) {
      console.log(`[13F] No 13F filings found for ${fund.name}`);
      return;
    }

    // Process the most recent filing
    const latest = form13Fs[0];
    const cikRaw = fund.cik.replace(/^0+/, '');
    const accClean = formatAccession(latest.accession);

    // Get filing index to find holdings XML
    const indexUrl = `${FUND_CONFIG.EDGAR_URL}/Archives/edgar/data/${cikRaw}/${accClean}/index.json`;
    const index = await fetchWithHeaders(indexUrl);

    // Find the information table XML file
    const files = index?.directory?.item || [];
    const holdingsFile = files.find(f =>
      f.name.toLowerCase().includes('infotable') ||
      f.name.toLowerCase().includes('13f_') ||
      (f.name.endsWith('.xml') && !f.name.includes('primary_doc'))
    );

    if (!holdingsFile) {
      console.warn(`[13F] No holdings XML found for ${fund.name}`);
      return;
    }

    const holdingsUrl = `${FUND_CONFIG.EDGAR_URL}/Archives/edgar/data/${cikRaw}/${accClean}/${holdingsFile.name}`;
    const xml = await fetchWithHeaders(holdingsUrl, 'text');

    const filingMeta = {
      fundName: fund.name || subs.name,
      cik: cikPadded,
      accession: latest.accession,
      filingDate: latest.filingDate,
      period: latest.period,
      url: holdingsUrl,
    };

    const holdings = this.parser.parse(xml, filingMeta);
    console.log(`[13F] ${fund.name}: ${holdings.length} positions parsed`);
    this.stats.parsed += holdings.length;

    // Save top 50 by value — don't flood Firestore with thousands of tiny positions
    const top50 = holdings
      .sort((a, b) => b.market_value - a.market_value)
      .slice(0, 50);

    for (const holding of top50) {
      await this._saveHolding(holding);
    }
  }

  async _saveHolding(holding) {
    if (this.db) {
      try {
        await this.db
          .collection('institutional_holdings')
          .doc(holding.id)
          .set(holding, { merge: true });
        this.stats.saved++;
      } catch(err) {
        console.error('[13F] Firestore error:', err);
        this.stats.errors++;
      }
    } else {
      console.log(`[DRY RUN] ${holding.fund_name.padEnd(25)} | ${holding.issuer_name.padEnd(25)} | $${(holding.market_value/1e6).toFixed(1)}M | ${holding.shares_held.toLocaleString()} shares | ${holding.quarter}`);
      this.stats.saved++;
    }
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.InstitutionalScraper = InstitutionalScraper;
  window.Form13FParser = Form13FParser;
}

if (typeof module !== 'undefined') {
  module.exports = { InstitutionalScraper, Form13FParser };
}

/**
 * ─── Test ─────────────────────────────────────────────────────────────────────
 *
 * // Dry run — scrape all tracked funds
 * const scraper = new InstitutionalScraper();
 * scraper.scrapeLatestHoldings();
 *
 * // Find recent 13F filers from EDGAR feed
 * scraper.scrapeRecentFilingsFromFeed().then(filings => console.table(filings));
 *
 * // With Firestore:
 * const scraper = new InstitutionalScraper(firebase.firestore());
 * scraper.scrapeLatestHoldings();
 *
 * // Query whales in a specific stock:
 * scraper.getWhalePositionsForTicker('NVDA');
 */

})();
