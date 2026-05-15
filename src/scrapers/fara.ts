/**
 * FARA scraper — Foreign Agents Registration Act registrations.
 *
 * Source: efile.fara.gov FARA API (DOJ National Security Division).
 * No auth. Rate limit: 5 requests / 10 seconds.
 *
 * Endpoint reality (verified 2026-05-15 — captured as a Hard Lesson):
 *   - `/api/v1/Registrants/json/Active`        WORKS — the registrant list.
 *   - `/api/v1/ForeignPrincipals/json/Active`  BROKEN — the *list* form
 *     returns FARA's public CMS HTML instead of API JSON.
 *   - `/api/v1/ForeignPrincipals/json/Active/{regNumber}`  WORKS — the
 *     *per-registrant* form returns that registrant's foreign principals.
 * So the scraper pulls the registrant list, then queries each registration
 * number individually for its foreign principals.
 *
 * The host is genuinely flaky — intermittent 500s, connection resets, SSL
 * errors, and (the routing glitch) the CMS HTML served in place of JSON.
 * Every request goes through fetchJson() with retry-with-backoff that also
 * treats an HTML body as a retryable failure.
 *
 * Pairs with get_lobbying_filings (domestic lobbying), get_fec_contributions,
 * and get_congressional_trades — the foreign-influence corner of the
 * political-disclosure surface.
 */
import type { ForeignAgent } from "../types.js";

const CONFIG = {
  USER_AGENT:
    process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  API_URL: "https://efile.fara.gov/api/v1",
  /** 5 req / 10 s → 1 per 2 s. Pace at 2.2 s for headroom. */
  RATE_LIMIT_MS: 2200,
  MAX_RETRIES: 5,
} as const;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET a FARA API URL and parse JSON, with retry-with-backoff. Treats three
 * things as retryable: network failure, HTTP 5xx, and an HTML response body
 * (the FARA routing glitch serves the CMS site instead of API JSON). Returns
 * null after exhausting retries — callers skip-and-continue.
 */
async function fetchJson(url: string): Promise<unknown | null> {
  for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
    await sleep(CONFIG.RATE_LIMIT_MS);
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": CONFIG.USER_AGENT,
          Accept: "application/json",
        },
      });
      if (res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (res.status === 404) {
        // Genuine not-found (or routing miss) — body is the CMS HTML.
        return null;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const text = await res.text();
      const trimmed = text.trimStart();
      if (trimmed.startsWith("<")) {
        // CMS HTML served in place of JSON — the routing glitch. Retry.
        throw new Error("HTML body (routing glitch)");
      }
      if (!trimmed) {
        // Empty body — also a transient symptom on this host.
        throw new Error("empty body");
      }
      return JSON.parse(trimmed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt === CONFIG.MAX_RETRIES) {
        console.error(`[fara] give up after ${attempt} tries — ${url} — ${msg}`);
        return null;
      }
      // Exponential backoff: 2s, 4s, 8s, 16s.
      await sleep(2000 * 2 ** (attempt - 1));
    }
  }
  return null;
}

/** FARA Registrants dates are MM/DD/YYYY; foreign-principal dates are ISO
 *  with a time component. Normalize both to YYYY-MM-DD. */
function toIsoDate(raw: string | undefined | null): string {
  if (!raw) return "";
  const s = String(raw).trim();
  // ISO-ish: "2026-05-11T00:00:00" or "2026-05-11"
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  // MM/DD/YYYY
  const usMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (usMatch) {
    return `${usMatch[3]}-${usMatch[1]!.padStart(2, "0")}-${usMatch[2]!.padStart(2, "0")}`;
  }
  return "";
}

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

interface RegistrantRow {
  Registration_Number?: number | string;
  Registration_Date?: string;
  Name?: string;
  Address_1?: string;
  City?: string;
  State?: string;
  Zip?: string;
}

interface ForeignPrincipalRow {
  REG_NUMBER?: number | string;
  REGISTRANT_NAME?: string;
  REG_DATE?: string;
  FP_NAME?: string;
  FP_REG_DATE?: string;
  COUNTRY_NAME?: string;
  ADDRESS_1?: string;
  ADDRESS_2?: string;
  CITY?: string;
  STATE?: string;
  ZIP?: string;
}

/** FARA eFile quick-search deep link for a registration number. */
function registrantUrl(regNumber: string): string {
  return `https://efile.fara.gov/ords/fara/f?p=1235:200:::NO:RP,200:P200_REG_NUMBER:${encodeURIComponent(regNumber)}`;
}

export interface ScrapeFaraOptions {
  /** Cap the number of registrants processed — for testing. Default: all. */
  maxRegistrants?: number;
}

/**
 * Pull the active FARA registrant list, then query each registration
 * number's foreign principals. Emits one ForeignAgent record per
 * (registrant, foreign principal) pair; registrants with no active foreign
 * principal get a single has_foreign_principal:false record.
 */
export async function scrapeFara(
  options: ScrapeFaraOptions = {},
): Promise<ForeignAgent[]> {
  const scrapedAt = new Date().toISOString();

  console.error("[fara] fetching active registrant list...");
  const registrantsResp = await fetchJson(
    `${CONFIG.API_URL}/Registrants/json/Active`,
  );
  if (!registrantsResp) {
    throw new Error(
      "FARA Registrants endpoint unreachable after retries — aborting.",
    );
  }
  // Shape: { REGISTRANTS_ACTIVE: { ROW: [ ... ] } }
  const regRowsRaw = (
    registrantsResp as { REGISTRANTS_ACTIVE?: { ROW?: unknown } }
  )?.REGISTRANTS_ACTIVE?.ROW;
  const registrants: RegistrantRow[] = Array.isArray(regRowsRaw)
    ? (regRowsRaw as RegistrantRow[])
    : regRowsRaw
      ? [regRowsRaw as RegistrantRow]
      : [];

  let toProcess = registrants;
  if (options.maxRegistrants && options.maxRegistrants < registrants.length) {
    toProcess = registrants.slice(0, options.maxRegistrants);
  }
  console.error(
    `[fara] ${registrants.length} active registrants; processing ${toProcess.length}`,
  );

  const out: ForeignAgent[] = [];
  let i = 0;
  for (const reg of toProcess) {
    i++;
    const regNumber = str(reg.Registration_Number);
    if (!regNumber) continue;
    const registrantName = str(reg.Name);
    const registrationDate = toIsoDate(reg.Registration_Date);

    const fpResp = await fetchJson(
      `${CONFIG.API_URL}/ForeignPrincipals/json/Active/${encodeURIComponent(regNumber)}`,
    );
    // Shape: { ROWSET: { ROW: obj | [obj,...] } }  — or null / empty.
    const fpRowsRaw = (fpResp as { ROWSET?: { ROW?: unknown } } | null)
      ?.ROWSET?.ROW;
    const fpRows: ForeignPrincipalRow[] = Array.isArray(fpRowsRaw)
      ? (fpRowsRaw as ForeignPrincipalRow[])
      : fpRowsRaw
        ? [fpRowsRaw as ForeignPrincipalRow]
        : [];

    const base = {
      registration_number: regNumber,
      registrant_name: registrantName,
      registration_date: registrationDate,
      registrant_address: str(reg.Address_1) || null,
      registrant_city: str(reg.City) || null,
      registrant_state: str(reg.State) || null,
      registrant_zip: str(reg.Zip) || null,
      status: "active",
      source_url: registrantUrl(regNumber),
      scraped_at: scrapedAt,
    };

    if (fpRows.length === 0) {
      out.push({
        id: `fara-${regNumber}-none`,
        ...base,
        has_foreign_principal: false,
        foreign_principal_name: null,
        foreign_principal_country: null,
        foreign_principal_reg_date: null,
        foreign_principal_address: null,
        foreign_principal_city: null,
        foreign_principal_state: null,
      });
    } else {
      let fpIdx = 0;
      for (const fp of fpRows) {
        out.push({
          id: `fara-${regNumber}-${fpIdx}`,
          ...base,
          has_foreign_principal: true,
          foreign_principal_name: str(fp.FP_NAME) || null,
          foreign_principal_country: str(fp.COUNTRY_NAME).toUpperCase() || null,
          foreign_principal_reg_date: toIsoDate(fp.FP_REG_DATE) || null,
          foreign_principal_address: str(fp.ADDRESS_1) || null,
          foreign_principal_city: str(fp.CITY) || null,
          foreign_principal_state: str(fp.STATE) || null,
        });
        fpIdx++;
      }
    }

    if (i % 50 === 0 || i === toProcess.length) {
      console.error(
        `[fara] ${i}/${toProcess.length} registrants, ${out.length} records`,
      );
    }
  }

  console.error(
    `[fara] TOTAL: ${out.length} records (${out.filter((r) => r.has_foreign_principal).length} with a foreign principal)`,
  );
  return out;
}
