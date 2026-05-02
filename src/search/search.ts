import { db } from "../db/index.js";
import { embedOne } from "../extract/embed.js";

export interface SearchHit {
  id: number;
  project: string;
  kind: string;
  title: string;
  body: string;
  created_at: number;
  importance: number;
  score: number;
  source: ("fts" | "vec" | "graph")[];
}

export interface SearchOptions {
  limit?: number;
  project?: string;
  kinds?: string[];
  since?: number;
  expandGraph?: boolean;
}

const RRF_K = 60;

export async function search(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
  const limit = opts.limit ?? 20;
  const overFetch = limit * 4;

  const ftsHits = ftsSearch(query, overFetch, opts);
  const vecHits = await vecSearch(query, overFetch, opts);

  const fused = new Map<number, SearchHit>();
  rrf(ftsHits, "fts", fused);
  rrf(vecHits, "vec", fused);

  let out = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);

  if (opts.expandGraph && out.length > 0) {
    out = expandViaGraph(out, limit);
  }
  return out;
}

function rrf(ids: number[], src: "fts" | "vec", acc: Map<number, SearchHit>): void {
  ids.forEach((id, rank) => {
    const score = 1 / (RRF_K + rank + 1);
    const existing = acc.get(id);
    if (existing) {
      existing.score += score;
      if (!existing.source.includes(src)) existing.source.push(src);
    } else {
      const row = db().prepare(`SELECT id, project, kind, title, body, created_at, importance FROM observations WHERE id=?`).get(id) as Omit<SearchHit, "score" | "source"> | undefined;
      if (row) acc.set(id, { ...row, score, source: [src] });
    }
  });
}

function ftsSearch(q: string, limit: number, opts: SearchOptions): number[] {
  const tokens = q.split(/\s+/).filter((t) => t.length >= 2).map((t) => `${t.replace(/["*']/g, "")}*`).join(" OR ");
  if (!tokens) return [];
  const where: string[] = [];
  const params: unknown[] = [tokens];
  if (opts.project) { where.push("o.project = ?"); params.push(opts.project); }
  if (opts.kinds?.length) { where.push(`o.kind IN (${opts.kinds.map(() => "?").join(",")})`); params.push(...opts.kinds); }
  if (opts.since) { where.push("o.created_at >= ?"); params.push(opts.since); }
  const sql = `
    SELECT o.id FROM observations_fts fts
    JOIN observations o ON o.id = fts.rowid
    WHERE observations_fts MATCH ? ${where.length ? "AND " + where.join(" AND ") : ""}
    ORDER BY rank LIMIT ?`;
  params.push(limit);
  try {
    return (db().prepare(sql).all(...params) as { id: number }[]).map((r) => r.id);
  } catch {
    return [];
  }
}

async function vecSearch(q: string, limit: number, opts: SearchOptions): Promise<number[]> {
  const emb = await embedOne(q);
  if (!emb) return [];
  const where: string[] = [];
  const params: unknown[] = [Buffer.from(emb.buffer), limit * 3];
  if (opts.project) { where.push("o.project = ?"); params.push(opts.project); }
  if (opts.kinds?.length) { where.push(`o.kind IN (${opts.kinds.map(() => "?").join(",")})`); params.push(...opts.kinds); }
  if (opts.since) { where.push("o.created_at >= ?"); params.push(opts.since); }
  const sql = `
    SELECT v.observation_id AS id FROM observations_vec v
    JOIN observations o ON o.id = v.observation_id
    WHERE v.embedding MATCH ? AND k = ?
    ${where.length ? "AND " + where.join(" AND ") : ""}
    ORDER BY distance LIMIT ${limit}`;
  try {
    return (db().prepare(sql).all(...params) as { id: number }[]).map((r) => r.id);
  } catch (e) {
    process.stderr.write(`[claude-mem2] vec search err: ${(e as Error).message}\n`);
    return [];
  }
}

function expandViaGraph(seed: SearchHit[], limit: number): SearchHit[] {
  const seedIds = seed.map((s) => s.id);
  const placeholders = seedIds.map(() => "?").join(",");
  const neighbors = db().prepare(`
    SELECT DISTINCT o.id, o.project, o.kind, o.title, o.body, o.created_at, o.importance
    FROM observation_entities oe1
    JOIN observation_entities oe2 ON oe1.entity_id = oe2.entity_id AND oe2.observation_id != oe1.observation_id
    JOIN observations o ON o.id = oe2.observation_id
    WHERE oe1.observation_id IN (${placeholders})
    LIMIT ?
  `).all(...seedIds, limit) as Omit<SearchHit, "score" | "source">[];

  const map = new Map(seed.map((s) => [s.id, s]));
  for (const n of neighbors) {
    if (!map.has(n.id)) {
      map.set(n.id, { ...n, score: 0.001, source: ["graph"] });
    }
  }
  return [...map.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

export function recentByProject(project: string, limit = 30): SearchHit[] {
  const rows = db().prepare(`
    SELECT id, project, kind, title, body, created_at, importance
    FROM observations WHERE project=? AND compressed_into IS NULL
    ORDER BY created_at DESC LIMIT ?
  `).all(project, limit) as Omit<SearchHit, "score" | "source">[];
  return rows.map((r) => ({ ...r, score: 0, source: [] }));
}

export function neighborsOf(observationId: number, limit = 20): SearchHit[] {
  const rows = db().prepare(`
    SELECT DISTINCT o.id, o.project, o.kind, o.title, o.body, o.created_at, o.importance
    FROM observation_entities oe1
    JOIN observation_entities oe2 ON oe1.entity_id = oe2.entity_id AND oe2.observation_id != oe1.observation_id
    JOIN observations o ON o.id = oe2.observation_id
    WHERE oe1.observation_id = ?
    ORDER BY o.created_at DESC LIMIT ?
  `).all(observationId, limit) as Omit<SearchHit, "score" | "source">[];
  return rows.map((r) => ({ ...r, score: 0, source: ["graph"] }));
}
