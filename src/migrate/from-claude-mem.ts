#!/usr/bin/env node
import Database from "better-sqlite3";
import { homedir } from "os";
import { join } from "path";
import { existsSync } from "fs";
import { db, insertObservation, linkEntities } from "../db/index.js";
import { embed } from "../extract/embed.js";

const SRC = process.argv[2] ?? join(homedir(), ".claude-mem", "claude-mem.db");

const KIND_MAP: Record<string, string> = {
  discovery: "discovery",
  decision: "decision",
  bugfix: "bugfix",
  bug: "bugfix",
  feature: "feature",
  refactor: "refactor",
  change: "change",
  insight: "discovery",
  problem: "discovery",
  solution: "bugfix",
};

function mapKind(t: string | null | undefined): string {
  if (!t) return "discovery";
  const k = t.toLowerCase().trim();
  return KIND_MAP[k] ?? "discovery";
}

function parseJsonArray(s: string | null | undefined): string[] {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; }
}

interface SrcObs {
  id: number;
  memory_session_id: string;
  project: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string | null;
  narrative: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  created_at_epoch: number;
}

interface SrcSession {
  id: number;
  memory_session_id: string;
  project: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  files_read: string | null;
  files_edited: string | null;
  notes: string | null;
  created_at_epoch: number;
}

interface SdkSession {
  memory_session_id: string;
  project: string;
  cwd: string | null;
  started_at_epoch: number;
  ended_at_epoch: number | null;
}

async function main() {
  if (!existsSync(SRC)) { console.error(`Source DB not found: ${SRC}`); process.exit(1); }
  const src = new Database(SRC, { readonly: true });

  const sdkSessionsCols = (src.prepare("PRAGMA table_info(sdk_sessions)").all() as { name: string }[]).map((c) => c.name);
  const startedCol = sdkSessionsCols.includes("started_at_epoch") ? "started_at_epoch" : sdkSessionsCols.includes("created_at_epoch") ? "created_at_epoch" : null;
  const cwdCol = sdkSessionsCols.includes("cwd") ? "cwd" : sdkSessionsCols.includes("working_directory") ? "working_directory" : null;

  if (startedCol) {
    const sessions = src.prepare(`SELECT memory_session_id, project, ${cwdCol ?? "NULL"} as cwd, ${startedCol} as started_at_epoch FROM sdk_sessions`).all() as SdkSession[];
    const ins = db().prepare(`INSERT OR IGNORE INTO sessions(id, project, cwd, started_at) VALUES (?, ?, ?, ?)`);
    const tx = db().transaction(() => { for (const s of sessions) ins.run(s.memory_session_id, s.project, s.cwd, s.started_at_epoch); });
    tx();
    console.log(`Imported ${sessions.length} sessions`);
  }

  const obsRows = src.prepare(`
    SELECT id, memory_session_id, project, type, title, subtitle, facts, narrative, concepts, files_read, files_modified, created_at_epoch
    FROM observations WHERE merged_into_project IS NULL ORDER BY created_at_epoch
  `).all() as SrcObs[];

  console.log(`Migrating ${obsRows.length} observations...`);
  const seenSessions = new Set((db().prepare(`SELECT id FROM sessions`).all() as { id: string }[]).map((r) => r.id));

  let imported = 0, skipped = 0;
  const BATCH = 64;

  for (let i = 0; i < obsRows.length; i += BATCH) {
    const batch = obsRows.slice(i, i + BATCH);
    const texts = batch.map((o) => {
      const facts = parseJsonArray(o.facts);
      const body = [o.subtitle, o.narrative, facts.length ? `Facts: ${facts.join("; ")}` : ""].filter(Boolean).join("\n\n");
      return `${o.title ?? ""}\n${body}`;
    });
    const embeddings = await embed(texts);

    const tx = db().transaction(() => {
      batch.forEach((o, j) => {
        if (!o.title) { skipped++; return; }
        const facts = parseJsonArray(o.facts);
        const concepts = parseJsonArray(o.concepts);
        const filesR = parseJsonArray(o.files_read);
        const filesM = parseJsonArray(o.files_modified);
        const body = [o.subtitle, o.narrative, facts.length ? `Facts: ${facts.join("; ")}` : ""].filter(Boolean).join("\n\n");
        const sessionId = seenSessions.has(o.memory_session_id) ? o.memory_session_id : null;

        const newId = insertObservation({
          session_id: sessionId,
          project: o.project,
          kind: mapKind(o.type),
          title: o.title.slice(0, 200),
          body: body.slice(0, 8000),
          created_at: o.created_at_epoch,
          importance: 3,
        }, embeddings?.[j]);

        const ents = [
          ...filesR.map((n) => ({ type: "file" as const, name: n })),
          ...filesM.map((n) => ({ type: "file" as const, name: n })),
          ...concepts.map((n) => ({ type: "tech" as const, name: n })),
          { type: "project" as const, name: o.project },
        ];
        if (ents.length) linkEntities(newId, ents);
        imported++;
      });
    });
    tx();
    if ((i / BATCH) % 5 === 0) process.stdout.write(`  ${i + batch.length}/${obsRows.length}\r`);
  }
  console.log(`\nObservations: ${imported} imported, ${skipped} skipped`);

  const sumRows = src.prepare(`
    SELECT id, memory_session_id, project, request, investigated, learned, completed, next_steps, files_read, files_edited, notes, created_at_epoch
    FROM session_summaries WHERE merged_into_project IS NULL
  `).all() as SrcSession[];

  console.log(`Migrating ${sumRows.length} session summaries...`);
  let sumImported = 0;
  for (let i = 0; i < sumRows.length; i += BATCH) {
    const batch = sumRows.slice(i, i + BATCH);
    const texts = batch.map((s) => `${s.request ?? "session"}\n${[s.investigated, s.learned, s.completed, s.next_steps, s.notes].filter(Boolean).join("\n\n")}`);
    const embeddings = await embed(texts);

    const tx = db().transaction(() => {
      batch.forEach((s, j) => {
        const body = [
          s.investigated && `Investigated: ${s.investigated}`,
          s.learned && `Learned: ${s.learned}`,
          s.completed && `Completed: ${s.completed}`,
          s.next_steps && `Next: ${s.next_steps}`,
          s.notes && `Notes: ${s.notes}`,
        ].filter(Boolean).join("\n\n");
        const sessionId = seenSessions.has(s.memory_session_id) ? s.memory_session_id : null;
        const newId = insertObservation({
          session_id: sessionId,
          project: s.project,
          kind: "session",
          title: (s.request ?? "session summary").slice(0, 200),
          body: body.slice(0, 8000),
          created_at: s.created_at_epoch,
          importance: 2,
        }, embeddings?.[j]);

        const filesR = parseJsonArray(s.files_read);
        const filesE = parseJsonArray(s.files_edited);
        const ents = [
          ...filesR.map((n) => ({ type: "file" as const, name: n })),
          ...filesE.map((n) => ({ type: "file" as const, name: n })),
          { type: "project" as const, name: s.project },
        ];
        if (ents.length) linkEntities(newId, ents);
        sumImported++;
      });
    });
    tx();
  }
  console.log(`Session summaries: ${sumImported} imported`);

  const stats = db().prepare(`SELECT project, COUNT(*) n FROM observations GROUP BY project ORDER BY n DESC LIMIT 10`).all();
  console.log("\nTop projects:");
  console.table(stats);
}

main().catch((e) => { console.error(e); process.exit(1); });
