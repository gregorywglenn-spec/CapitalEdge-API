/**
 * Scraper CLI — runs scrapers from the command line.
 *
 * Usage:
 *   tsx src/scrape.ts ping                       Verify Firestore connection
 *   tsx src/scrape.ts form4 AAPL                 Form 4 trades for one ticker
 *   tsx src/scrape.ts form4 AAPL --save          ...and write them to Firestore
 *   tsx src/scrape.ts form4-feed [days]          Form 4 across all companies, last N days
 *   tsx src/scrape.ts form4-feed 2 --save        ...and write them to Firestore
 *
 * JSON results print to stdout, log lines to stderr — pipe-friendly.
 *
 * Future commands (one per ported scraper):
 *   tsx src/scrape.ts senate                     Senate PTRs
 *   tsx src/scrape.ts house                      House PTRs
 *   tsx src/scrape.ts 13f <FUND_CIK>             13F holdings for one fund
 */

import { pingFirestore, saveInsiderTransactions } from "./firestore.js";
import { scrapeForm4ByTicker, scrapeForm4LiveFeed } from "./scrapers/form4.js";

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
