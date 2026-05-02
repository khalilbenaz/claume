import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

export const EMBED_DIM = 512;

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  sqliteVec.load(db);
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      cwd TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      summary TEXT
    );

    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      project TEXT NOT NULL,
      kind TEXT NOT NULL,           -- decision | discovery | bugfix | feature | refactor | change | session
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      importance INTEGER DEFAULT 3, -- 1..5
      compressed_into INTEGER REFERENCES observations(id)
    );
    CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project);
    CREATE INDEX IF NOT EXISTS idx_obs_created ON observations(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_obs_kind ON observations(kind);

    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,           -- file | symbol | person | project | tech | url
      name TEXT NOT NULL,
      UNIQUE(type, name)
    );
    CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);

    CREATE TABLE IF NOT EXISTS observation_entities (
      observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
      entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      PRIMARY KEY (observation_id, entity_id)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
      title, body, project UNINDEXED, content='observations', content_rowid='id',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS obs_ai AFTER INSERT ON observations BEGIN
      INSERT INTO observations_fts(rowid, title, body, project) VALUES (new.id, new.title, new.body, new.project);
    END;
    CREATE TRIGGER IF NOT EXISTS obs_ad AFTER DELETE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, body, project) VALUES('delete', old.id, old.title, old.body, old.project);
    END;
    CREATE TRIGGER IF NOT EXISTS obs_au AFTER UPDATE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, body, project) VALUES('delete', old.id, old.title, old.body, old.project);
      INSERT INTO observations_fts(rowid, title, body, project) VALUES (new.id, new.title, new.body, new.project);
    END;
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS observations_vec USING vec0(
      observation_id INTEGER PRIMARY KEY,
      embedding FLOAT[${EMBED_DIM}]
    );
  `);
}
