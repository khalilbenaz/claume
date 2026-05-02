#!/usr/bin/env node
import { db } from "../dist/db/index.js";
import { search, recentByProject } from "../dist/search/search.js";

const cmd = process.argv[2];
const arg = process.argv.slice(3).join(" ");

switch (cmd) {
  case "search": {
    const hits = await search(arg, { limit: 15, expandGraph: true });
    for (const h of hits) {
      console.log(`#${h.id} [${new Date(h.created_at).toISOString().slice(0,10)}] ${h.kind} (${h.source.join("+")}): ${h.title}`);
      console.log(`  ${h.body}\n`);
    }
    break;
  }
  case "recent": {
    const project = arg || process.cwd();
    const hits = recentByProject(project, 30);
    for (const h of hits) {
      console.log(`#${h.id} [${new Date(h.created_at).toISOString().slice(0,10)}] ${h.kind}: ${h.title}`);
    }
    break;
  }
  case "stats": {
    const r = db().prepare(`SELECT project, COUNT(*) as n FROM observations GROUP BY project ORDER BY n DESC`).all();
    console.table(r);
    break;
  }
  default:
    console.log("Usage: claume <search|recent|stats> [args]");
}
