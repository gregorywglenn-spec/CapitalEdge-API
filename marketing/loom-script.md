# KeyVex Loom Demo Script

**Target length:** 4-5 minutes total
**Recording mode:** Screen + voiceover (no camera needed)
**Tool suggestion:** Loom's free tier in screen-only mode, or OBS / ScreenPal / Windows Xbox Game Bar (Win+G).

**Before you hit record — 5-minute pre-flight:**

1. **Test the queries.** Open Claude Desktop, run each query in the Demo section below in the order listed. Confirm each one returns at least one result. If any comes back empty, swap the ticker (LMT → AAPL or NVDA) — the demo logic works for any S&P 500 ticker.
2. **Clean up your screen.** Close other apps. Quit any notification badges. Set Claude Desktop to a fresh conversation. Have the KeyVex landing page open in a browser tab in the background — you'll switch to it at the end.
3. **Resolution.** Record at 1080p (1920×1080). Avoid 4K — file gets too big for Loom's free tier.
4. **Audio.** Built-in laptop mic is fine. Just close the window so you don't pick up traffic. Speak at normal pace — don't rush. Pauses are okay.

You can pause + redo any segment in Loom. Don't try to nail it in one take.

---

## Opening (15-20 sec)

**[ON SCREEN: KeyVex landing page hero. Show for 3 seconds, then switch to Claude Desktop.]**

> "Most financial-data APIs were built for humans clicking buttons. KeyVex was built for AI agents from the ground up.

> I'm going to show you a query that pulls from five separate US public-disclosure sources in one conversation — no stitching, no glue code. Just an agent doing what agents do."

**[ON SCREEN: Switch to Claude Desktop. Fresh empty conversation. Make sure the KeyVex MCP server is visible in the connected-tools list.]**

---

## Demo (3 minutes)

### Step 1: The opening question (~45 sec)

**[Type the question into Claude Desktop slowly enough to be read.]**

> Type: **"Which senators and representatives traded Lockheed Martin stock in the last 90 days? Pull their names and party."**

**[Hit Enter. Claude will start calling `get_congressional_trades`.]**

> "Claude is calling `get_congressional_trades` with a ticker filter and a date range. That's hitting our Firestore-backed warehouse — Senate eFD periodic transaction reports and House Clerk PTRs, both refreshed daily. It's coming back with the actual list."

**[Wait for the response to render. Read aloud the first 2-3 trader names + dates if visible. Don't read the whole list.]**

> "Senator X. Representative Y. Real disclosed trades, with dates and amounts. So far this is what any disclosure API could do."

### Step 2: The chain (~45 sec)

**[Type the next message into Claude Desktop.]**

> Type: **"Of those traders, who sits on the House Armed Services Committee or Senate Armed Services?"**

> "Now Claude is going to do something interesting. It already has the bioguide IDs from the first response. It's calling `get_member_profile` with `committee_id: HSAS` for House Armed Services and `SSAS` for the Senate side."

**[Wait for response. The interesting thing here is the intersection — which traders ALSO sit on the defense committees.]**

> "The answer is: [READ ALOUD any matches that appear, or say "none in this window" if empty]. Two tools, one conversation, no API gymnastics."

### Step 3: Follow the money (~60 sec)

**[Type the next message.]**

> Type: **"How much did Lockheed Martin spend on lobbying in 2025, and which agencies did they contact?"**

> "Third tool: `get_lobbying_filings`. Pulling Lockheed's LDA quarterly filings — that's the official Lobbying Disclosure Act registry. The agent gets total spend, the lobbyists involved, and which government entities Lockheed lobbied."

**[Wait for response. Read aloud the headline number if visible — total annual spend, big agency names.]**

> "Million-dollar lobbying spend across DoD, FAA, State. Now Claude has trades, committee context, AND lobbying spend — and it's still in the same conversation."

### Step 4: The kicker (~45 sec)

**[Type the next message.]**

> Type: **"And what federal contracts did Lockheed Martin receive in that same period?"**

> "Fourth tool: `get_federal_contracts`. Hitting USAspending.gov data — every federal contract Lockheed received with award dates, amounts, and contracting agencies."

**[Wait for response. Read aloud one striking contract — biggest $$$, or a notable agency.]**

> "So in one chat we've gone from a stock trade, to the committee a trader sits on, to the lobbying that company did, to the federal contracts they received — across four official US government data sources, joined by ticker name, bioguide ID, and recipient name. No competitor MCP server exposes this combined surface."

### Step 5: The integration story (~30 sec)

**[Switch to a terminal or text editor. Show a one-liner curl example.]**

> "And this is the entire setup. One Bearer token, one endpoint."

**[Show on screen:]**
```bash
curl -X POST https://mcp.keyvex.com \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"get_congressional_trades",
       "arguments":{"ticker":"NVDA","limit":10}}}'
```

> "21 tools, all behind one endpoint. Works from Claude, Cursor, or any MCP-compatible client. Auto-renewing TLS. 5,000 free calls per month."

---

## Close (20-30 sec)

**[ON SCREEN: Switch back to the KeyVex landing page at keyvex.com.]**

> "KeyVex covers 22+ US public-disclosure sources — every official filing the SEC, Congress, Treasury, and the Federal Register publish. Refreshed continuously by autonomous schedulers. No human in the loop.

> If you're building an AI agent that reasons over US financial data, we'd love for you to try it. Free preview access available now — `keyvex.com`. Thanks for watching."

**[Stop recording.]**

---

## Notes + tips

- **If you forget a line:** stop, take a breath, restart from the previous on-screen action. Loom won't care; you can trim later.
- **If a query returns empty:** swap the company. AAPL, NVDA, MSFT, BA (Boeing — another defense contractor that also works for the Armed Services angle), or KO (Coca-Cola, broader trader interest) all have rich data.
- **If you want to shorten:** drop Step 4 (federal contracts). Steps 1-3 alone are a strong 3-minute demo.
- **If you want to lengthen:** add an `include_baseline:true` example on `get_insider_transactions` to show the Form 3 + Form 4 combined call. That's a unique feature.
- **Don't read every line of every response aloud.** Pick the 1-2 most striking facts. The viewer can pause and read the screen.
- **Don't apologize for anything.** ("Sorry, let me find the right query...") If something goes wrong, just pause and re-do that segment.

---

## Asset checklist before recording

- [ ] KeyVex MCP server registered in Claude Desktop's `claude_desktop_config.json` (remote, with Bearer token)
- [ ] Bearer token works (test with one quick query before hitting record)
- [ ] `keyvex.com` landing page open in a browser tab
- [ ] Terminal app open with the curl example pre-pasted (don't type it during the demo)
- [ ] Notifications silenced (Windows Focus Assist on, or system-level Do Not Disturb)
- [ ] At least 5 GB free disk space (Loom records locally before uploading)

---

## After recording

1. Watch it once at 1.5× speed. If anything makes you cringe, trim that segment in Loom (the web editor has a "trim" tool).
2. Add a clickable CTA at the end pointing to `keyvex.com` — Loom supports this in the post-recording settings.
3. Set the Loom title: `KeyVex — MCP server for US public financial disclosures (4-min demo)`
4. Set the thumbnail to a frame showing the chained-tool conversation in Claude Desktop.
5. Share the Loom link in: the Anthropic MCP registry submission, Show HN post, Twitter thread, DM list.

Good luck. You'll do fine.
