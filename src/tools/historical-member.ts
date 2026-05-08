/**
 * MCP tool: get_historical_member
 *
 * Surfaces the legislators_historical collection — every person who has
 * ever served in Congress (1789→present, ~12,230 members). The companion
 * to get_member_profile, which only returns currently-serving legislators.
 *
 * Use cases:
 *   - "Who was the senator from Massachusetts in 1925?" (active_year + state filter)
 *   - "What was Henry Clay's bioguide ID?" (member_name lookup)
 *   - "List every Whig who served in the House" (party + chamber)
 *   - Joining historical congressional_trades records (filed by members who've
 *     since left office — Markwayne Mullin pre-2024 etc.) to full member context
 *
 * Different schema from current legislators (no committee_assignments, no
 * social/contact, no current_term — just the chronological terms[] array
 * and basic biographical fields). The terms array preserves every term
 * served with start/end/chamber/state/party/senate_class for that term.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryLegislatorsHistorical } from "../firestore.js";
import type {
  LegislatorHistorical,
  LegislatorHistoricalQuery,
  ResultEnvelope,
} from "../types.js";

// ─── Tool definition ────────────────────────────────────────────────────────

export const definition: Tool = {
  name: "get_historical_member",
  description: [
    "Returns historical Congressional member records — every person who",
    "has ever served in Congress (1789→present, ~12,230 members). The",
    "companion to get_member_profile, which only returns currently-serving",
    "legislators. Use this when you need to look up a former member, find",
    "members who served during a specific year, or surface biographical",
    "context for old congressional_trades records (filed by members who",
    "have since left office).",
    "",
    "Schema is intentionally lighter than current Legislator: no committee",
    "assignments (those only make sense for current members), no social or",
    "contact blocks, no current_term — just the chronological terms[] array",
    "preserving every term served with start/end/chamber/state/party/",
    "senate_class and basic biographical fields (name, birthday, gender).",
    "",
    "Filter by:",
    "  - bioguide_id for direct lookup (fastest path)",
    "  - member_name for case-insensitive substring search",
    "  - state to find every member who ever represented a state",
    "  - chamber to filter house vs senate (members can have served in both)",
    "  - party to filter by any-term party affiliation (handles party",
    "    switches; Whig/Federalist/etc. covered)",
    "  - active_year, active_since, active_until for date-range filtering",
    "    against the terms array (e.g., active_year=1925 returns every",
    "    member who served any portion of 1925)",
    "",
    "For agents joining trade records to historical members: the",
    "congressional_trades.bioguide_id field can resolve to either current",
    "(get_member_profile) or historical (get_historical_member) depending",
    "on whether the member is still serving — try current first, fall back",
    "to historical if not found.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      bioguide_id: {
        type: "string",
        description:
          "Permanent member identifier — letter + 6 digits (e.g., 'C000482' for Henry Clay, 'L000174' for Patrick Leahy after retirement). Direct doc lookup, fastest path.",
      },
      member_name: {
        type: "string",
        description:
          "Case-insensitive substring against full_name. Example: 'Clay' returns Henry Clay and others.",
      },
      state: {
        type: "string",
        description:
          "2-letter state abbreviation. Returns every member who served from this state during ANY of their terms.",
      },
      chamber: {
        type: "string",
        enum: ["house", "senate"],
        description:
          "Filter to members who served in this chamber during any term. Members who served in both chambers (Senate-then-House or vice versa) match either filter.",
      },
      party: {
        type: "string",
        description:
          "Match against any term's party (handles party switches). Use historical names ('Whig', 'Federalist', 'Democratic-Republican') or current ('Democrat', 'Republican').",
      },
      active_year: {
        type: "integer",
        minimum: 1789,
        maximum: 2100,
        description:
          "Calendar year — returns every member who served any portion of this year. Convenience wrapper around active_since/active_until.",
      },
      active_since: {
        type: "string",
        description:
          "ISO YYYY-MM-DD — return members whose terms array overlaps with this date forward.",
      },
      active_until: {
        type: "string",
        description:
          "ISO YYYY-MM-DD — return members whose terms array overlaps with this date backward.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 1000,
        description:
          "Maximum records to return. Default 50, max 1000. Some date-only queries can match thousands of members; use chamber/state/party to narrow.",
      },
    },
    additionalProperties: false,
  },
};

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handler(
  args: unknown,
): Promise<ResultEnvelope<LegislatorHistorical>> {
  const query = validateAndNormalize(args);
  const { results, has_more } = await queryLegislatorsHistorical(query);
  return {
    results,
    count: results.length,
    has_more,
    query: query as Record<string, unknown>,
  };
}

// ─── Input validation ───────────────────────────────────────────────────────

function validateAndNormalize(raw: unknown): LegislatorHistoricalQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: LegislatorHistoricalQuery = {};

  if (args.bioguide_id !== undefined) {
    if (
      typeof args.bioguide_id !== "string" ||
      !/^[A-Z]\d{6}$/.test(args.bioguide_id)
    ) {
      throw new Error(
        `INVALID_BIOGUIDE_ID: '${String(args.bioguide_id)}' — expected letter + 6 digits (e.g., 'C000482')`,
      );
    }
    out.bioguide_id = args.bioguide_id;
  }

  if (args.member_name !== undefined) {
    if (typeof args.member_name !== "string") {
      throw new Error("member_name must be a string");
    }
    out.member_name = args.member_name;
  }

  if (args.state !== undefined) {
    if (
      typeof args.state !== "string" ||
      !/^[A-Z]{2}$/i.test(args.state)
    ) {
      throw new Error(
        `INVALID_STATE: '${String(args.state)}' — expected 2-letter abbreviation`,
      );
    }
    out.state = args.state.toUpperCase();
  }

  if (args.chamber !== undefined) {
    if (args.chamber !== "house" && args.chamber !== "senate") {
      throw new Error(
        `INVALID chamber: '${String(args.chamber)}' — expected 'house' or 'senate'`,
      );
    }
    out.chamber = args.chamber;
  }

  if (args.party !== undefined) {
    if (typeof args.party !== "string") {
      throw new Error("party must be a string");
    }
    out.party = args.party;
  }

  if (args.active_year !== undefined) {
    if (
      typeof args.active_year !== "number" ||
      !Number.isInteger(args.active_year) ||
      args.active_year < 1789 ||
      args.active_year > 2100
    ) {
      throw new Error(
        `INVALID active_year: '${String(args.active_year)}' — expected integer 1789..2100`,
      );
    }
    out.active_year = args.active_year;
  }

  for (const field of ["active_since", "active_until"] as const) {
    const v = args[field];
    if (v !== undefined) {
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        throw new Error(
          `INVALID ${field}: '${String(v)}' — expected ISO YYYY-MM-DD`,
        );
      }
      out[field] = v;
    }
  }

  if (args.limit !== undefined) {
    if (
      typeof args.limit !== "number" ||
      !Number.isInteger(args.limit) ||
      args.limit < 1 ||
      args.limit > 1000
    ) {
      throw new Error(
        `INVALID limit: '${String(args.limit)}' — expected integer 1..1000`,
      );
    }
    out.limit = args.limit;
  }

  return out;
}
