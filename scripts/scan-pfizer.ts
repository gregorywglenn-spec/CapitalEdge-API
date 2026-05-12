import { getLiveDb } from "../src/firestore.js";

const db = await getLiveDb();
// Scan the entire collection in chunks
const allDocs: any[] = [];
let lastDoc: any = null;
let total = 0;
while (true) {
  let q = db.collection("lobbying_filings").orderBy("dt_posted", "desc").limit(5000);
  if (lastDoc) q = q.startAfter(lastDoc);
  const snap = await q.get();
  if (snap.empty) break;
  total += snap.docs.length;
  for (const d of snap.docs) {
    const data = d.data();
    const client = (data["client_name"] ?? "").toString().toLowerCase();
    if (client.includes("pfizer")) {
      allDocs.push({ client: data["client_name"], registrant: data["registrant_name"], dt: data["dt_posted"] });
    }
  }
  lastDoc = snap.docs[snap.docs.length - 1];
  console.log(`Scanned ${total}, found ${allDocs.length} pfizer matches so far`);
  if (snap.docs.length < 5000) break;
}
console.log(`\nTotal scanned: ${total}, total pfizer matches: ${allDocs.length}`);
for (const m of allDocs.slice(0, 5)) console.log(`  ${m.client} | ${m.registrant} | ${m.dt}`);
process.exit(0);
