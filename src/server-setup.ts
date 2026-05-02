/**
 * Shared MCP-server tool-registration logic. Used by both the stdio entry
 * (src/index.ts — for Claude Desktop) and the HTTP entry (functions/src/
 * index.ts → mcp HTTP function — for remote clients). Keeps DRY so any
 * change to error-handling or response shape happens in one place.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { findTool, TOOLS } from "./tools/index.js";

/**
 * Construct a fresh MCP Server instance with the standard tool capability.
 * For stateless HTTP serving, callers create one of these per request.
 */
export function createMcpServer(name: string, version: string): Server {
  return new Server(
    { name, version },
    { capabilities: { tools: {} } },
  );
}

/**
 * Wire the standard ListTools / CallTool handlers onto a Server instance.
 * Pulls definitions and handlers from the tools/ registry (TOOLS).
 *
 * Errors are surfaced as `isError: true` MCP responses. If a handler throws
 * with a "CODE: message" prefix (the convention in the input-validation
 * helpers), the code is extracted and surfaced separately so agents can
 * branch on it.
 */
export function applyToolHandlers(server: Server): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: TOOLS.map((t) => t.definition),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = findTool(request.params.name);
    if (!tool) {
      return errorResult(
        "UNKNOWN_TOOL",
        `No tool registered named '${request.params.name}'`,
      );
    }
    try {
      const result = await tool.handler(request.params.arguments ?? {});
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const codeMatch = /^([A-Z][A-Z0-9_]+):\s*/.exec(message);
      const code = codeMatch ? codeMatch[1]! : "INTERNAL_ERROR";
      const cleanMessage = codeMatch ? message.slice(codeMatch[0].length) : message;
      return errorResult(code, cleanMessage);
    }
  });
}

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
