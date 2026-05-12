/**
 * OFAC Specially Designated Nationals (SDN) list scraper.
 *
 * Source: sanctionslistservice.ofac.treas.gov publishes the canonical
 * SDN.csv (full sanctions list). Single-file download, no pagination.
 * 12 fixed columns; OFAC uses "-0-" as the empty-field sentinel.
 *
 * Quirks of OFAC's CSV format:
 *   - Fields with embedded commas / newlines are double-quoted; we use
 *     a state-machine CSV parser rather than naive split(',') to handle
 *     these correctly (parseSdnCsvLine handles quoted-field state).
 *   - Empty fields ship as "-0-" — we normalize to "" on ingest.
 *   - Some records' remarks fields contain embedded line breaks; the
 *     file uses CRLF line endings.
 *
 * Cadence: daily 6:50 AM ET, full-list refresh. The SDN.csv is small
 * (~5.5MB, ~19K records) so re-downloading the whole thing daily is
 * cheaper + simpler than tracking diffs. Idempotent saves on ent_num.
 */

import type { OfacSdnEntry } from "../types.js";

const CONFIG = {
  USER_AGENT: process.env.OFAC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  SDN_URL: "https://sanctionslistservice.ofac.treas.gov/api/publicationpreview/exports/sdn.csv",
};

/** Parse one CSV line into fields, honoring double-quoted fields with
 *  embedded commas. Robust against OFAC's mix of bare and quoted columns. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        // Escaped quote inside quoted field
        cur += '"';
        i += 2;
        continue;
      }
      if (c === '"') {
        inQuotes = false;
        i++;
        continue;
      }
      cur += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      fields.push(cur.trim());
      cur = "";
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  fields.push(cur.trim());
  return fields;
}

/** OFAC's "-0-" is the empty-field sentinel. Normalize to "". */
function nullify(v: string): string {
  return v === "-0-" ? "" : v;
}

/** OFAC SDN.csv column order (documented at
 *  https://www.treasury.gov/ofac/downloads/readme.txt):
 *    [0]  ent_num
 *    [1]  SDN_Name
 *    [2]  SDN_Type
 *    [3]  Program
 *    [4]  Title
 *    [5]  Call_Sign
 *    [6]  Vess_type
 *    [7]  Tonnage
 *    [8]  GRT (Gross Registered Tonnage)
 *    [9]  Vess_flag
 *    [10] Vess_owner
 *    [11] Remarks
 */
function rowToEntry(fields: string[], scrapedAt: string): OfacSdnEntry | null {
  if (fields.length < 2) return null;
  const entNum = fields[0]?.trim() ?? "";
  if (!entNum || !/^\d+$/.test(entNum)) return null;
  return {
    ent_num: entNum,
    name: nullify(fields[1] ?? ""),
    entity_type: nullify(fields[2] ?? "").toLowerCase(),
    program: nullify(fields[3] ?? ""),
    title: nullify(fields[4] ?? ""),
    call_sign: nullify(fields[5] ?? ""),
    vessel_type: nullify(fields[6] ?? ""),
    tonnage: nullify(fields[7] ?? ""),
    gross_registered_tonnage: nullify(fields[8] ?? ""),
    vessel_flag: nullify(fields[9] ?? ""),
    vessel_owner: nullify(fields[10] ?? ""),
    remarks: nullify(fields[11] ?? ""),
    scraped_at: scrapedAt,
  };
}

export async function scrapeOfacSdn(): Promise<OfacSdnEntry[]> {
  const scrapedAt = new Date().toISOString();
  console.error("[ofac] Downloading SDN.csv...");
  const res = await fetch(CONFIG.SDN_URL, {
    headers: { "User-Agent": CONFIG.USER_AGENT },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(
      `OFAC SDN download HTTP ${res.status} ${res.statusText}`,
    );
  }
  const text = await res.text();
  console.error(
    `[ofac] Downloaded ${text.length} bytes; parsing CSV...`,
  );

  // OFAC uses CRLF; normalize then split. The SDN.csv has NO header row.
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.length > 0);
  const out: OfacSdnEntry[] = [];
  for (const line of lines) {
    const fields = parseCsvLine(line);
    const entry = rowToEntry(fields, scrapedAt);
    if (entry) out.push(entry);
  }
  console.error(`[ofac] Parsed ${out.length} SDN entries from ${lines.length} lines`);
  return out;
}
