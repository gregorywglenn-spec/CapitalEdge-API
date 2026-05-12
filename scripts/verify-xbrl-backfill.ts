/**
 * Post-backfill verification of the xbrl_fundamentals collection.
 * Reports:
 *   - Total record count
 *   - Distinct ticker count + sample
 *   - Any tickers with suspicious preferred-share-class patterns
 *     (X-PY, X.PY suffixes — leak from reverse-lookup we should have
 *     suppressed via tickerOverride)
 *   - Sample latest-snapshot queries for 5 canary tickers
 */
import { getDbIfLive } from "../src/firestore.js";
import { handler as fundamentalsHandler } from "../src/tools/fundamentals.js";
import type { XbrlFundamental } from "../src/types.js";

const db = await getDbIfLive();
if (!db) {
  console.error("Live mode required.");
  process.exit(1);
}

const col = db.collection("xbrl_fundamentals");

// Total count — Firestore has no efficient count() in client SDK but the
// admin SDK has aggregateQuery. Approximate via fetch + length on a wide
// limit cap.
const snap = await col.limit(1000000).select("ticker").get();
console.log(`Total docs in collection: ${snap.size}`);

const byTicker = new Map<string, number>();
for (const d of snap.docs) {
  const t = (d.data() as { ticker?: string }).ticker ?? "";
  byTicker.set(t, (byTicker.get(t) ?? 0) + 1);
}
console.log(`Distinct tickers: ${byTicker.size}`);

console.log("\nTickers by record count (top 20):");
const sorted = Array.from(byTicker.entries()).sort((a, b) => b[1] - a[1]);
for (const [t, c] of sorted.slice(0, 20)) {
  console.log(`  ${t.padEnd(12)} ${c}`);
}

console.log("\nSuspicious ticker patterns (-P, .P, hyphen-suffix):");
const suspicious = Array.from(byTicker.keys()).filter((t) =>
  /[-.]P[A-Z]?$|[-.][A-Z]$/.test(t),
);
if (suspicious.length === 0) {
  console.log("  none");
} else {
  for (const t of suspicious) console.log(`  ${t.padEnd(12)} ${byTicker.get(t)}`);
}

console.log("\nSample latest-snapshot queries (income statement):");
const canaries = ["AAPL", "JPM", "BRK.B", "NVDA", "LMT"];
for (const ticker of canaries) {
  const result = (await fundamentalsHandler({
    ticker,
    category: "income_statement",
    latest_only: true,
    limit: 5,
  })) as { count: number; results: XbrlFundamental[] };
  console.log(`  ${ticker.padEnd(8)} → ${result.count} concepts in latest snapshot`);
  for (const r of result.results.slice(0, 2)) {
    const label = r.concept_label.slice(0, 40).padEnd(42);
    console.log(`     ${r.period_end} | ${label} | $${(r.value / 1e9).toFixed(2)}B (${r.unit})`);
  }
}

process.exit(0);
