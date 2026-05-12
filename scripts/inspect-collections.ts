import { getLiveDb } from "../src/firestore.js";

const db = await getLiveDb();
const collections = [
  "lobbying_filings",
  "nport_filings",
  "registration_statements",
  "federal_register_documents",
];

for (const col of collections) {
  const snap = await db.collection(col).count().get();
  const count = snap.data().count;
  console.log(`\n${col}: ${count} docs`);
  if (count > 0) {
    const sample = await db.collection(col).limit(2).get();
    for (const doc of sample.docs) {
      const d = doc.data();
      const summary =
        d["client_name"] ||
        d["filer_name"] ||
        d["title"] ||
        d["registrant_name"] ||
        doc.id;
      console.log(`  sample: ${doc.id} — ${String(summary).slice(0, 80)}`);
    }
  }
}
process.exit(0);
