import { homedir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";
import { openDb } from "./schema.js";

let _db: ReturnType<typeof openDb> | null = null;

export function db() {
  if (_db) return _db;
  const dir = join(homedir(), ".claume");
  mkdirSync(dir, { recursive: true });
  _db = openDb(join(dir, "memory.db"));
  return _db;
}

export interface Observation {
  id?: number;
  session_id: string | null;
  project: string;
  kind: string;
  title: string;
  body: string;
  created_at: number;
  importance?: number;
}

export function insertObservation(o: Observation, embedding?: Float32Array): number {
  const stmt = db().prepare(`
    INSERT INTO observations (session_id, project, kind, title, body, created_at, importance)
    VALUES (@session_id, @project, @kind, @title, @body, @created_at, @importance)
  `);
  const info = stmt.run({ importance: 3, ...o });
  const id = Number(info.lastInsertRowid);
  if (embedding) {
    const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    db().prepare(`INSERT INTO observations_vec(observation_id, embedding) VALUES (?, ?)`)
      .run(BigInt(id), buf);
  }
  return id;
}

export function linkEntities(obsId: number, entities: { type: string; name: string }[]): void {
  const upsert = db().prepare(`INSERT OR IGNORE INTO entities(type, name) VALUES (?, ?)`);
  const find = db().prepare(`SELECT id FROM entities WHERE type=? AND name=?`);
  const link = db().prepare(`INSERT OR IGNORE INTO observation_entities(observation_id, entity_id) VALUES (?, ?)`);
  const tx = db().transaction((ents: typeof entities) => {
    for (const e of ents) {
      upsert.run(e.type, e.name);
      const row = find.get(e.type, e.name) as { id: number };
      link.run(obsId, row.id);
    }
  });
  tx(entities);
}

export function startSession(id: string, project: string, cwd: string): void {
  db().prepare(`
    INSERT OR REPLACE INTO sessions(id, project, cwd, started_at) VALUES (?, ?, ?, ?)
  `).run(id, project, cwd, Date.now());
}

export function endSession(id: string, summary?: string): void {
  db().prepare(`UPDATE sessions SET ended_at=?, summary=? WHERE id=?`).run(Date.now(), summary ?? null, id);
}
