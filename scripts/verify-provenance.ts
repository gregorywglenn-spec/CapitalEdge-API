/**
 * Quick verification that the new provenance URL fields populate
 * correctly on fresh scrapes from each affected source.
 */

import { scrapeFecCandidates } from "../src/scrapers/fec.js";
import { scrapeOfacSdn } from "../src/scrapers/ofac-sdn.js";
import { scrapeBioguideCatalog } from "../src/scrapers/bioguide.js";

console.log("\n=== FEC candidates fec_url ===");
const candidates = await scrapeFecCandidates({
  cycle: 2026,
  state: "PA",
  office: "S",
  activeOnly: true,
  maxPages: 1,
});
for (const c of candidates.slice(0, 2)) {
  console.log(`  ${c.candidate_id.padEnd(12)} | ${c.fec_url}`);
}

console.log("\n=== OFAC SDN ofac_url (first 2) ===");
const sdn = await scrapeOfacSdn();
for (const s of sdn.slice(0, 2)) {
  console.log(`  ent_num=${s.ent_num.padEnd(8)} | ${s.ofac_url}`);
}

console.log("\n=== Bioguide legislators bioguide_url (first 2) ===");
const leg = await scrapeBioguideCatalog();
for (const l of leg.slice(0, 2)) {
  console.log(`  ${l.bioguide_id.padEnd(10)} | ${l.full_name.padEnd(28)} | ${l.bioguide_url}`);
}

process.exit(0);
