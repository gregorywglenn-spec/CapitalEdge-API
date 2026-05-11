import { getLiveDb } from "../src/firestore.js";

const db = await getLiveDb();
const snap = await db.collection("otc_market_weekly").count().get();
console.log("otc_market_weekly count:", snap.data().count);
process.exit(0);
