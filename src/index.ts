/**
 * Capital Edge MCP Server — entry point
 *
 * Working-title package: `capital-edge-mcp`
 * Status: v0.2 — first tool registered (`get_insider_transactions`).
 *
 * This server exposes US public financial disclosures (congressional trades,
 * executive insider transactions via Form 4, institutional holdings via 13F)
 * as MCP tools designed natively for AI agents.
 *
 * Architecture:
 *   - src/tools/<tool>.ts    one file per tool, exports `definition` + `handler`
 *   - src/tools/index.ts     registry of all tools
 *   - src/firestore.ts       data layer (auto-detects stub vs live mode)
 *   - src/types.ts           shared types
 *   - src/index.ts           this file — wires MCP server to the registry
 *
 * Transport: stdio for v0.x local development. Remote (HTTPS / SSE) ships
 * once the first tool works end-to-end and a service account is provisioned.
 *
 * Mode auto-detect: live Firestore is used when secrets/service-account.json
 * exists; otherwise the stub returns realistic mock data. See firestore.ts.
 *
 * See README.md, MCP_PROJECT_HANDOFF.md, DATA_REQUIREMENTS_FOR_DASHBOARD.md,
 * and TOOL_DESIGN.md in the project root for full context.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { isStubMode } from "./firestore.js";
import { findTool, TOOLS } from "./tools/index.js";

const SERVER_NAME = "capital-edge-mcp";
const SERVER_VERSION = "0.11.0";

const server = new Server(
  {
    name: SERVER_NAME,
    version: SERVER_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// ─── List tools ─────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: TOOLS.map((t) => t.definition),
  };
});

// ─── Call tool ──────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = findTool(request.params.name);
  if (!tool) {
    return errorResult("UNKNOWN_TOOL", `No tool registered named '${request.params.name}'`);
  }

  try {
    const result = await tool.handler(request.params.arguments ?? {});
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Pull a code prefix out of the message if the handler used the
    // "CODE: details" convention; otherwise fall back to INTERNAL_ERROR.
    const codeMatch = /^([A-Z][A-Z0-9_]+):\s*/.exec(message);
    const code = codeMatch ? codeMatch[1]! : "INTERNAL_ERROR";
    const cleanMessage = codeMatch ? message.slice(codeMatch[0].length) : message;
    return errorResult(code, cleanMessage);
  }
});

function errorResult(code: string, message: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ code, message }, null, 2),
      },
    ],
    isError: true,
  };
}

// ─── Boot ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stderr is convention — stdout is reserved for MCP protocol messages.
  const mode = isStubMode() ? "STUB MODE (no service account)" : "LIVE MODE";
  console.error(
    `${SERVER_NAME} v${SERVER_VERSION} — running on stdio — ${mode} — ${TOOLS.length} tool(s) registered:`,
  );
  for (const t of TOOLS) {
    console.error(`  • ${t.definition.name}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
