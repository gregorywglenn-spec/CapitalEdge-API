import { handler } from "../src/tools/otc-market-weekly.js";
import type { OtcMarketWeekly, ResultEnvelope } from "../src/types.js";

async function run(label: string, args: Record<string, unknown>): Promise<void> {
  console.log(`\n=== ${label} ===`);
  const r = (await handler(args)) as ResultEnvelope<OtcMarketWeekly>;
  console.log(
    JSON.stringify(
      {
        query: args,
        count: r.count,
        has_more: r.has_more,
        sample: r.results.slice(0, 5).map((o) => ({
          id: o.weekly_id,
          symbol: o.issue_symbol,
          name: o.issue_name?.slice(0, 50),
          venue: o.market_participant_name,
          shares: o.total_weekly_share_quantity,
          notional: o.total_notional_sum,
          trades: o.total_weekly_trade_count,
          tier: o.tier_identifier,
        })),
      },
      null,
      2,
    ),
  );
}

await run("TEST 1: NVDA across all venues for week 2026-03-30", {
  issue_symbol: "NVDA",
  week_start_date: "2026-03-30",
  sort_by: "total_weekly_share_quantity",
  limit: 10,
});

await run("TEST 2: top notional NVDA venue", {
  issue_symbol: "NVDA",
  sort_by: "total_notional_sum",
  limit: 3,
});

await run("TEST 3: biggest dark-pool flow that week (T1, top 5 by notional)", {
  week_start_date: "2026-03-30",
  tier_identifier: "T1",
  sort_by: "total_notional_sum",
  limit: 5,
});

await run("TEST 4: JPBX (JP Morgan) top 5 tickers in week 2026-03-30", {
  mpid: "JPBX",
  week_start_date: "2026-03-30",
  sort_by: "total_weekly_share_quantity",
  limit: 5,
});

console.log("\n=== TEST 5: validation error path ===");
try {
  await handler({ issue_symbol: "***" });
  console.log("FAIL: expected validation error");
} catch (e) {
  console.log("OK: " + (e as Error).message);
}

process.exit(0);
