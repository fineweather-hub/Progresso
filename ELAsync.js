#!/usr/bin/env node
// sync.js — Fetches all 3 Notion DBs and writes public/data.json
// Run locally:  NOTION_TOKEN=secret_xxx node sync.js
// Run via CI:   GitHub Actions injects NOTION_TOKEN from repo secrets

const token = process.env.NOTION_TOKEN;
if (!token) { console.error("NOTION_TOKEN not set"); process.exit(1); }

const DB_STANDARDS  = "32a7d181fab4803c991ce8cdebaa62ac";
const DB_LC         = "32a7d181fab480f3bff1c8e747080035";
const DB_SKILLS     = "32a7d181fab480358906f1008f1e8e8b";

const headers = {
  "Authorization": `Bearer ${token}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json",
};

async function queryDB(dbId, filter = null) {
  const rows = [];
  let cursor = undefined;
  do {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (cursor)  body.start_cursor = cursor;
    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST", headers, body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Notion API error ${res.status}: ${err}`);
    }
    const data = await res.json();
    rows.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return rows;
}

function text(prop)   { return prop?.rich_text?.map(r => r.plain_text).join("") ?? ""; }
function title(prop)  { return prop?.title?.map(r => r.plain_text).join("") ?? ""; }
function select(prop) { return prop?.select?.name ?? ""; }
function rel(prop)    { return (prop?.relation ?? []).map(r => r.id); }

async function main() {
  console.log("Querying Notion databases...");

  // Exclude Deferred from standards and LCs
  const deferredFilter = {
    property: "Status",
    select: { does_not_equal: "Deferred" },
  };

  const [stdRows, lcRows, skillRows] = await Promise.all([
    queryDB(DB_STANDARDS, deferredFilter),
    queryDB(DB_LC, deferredFilter),
    queryDB(DB_SKILLS),  // include all skills
  ]);

  console.log(`  Standards: ${stdRows.length}, LCs: ${lcRows.length}, Skills: ${skillRows.length}`);

  // Build skill lookup by Notion page ID
  const skillById = {};
  for (const row of skillRows) {
    const p = row.properties;
    const permacode = text(p["Permacode"]);
    skillById[row.id] = {
      id:        row.id,
      name:      title(p["Skill Name"]),
      permacode,
      url:       permacode ? `https://www.ixl.com/search?q=${permacode}` : "",
      status:    select(p["Status"]) || "Not started",
    };
  }

  // Build LC lookup by Notion page ID
  const lcById = {};
  for (const row of lcRows) {
    const p = row.properties;
    lcById[row.id] = {
      id:          row.id,
      text:        title(p["LC Text"]),
      shortTitle:  text(p["Component Short Title"]),
      code:        text(p["Component Code (text)"]),
      status:      select(p["Status"]) || "Not started",
      skillIds:    rel(p["IXL Skills ELA"]),
    };
  }

  // Attach skills to LCs
  for (const lc of Object.values(lcById)) {
    lc.skills = lc.skillIds
      .map(id => skillById[id])
      .filter(Boolean);
    delete lc.skillIds;
  }

  // Build standards with nested LCs
  const standards = stdRows.map(row => {
    const p = row.properties;
    const lcIds = rel(p["Learning Components"]);
    return {
      id:           row.id,
      code:         title(p["Standard Code"]),
      domain:       select(p["Domain"]),
      status:       select(p["Status"]) || "Not started",
      shortTitle:   text(p["Short Title"]),
      plainLanguage: text(p["Plain Language"]).replace(/<br\s*\/?>/gi, " ").trim(),
      lcs: lcIds
        .map(id => lcById[id])
        .filter(lc => lc && lc.status !== "Deferred"),
    };
  });

  // Sort: by domain order, then by code
  const DOMAIN_ORDER = ["RL","RI","W","SL","L"];
  standards.sort((a, b) => {
    const di = DOMAIN_ORDER.indexOf(a.domain) - DOMAIN_ORDER.indexOf(b.domain);
    if (di !== 0) return di;
    return a.code.localeCompare(b.code);
  });

  const output = {
    synced: new Date().toISOString(),
    standards,
  };

  // Write to public/data.json (create dir if needed)
  const fs = await import("fs");
  const path = await import("path");
  const outDir = path.join(process.cwd(), "public");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "data.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`✓ Wrote ${standards.length} standards to public/data.json`);

  // Summary
  const allSkills = standards.flatMap(s => s.lcs.flatMap(lc => lc.skills));
  const practiced = allSkills.filter(s => s.status === "Practiced").length;
  const allLCs = standards.flatMap(s => s.lcs);
  const lcDone = allLCs.filter(lc => lc.status === "Done").length;
  console.log(`  ${practiced}/${allSkills.length} skills practiced, ${lcDone}/${allLCs.length} LCs done`);
}

main().catch(e => { console.error(e); process.exit(1); });
