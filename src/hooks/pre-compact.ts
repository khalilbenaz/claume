#!/usr/bin/env node
import { readHookInput, projectKey } from "./util.js";
import { db, insertObservation } from "../db/index.js";
import { embed } from "../extract/embed.js";

const STALE_DAYS = 30;
const CLUSTER_THRESHOLD = 8;

async function main() {
  const input = await readHookInput();
  const project = projectKey(input.cwd);
  const cutoff = Date.now() - STALE_DAYS * 86400_000;

  const stale = db().prepare(`
    SELECT id, kind, title, body FROM observations
    WHERE project=? AND created_at < ? AND compressed_into IS NULL AND importance < 5
  `).all(project, cutoff) as { id: number; kind: string; title: string; body: string }[];

  if (stale.length < CLUSTER_THRESHOLD) {
    process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const groups = new Map<string, typeof stale>();
  for (const o of stale) {
    const arr = groups.get(o.kind) ?? [];
    arr.push(o);
    groups.set(o.kind, arr);
  }

  for (const [kind, items] of groups) {
    if (items.length < CLUSTER_THRESHOLD) continue;
    const summary = `Compressed ${items.length} ${kind} observations from before ${new Date(cutoff).toISOString().slice(0, 10)}: ${items.slice(0, 12).map((i) => i.title).join("; ")}${items.length > 12 ? ` (+${items.length - 12} more)` : ""}`;
    const body = items.map((i) => `- ${i.title}: ${i.body}`).join("\n").slice(0, 4000);
    const emb = await embed([`${summary}\n${body}`]);
    const newId = insertObservation({
      session_id: null,
      project,
      kind,
      title: `[compressed ×${items.length}] ${kind} pre-${new Date(cutoff).toISOString().slice(0, 10)}`,
      body: `${summary}\n\n${body}`,
      created_at: Date.now(),
      importance: 2,
    }, emb?.[0]);
    const update = db().prepare(`UPDATE observations SET compressed_into=? WHERE id=?`);
    const tx = db().transaction(() => { for (const it of items) update.run(newId, it.id); });
    tx();
  }

  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
}

main().catch((e) => {
  process.stderr.write(`[claude-mem2 pre-compact] ${(e as Error).message}\n`);
  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
});
