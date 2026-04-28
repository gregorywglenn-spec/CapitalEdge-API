/**
 * Scraper CLI — runs scrapers from the command line.
 *
 * Usage:
 *   tsx src/scrape.ts form4 AAPL              # Form 4 trades for one ticker
 *   tsx src/scrape.ts form4-feed [days]       # Form 4 across all companies, last N days
 *
 * Output is JSON on stdout, log lines on stderr — pipe-friendly.
 *
 * Future commands (one per ported scraper):
 *   tsx src/scrape.ts senate                  # Senate PTRs
 *   tsx src/scrape.ts house                   # House PTRs
 *   tsx src/scrape.ts 13f <FUND_CIK>          # 13F holdings for one fund
 */

import { scrapeForm4ByTicker, scrapeForm4LiveFeed } from "./scrapers/form4.js";

interface CliCommand {
  description: string;
  run: (args: string[]) => Promise<unknown>;
}

const COMMANDS: Record<string, CliCommand> = {
  form4: {
    description: "Scrape Form 4 open-market trades for a single ticker",
    run: async (args) => {
      const ticker = args[0];
      if (!ticker) {
        throw new Error("Usage: tsx src/scrape.ts form4 <TICKER>");
      }
      return scrapeForm4ByTicker(ticker);
    },
  },
  "form4-feed": {
    description:
      "Scrape Form 4 trades across all companies for the last N days (default 2)",
    run: async (args) => {
      const days = args[0] ? parseInt(args[0], 10) : 2;
      if (Number.isNaN(days) || days < 1) {
        throw new Error("Days must be a positive integer");
      }
      return scrapeForm4LiveFeed(days);
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
