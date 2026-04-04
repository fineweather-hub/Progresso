#!/usr/bin/env node
// MathSync.js — Fetches all 3 Notion DBs and writes public/math-data.json
// Run locally:  NOTION_TOKEN=secret_xxx node MathSync.js
// Run via CI:   GitHub Actions injects NOTION_TOKEN from repo secrets

const token = process.env.NOTION_TOKEN;
if (!token) { console.error("NOTION_TOKEN not set"); process.exit(1); }

// All three DBs are shared between ELA and Math — subject filter targets the right rows
const DB_STANDARDS = "32a7d181fab4803c991ce8cdebaa62ac";
const DB_LC        = "32a7d181fab480f3bff1c8e747080035";
const DB_SKILLS    = "32a7d181fab480358906f1008f1e8e8b";

const SUBJECT = "Math"; // filter value

const headers = {
  "Authorization": `Bearer ${token}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json",
};

// Compound filter: subject = Math AND status != Deferred AND status is not empty
function makeFilter(subjectProp, statusProp) {
  return {
    and: [
      { property: subjectProp, select: { equals: SUBJECT } },
      { property: statusProp,  select: { does_not_equal: "Deferred" } },
      { property: statusProp,  select: { is_not_empty: true } },
    ],
  };
}

// Skills only need subject + deferred filter
function makeSkillFilter() {
  return {
    and: [
      { property: "Subject", select: { equals: SUBJECT } },
      { property: "Status",  select: { does_not_equal: "Deferred" } },
      { property: "Status",  select: { is_not_empty: true } },
    ],
  };
}

async function queryDB(dbId, filter) {
  const rows = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;
    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST", headers, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Notion API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    rows.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return rows;
}

const text   = p => p?.rich_text?.map(r => r.plain_text).join("") ?? "";
const title  = p => p?.title?.map(r => r.plain_text).join("") ?? "";
const select = p => p?.select?.name ?? "";
const rel    = p => (p?.relation ?? []).map(r => r.id);

async function main() {
  console.log(`Querying Notion databases (subject: ${SUBJECT})…`);

  const stdFilter = makeFilter("Subject", "Status");
  const lcFilter  = makeFilter("Subject", "Status");
  const skFilter  = makeSkillFilter();

  const [stdRows, lcRows, skillRows] = await Promise.all([
    queryDB(DB_STANDARDS, stdFilter),
    queryDB(DB_LC,        lcFilter),
    queryDB(DB_SKILLS,    skFilter),
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
      skillTitle: text(p["Skill Title"]),
      permacode,
      url:       permacode ? `https://www.ixl.com/search?q=${permacode}` : "",
      status:    select(p["Status"]) || "Not started",
      subject:   select(p["Subject"]),
    };
  }

  // Build LC lookup by Notion page ID
  const lcById = {};
  for (const row of lcRows) {
    const p = row.properties;
    lcById[row.id] = {
      id:         row.id,
      text:       title(p["LC Text"]),
      shortTitle: text(p["Component Short Title"]),
      code:       text(p["Component Code (text)"]),
      status:     select(p["Status"]) || "Not started",
      subject:    select(p["Subject"]),
      skillIds:   rel(p["IXL Skills"]),
    };
  }

  // Attach skills to LCs (only include skills that passed the filter)
  for (const lc of Object.values(lcById)) {
    lc.skills = lc.skillIds.map(id => skillById[id]).filter(Boolean);
    delete lc.skillIds;
  }

  // Build standards with nested LCs
  const standards = stdRows.map(row => {
    const p = row.properties;
    return {
      id:            row.id,
      code:          title(p["Standard Code"]),
      domain:        select(p["Domain"]),
      status:        select(p["Status"]) || "Not started",
      subject:       select(p["Subject"]),
      shortTitle:    text(p["Short Title"]),
      plainLanguage: text(p["Plain Language"]).replace(/<br\s*\/?>/gi, " ").trim(),
      lcs: rel(p["Learning Components"])
        .map(id => lcById[id])
        .filter(Boolean),
    };
  });

  // Sort: domain order (Math strands), then by code
  const DOMAIN_ORDER = ["RP", "NS", "EE", "G", "SP"];
  standards.sort((a, b) => {
    const di = DOMAIN_ORDER.indexOf(a.domain) - DOMAIN_ORDER.indexOf(b.domain);
    return di !== 0 ? di : a.code.localeCompare(b.code);
  });

  // Mark duplicate skills within each standard
  for (const std of standards) {
    const seenInStd = new Set();
    for (const lc of std.lcs) {
      for (const sk of lc.skills) {
        sk.isDupe = seenInStd.has(sk.id);
        seenInStd.add(sk.id);
      }
    }
  }

  const output = { synced: new Date().toISOString(), subject: SUBJECT, standards };

  const fs   = await import("fs");
  const path = await import("path");
  const outDir  = path.join(process.cwd(), "public");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "math-data.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  // Summary stats (deduplicated)
  const allSkills      = standards.flatMap(s => s.lcs.flatMap(lc => lc.skills));
  const uniqueSkills   = allSkills.filter(s => !s.isDupe);
  const practicedUniq  = uniqueSkills.filter(s => s.status === "Practiced").length;
  const assignedUniq   = uniqueSkills.filter(s => s.status === "Assigned").length;
  const notStartedUniq = uniqueSkills.filter(s => s.status === "Not started").length;
  const allLCs         = standards.flatMap(s => s.lcs);
  const lcDone         = allLCs.filter(lc => lc.status === "Done").length;
  const lcInProg       = allLCs.filter(lc => lc.status === "In progress").length;
  const stdMastered    = standards.filter(s => s.status === "Mastered").length;
  const stdInProg      = standards.filter(s => s.status === "In progress").length;

  console.log(`✓ Wrote ${standards.length} standards to public/math-data.json`);
  console.log(`  Standards: ${stdMastered} mastered, ${stdInProg} in progress, ${standards.length - stdMastered - stdInProg} not started`);
  console.log(`  LCs: ${lcDone} done, ${lcInProg} in progress, ${allLCs.length - lcDone - lcInProg} not started`);
  console.log(`  Skills (unique): ${practicedUniq} practiced, ${assignedUniq} assigned, ${notStartedUniq} not started of ${uniqueSkills.length} total`);
}

main().catch(e => { console.error(e); process.exit(1); });
