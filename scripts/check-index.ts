import { TOOLS } from "../src/tools/index.js";

const tool = TOOLS.find((t) => t.definition.name === "get_congressional_trades");
if (!tool) {
  console.log("Tool not found");
  process.exit(1);
}
try {
  const r = (await tool.handler({ transaction_type: "buy", limit: 3 })) as {
    count: number;
  };
  console.log(`READY: ${r.count} results`);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("currently building")) {
    console.log("STILL BUILDING");
  } else {
    console.log("OTHER ERROR: " + msg.slice(0, 200));
  }
}
process.exit(0);
