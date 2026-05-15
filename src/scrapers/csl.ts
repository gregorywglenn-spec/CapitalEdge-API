/**
 * Consolidated Screening List scraper.
 *
 * Source: api.trade.gov bulk static file — the daily-updated full CSL as
 * one JSON document. This is the key-free path: the live CSL search API
 * requires an ITA Developer Portal subscription key, but the bulk static
 * file at `/static/consolidated_screening_list/consolidated.json` does not.
 *
 * The CSL unifies twelve export-screening lists from Commerce (BIS), State,
 * and Treasury (OFAC) into one feed. ~25K entries.
 *
 * No auth, no pagination — one fetch of the whole file. Wrapped in
 * retry-with-backoff for resilience.
 */
import type { ScreeningListEntry } from "../types.js";

const CONFIG = {
  USER_AGENT:
    process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  BULK_URL:
    "https://api.trade.gov/static/consolidated_screening_list/consolidated.json",
  MAX_RETRIES: 4,
} as const;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface RawCslAddress {
  address?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
}
interface RawCslId {
  type?: string | null;
  number?: string | null;
}
interface RawCslEntry {
  id?: string;
  entity_number?: string | null;
  name?: string;
  alt_names?: string[] | null;
  type?: string | null;
  source?: string;
  programs?: string[] | null;
  remarks?: string | null;
  addresses?: RawCslAddress[] | null;
  ids?: RawCslId[] | null;
  title?: string | null;
  nationalities?: string[] | null;
  source_list_url?: string;
  source_information_url?: string;
}

/** Extract the short list code from a CSL `source` string —
 *  "Entity List (EL) - Bureau of Industry and Security" → "EL".
 *  "Non-SDN Menu-Based Sanctions List (NS-MBS List) - Treasury" → "MBS". */
function sourceShort(source: string): string {
  const m = /\(([^)]+)\)/.exec(source);
  if (!m || !m[1]) return "OTHER";
  // Take the first token of the parenthetical, strip non-alphanumerics.
  const code = m[1].trim().split(/\s+/)[0]!.replace(/[^A-Za-z0-9-]/g, "");
  // Normalize the menu-based-sanctions code.
  if (/MBS/i.test(code)) return "MBS";
  return code.toUpperCase();
}

/** Firestore doc-IDs can't contain '/'. Sanitize the raw id. */
function sanitize(s: string): string {
  return s.replace(/[/\\#?]/g, "_");
}

async function fetchBulk(): Promise<RawCslEntry[]> {
  for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(CONFIG.BULK_URL, {
        headers: {
          "User-Agent": CONFIG.USER_AGENT,
          Accept: "application/json",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { results?: RawCslEntry[] };
      return data.results ?? [];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt === CONFIG.MAX_RETRIES) {
        throw new Error(`CSL bulk fetch failed after ${attempt} tries — ${msg}`);
      }
      await sleep(2000 * 2 ** (attempt - 1));
    }
  }
  return [];
}

export async function scrapeConsolidatedScreeningList(): Promise<
  ScreeningListEntry[]
> {
  const scrapedAt = new Date().toISOString();
  console.error("[csl] fetching consolidated screening list bulk file...");
  const raw = await fetchBulk();
  console.error(`[csl] ${raw.length} raw entries`);

  const out: ScreeningListEntry[] = [];
  let idx = 0;
  for (const e of raw) {
    idx++;
    const source = e.source ?? "";
    const short = sourceShort(source);
    // Some entries lack a clean id — fall back to a positional id.
    const rawId = (e.id ?? e.entity_number ?? `idx${idx}`).toString();
    const addresses = (e.addresses ?? []).map((a) => ({
      address: a.address ?? null,
      city: a.city ?? null,
      state: a.state ?? null,
      postal_code: a.postal_code ?? null,
      country: a.country ?? null,
    }));
    const countries = [
      ...new Set(
        addresses
          .map((a) => a.country)
          .filter((c): c is string => !!c)
          .map((c) => c.toUpperCase()),
      ),
    ];
    out.push({
      id: `csl-${short}-${sanitize(rawId)}`,
      source_id: rawId,
      entity_number: e.entity_number ?? null,
      name: e.name ?? "",
      alt_names: Array.isArray(e.alt_names) ? e.alt_names : [],
      type: e.type ?? null,
      source,
      source_short: short,
      programs: Array.isArray(e.programs) ? e.programs : [],
      remarks: e.remarks ?? null,
      countries,
      addresses,
      ids: (e.ids ?? []).map((i) => ({
        type: i.type ?? null,
        number: i.number ?? null,
      })),
      title: e.title ?? null,
      nationalities: Array.isArray(e.nationalities) ? e.nationalities : [],
      source_list_url: e.source_list_url ?? "",
      source_information_url: e.source_information_url ?? "",
      scraped_at: scrapedAt,
    });
  }

  const bySource = new Map<string, number>();
  for (const r of out) {
    bySource.set(r.source_short, (bySource.get(r.source_short) ?? 0) + 1);
  }
  console.error(
    `[csl] TOTAL: ${out.length} entries — ${[...bySource.entries()]
      .map(([s, n]) => `${s}:${n}`)
      .join(" ")}`,
  );
  return out;
}
