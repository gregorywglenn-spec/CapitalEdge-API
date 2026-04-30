/**
 * Scraper CLI — runs scrapers from the command line.
 *
 * Usage:
 *   tsx src/scrape.ts ping                       Verify Firestore connection
 *   tsx src/scrape.ts form4 AAPL                 Form 4 trades for one ticker
 *   tsx src/scrape.ts form4 AAPL --save          ...and write them to Firestore
 *   tsx src/scrape.ts form4-feed [days]          Form 4 across all companies, last N days
 *   tsx src/scrape.ts form4-feed 2 --save        ...and write them to Firestore
 *   tsx src/scrape.ts 13f berkshire              Latest 13F-HR for one fund (alias or CIK)
 *   tsx src/scrape.ts 13f 0001067983 --save      ...and write to Firestore
 *   tsx src/scrape.ts 13f-feed [days]            Recent 13F filings across all funds
 *   tsx src/scrape.ts 13f-feed 30 --save         ...and write to Firestore
 *   tsx src/scrape.ts funds                      List tracked fund aliases
 *
 * JSON results print to stdout, log lines to stderr — pipe-friendly.
 *
 * Future commands (one per ported scraper):
 *   tsx src/scrape.ts senate                     Senate PTRs
 *   tsx src/scrape.ts house                      House PTRs
 */

import {
  getDbIfLive,
  pingFirestore,
  saveInsiderTransactions,
  saveInstitutionalHoldings,
} from "./firestore.js";
import { scrapeForm4ByTicker, scrapeForm4LiveFeed } from "./scrapers/form4.js";
import {
  listTrackedFunds,
  scrape13FByFund,
  scrape13FLiveFeed,
} from "./scrapers/13f.js";
import {
  dumpEdgar,
  lookupTickerByName,
  normalizeName,
  searchEdgar,
} from "./sec-tickers.js";

interface CliCommand {
  description: string;
  run: (args: string[]) => Promise<unknown>;
}

function hasSaveFlag(args: string[]): boolean {
  return args.includes("--save");
}

const COMMANDS: Record<string, CliCommand> = {
  ping: {
    description: "Verify Firestore connection (live mode) or report stub mode",
    run: async () => {
      const result = await pingFirestore();
      if (result.mode === "stub") {
        console.error(
          "[ping] STUB MODE — no service account at secrets/service-account.json",
        );
      } else {
        console.error(
          `[ping] LIVE MODE — connected to project ${result.projectId ?? "(unknown id)"}, ${result.collectionsSeen} top-level collection(s)`,
        );
      }
      return result;
    },
  },
  form4: {
    description:
      "Scrape Form 4 open-market trades for a single ticker (add --save to write to Firestore)",
    run: async (args) => {
      const ticker = args.find((a) => !a.startsWith("--"));
      if (!ticker) {
        throw new Error("Usage: tsx src/scrape.ts form4 <TICKER> [--save]");
      }
      const trades = await scrapeForm4ByTicker(ticker);
      if (hasSaveFlag(args)) {
        console.error(`[save] Writing ${trades.length} trades to Firestore...`);
        const result = await saveInsiderTransactions(trades);
        console.error(
          `[save] Saved ${result.saved} trades to ${result.collection}`,
        );
      }
      return trades;
    },
  },
  "form4-feed": {
    description:
      "Scrape Form 4 trades across all companies for the last N days (default 2; add --save to write to Firestore)",
    run: async (args) => {
      const positional = args.find((a) => !a.startsWith("--"));
      const days = positional ? parseInt(positional, 10) : 2;
      if (Number.isNaN(days) || days < 1) {
        throw new Error("Days must be a positive integer");
      }
      const trades = await scrapeForm4LiveFeed(days);
      if (hasSaveFlag(args)) {
        console.error(`[save] Writing ${trades.length} trades to Firestore...`);
        const result = await saveInsiderTransactions(trades);
        console.error(
          `[save] Saved ${result.saved} trades to ${result.collection}`,
        );
      }
      return trades;
    },
  },
  "13f": {
    description:
      "Scrape latest 13F-HR for a single fund (alias like 'berkshire' or 10-digit CIK; add --save to write to Firestore)",
    run: async (args) => {
      const fund = args.find((a) => !a.startsWith("--"));
      if (!fund) {
        throw new Error(
          "Usage: tsx src/scrape.ts 13f <ALIAS_OR_CIK> [--save]\n" +
            "Run `tsx src/scrape.ts funds` to see available aliases.",
        );
      }
      const db = await getDbIfLive();
      const holdings = await scrape13FByFund(fund, { db });
      if (hasSaveFlag(args)) {
        console.error(
          `[save] Writing ${holdings.length} holdings to Firestore...`,
        );
        const result = await saveInstitutionalHoldings(holdings);
        console.error(
          `[save] Saved ${result.saved} holdings to ${result.collection}`,
        );
      }
      return holdings;
    },
  },
  "13f-feed": {
    description:
      "Scan EDGAR for recent 13F-HR filings across all funds (default 30 days, max 25 funds; add --save to write to Firestore)",
    run: async (args) => {
      const positional = args.find((a) => !a.startsWith("--"));
      const days = positional ? parseInt(positional, 10) : 30;
      if (Number.isNaN(days) || days < 1) {
        throw new Error("Days must be a positive integer");
      }
      const db = await getDbIfLive();
      const holdings = await scrape13FLiveFeed({ db, days });
      if (hasSaveFlag(args)) {
        console.error(
          `[save] Writing ${holdings.length} holdings to Firestore...`,
        );
        const result = await saveInstitutionalHoldings(holdings);
        console.error(
          `[save] Saved ${result.saved} holdings to ${result.collection}`,
        );
      }
      return holdings;
    },
  },
  funds: {
    description: "List the tracked institutional managers and their aliases",
    run: async () => {
      return listTrackedFunds();
    },
  },
  "test-normalize": {
    description:
      "Smoke-test the EDGAR name fallback against given issuer names. Shows normalized form and EDGAR match (if any). Usage: tsx src/scrape.ts test-normalize \"CYBERARK SOFTWARE LTD\" \"JOHNSON CTLS INTL PLC\" ...",
    run: async (args) => {
      const names = args.filter((a) => !a.startsWith("--"));
      if (names.length === 0) {
        // Default: run the canary set known to fail before the fixes
        names.push(
          "CYBERARK SOFTWARE LTD",
          "JOHNSON CTLS INTL PLC",
          "ACCENTURE PLC IRELAND",
          "COOPER COS INC",
          "HOLOGIC INC",
          "CONFLUENT INC",
          "AVIDITY BIOSCIENCES INC",
          "DAYFORCE INC",
          "JAMF HLDG CORP",
          "EXACT SCIENCES CORP",
          "DUN & BRADSTREET CORP DEL NE",
          "OASIS PETE INC NEW",
          "AMERICAN ELEC PWR CO INC",
        );
      }
      const out: Array<{
        input: string;
        normalized: string;
        edgar_ticker: string;
      }> = [];
      for (const name of names) {
        const normalized = normalizeName(name);
        const ticker = await lookupTickerByName(name);
        out.push({ input: name, normalized, edgar_ticker: ticker });
      }
      return out;
    },
  },
  "dump-edgar": {
    description:
      "Diagnostic: print stats and a sample of EDGAR's company_tickers.json contents to verify the catalog loaded correctly. No arguments.",
    run: async () => {
      return await dumpEdgar(20);
    },
  },
  "search-edgar": {
    description:
      "Diagnostic: search EDGAR's company_tickers.json for entries containing a substring. Use to investigate why test-normalize reports a MISS for a given company. Usage: tsx src/scrape.ts search-edgar HOLOGIC",
    run: async (args) => {
      const term = args.find((a) => !a.startsWith("--"));
      if (!term) {
        throw new Error(
          "Usage: tsx src/scrape.ts search-edgar <SUBSTRING>\n" +
            'Example: tsx src/scrape.ts search-edgar "HOLOGIC"',
        );
      }
      return await searchEdgar(term);
    },
  },
  "flush-cusip-cache": {
    description:
      "Delete all entries in the cusip_map Firestore cache so the next 13f run re-resolves them. Use after changing OpenFIGI selection logic or EDGAR name-fallback normalization.",
    run: async () => {
      const db = await getDbIfLive();
      if (!db) {
        throw new Error(
          "flush-cusip-cache requires LIVE mode (no service account at secrets/service-account.json)",
        );
      }
      const COLLECTION = "cusip_map";
      const collection = db.collection(COLLECTION);
      let deleted = 0;
      const BATCH_SIZE = 400;
      // Loop: read up to BATCH_SIZE docs, batch-delete, repeat until empty.
      // Avoids loading the whole collection into memory at once.
      for (;;) {
        const snap = await collection.limit(BATCH_SIZE).get();
        if (snap.empty) break;
        const batch = db.batch();
        for (const doc of snap.docs) batch.delete(doc.ref);
        await batch.commit();
        deleted += snap.size;
        console.error(`[flush] Deleted ${deleted} cusip_map entries so far...`);
      }
      console.error(`[flush] DONE — ${deleted} entries deleted from ${COLLECTION}`);
      return { collection: COLLECTION, deleted };
    },
  },
};

function printUsage(): void {
  console.error("Usage: tsx src/scrape.ts <command> [args...]");
  console.error("");
  console.error("Available commands:");
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    console.error(`  ${name.padEnd(14)} ${cmd.description}`);
  }
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    process.exit(command ? 0 : 1);
  }

  const cmd = COMMANDS[command];
  if (!cmd) {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }

  const result = await cmd.run(args);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("FATAL:", msg);
  process.exit(1);
});
