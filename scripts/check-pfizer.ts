import { getLiveDb } from "../src/firestore.js";

const db = await getLiveDb();
// Try fetching with substring match on uppercase
const all = await db.collection("lobbying_filings").orderBy("dt_posted", "desc").limit(5000).get();
const docs = all.docs.map(d => d.data());
console.log(`Pulled ${docs.length} most-recent lobbying filings`);
const pfizerMatches = docs.filter(d => {
  const client = (d["client_name"] ?? "").toString().toLowerCase();
  const reg = (d["registrant_name"] ?? "").toString().toLowerCase();
  return client.includes("pfizer") || reg.includes("pfizer");
});
console.log(`Matches for "pfizer": ${pfizerMatches.length}`);
for (const m of pfizerMatches.slice(0, 3)) {
  console.log(`  client_name="${m["client_name"]}", registrant_name="${m["registrant_name"]}", dt_posted="${m["dt_posted"]}"`);
}
// Now try unrestricted (might be large)
console.log(`\nDate range of fetch window:`);
console.log(`  newest: ${docs[0]?.["dt_posted"]}`);
console.log(`  oldest: ${docs[docs.length - 1]?.["dt_posted"]}`);
process.exit(0);
