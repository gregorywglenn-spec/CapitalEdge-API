/**
 * Tool registry — single source of truth for what tools the server exposes.
 *
 * Adding a new tool is one line here plus one new file in this directory. The
 * server entry point (src/index.ts) iterates this list to register handlers.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as insiderTransactions from "./insider-transactions.js";
import * as institutionalHoldings from "./institutional-holdings.js";

export interface ToolModule {
  definition: Tool;
  handler: (args: unknown) => Promise<unknown>;
}

export const TOOLS: ToolModule[] = [insiderTransactions, institutionalHoldings];

export function findTool(name: string): ToolModule | undefined {
  return TOOLS.find((t) => t.definition.name === name);
}
