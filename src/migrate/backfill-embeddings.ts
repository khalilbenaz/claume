#!/usr/bin/env node
import { db } from "../db/index.js";
import { embed } from "../extract/embed.js";

const BATCH = 64;

async function main() {
  const missing = db().prepare(`
    SELECT o.id, o.title, o.body FROM observations o
    LEFT JOIN observations_vec v ON v.observation_id = o.id
    WHERE v.observation_id IS NULL
    ORDER BY o.id
  `).all() as { id: number; title: string; body: string }[];

  if (missing.length === 0) { console.log("Nothing to backfill."); return; }
  console.log(`Backfilling embeddings for ${missing.length} observations...`);

  const del = db().prepare(`DELETE FROM observations_vec WHERE observation_id = ?`);
  const insert = db().prepare(`INSERT INTO observations_vec(observation_id, embedding) VALUES (?, ?)`);
  let done = 0, failed = 0;

  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    const texts = batch.map((o) => `${o.title}\n${o.body}`.slice(0, 8000));
    const embs = await embed(texts);
    if (!embs) {
      console.error("No embeddings returned (missing API key?). Aborting.");
      process.exit(1);
    }
    const tx = db().transaction(() => {
      batch.forEach((o, j) => {
        const e = embs[j];
        if (!e || e.length === 0) { failed++; return; }
        const buf = Buffer.from(e.buffer, e.byteOffset, e.byteLength);
        del.run(BigInt(o.id));
        insert.run(BigInt(o.id), buf);
        done++;
      });
    });
    tx();
    process.stdout.write(`  ${i + batch.length}/${missing.length}\r`);
  }
  console.log(`\nDone. ${done} embedded, ${failed} failed.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
