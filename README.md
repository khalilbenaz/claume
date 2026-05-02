# claume

Persistent semantic memory for [Claude Code](https://claude.ai/code). Captures durable observations from every session and surfaces them in future ones via hybrid search and an entity graph.

Inspired by [claude-mem](https://github.com/thedotmack/claude-mem) but rebuilt with three core improvements:

| Feature | claude-mem | **claume** |
|---|---|---|
| Search | FTS5 keyword | **FTS5 + vector (sqlite-vec) fused via RRF** |
| Entity graph | none | **files / symbols / tech / projects** |
| Compression | index truncation | **clustering by `kind` + LLM resummary** |
| Importance | flat | **1–5, protects critical observations** |

## How it works

```
┌──────────────┐                                    ┌──────────────┐
│ Claude Code  │  SessionStart hook                 │ ~/.claume/   │
│   session    │ ───────────────────────────────►   │  memory.db   │
│              │  injects recent context            │ (SQLite +    │
│              │                                    │  sqlite-vec) │
│              │  Stop hook                         │              │
│              │ ───────────────────────────────►   │              │
│              │  extracts observations via         │              │
│              │  `claude -p` (Haiku 4.5)           │              │
│              │                                    │              │
│              │  PreCompact hook                   │              │
│              │ ───────────────────────────────►   │              │
│              │  clusters & compresses old obs     │              │
│              │                                    │              │
│              │  MCP tools (search/recent/...)     │              │
│              │ ◄───────────────────────────────   │              │
└──────────────┘                                    └──────────────┘
```

1. **`SessionStart`** — looks up recent observations for the current project (basename of `cwd`) and injects them as `additionalContext` so Claude opens with full memory.
2. **`Stop`** — reads the session transcript, extracts durable observations (decisions, discoveries, bugfixes, features, refactors) via `claude -p` with a strict JSON schema, embeds them, and stores them.
3. **`PreCompact`** — when more than 8 stale (>30 days) observations of the same kind exist, clusters them into a single compressed observation and marks the originals as compressed. Importance ≥5 is preserved.
4. **MCP server** — exposes `search`, `recent`, `neighbors`, `timeline`, `get_observation` to the Claude Code session.

### Hybrid search (RRF)

For every query, claume runs two searches in parallel:
- **BM25** via SQLite FTS5 (lexical, fast, handles rare terms well)
- **Cosine similarity** via `sqlite-vec` (semantic, handles paraphrasing and translation)

Results are fused with **Reciprocal Rank Fusion** (`k=60`):

```
score(doc) = Σ  1 / (k + rank_i(doc))
            i∈{fts, vec}
```

Optionally expanded via the entity graph: observations sharing files / symbols / tech with top hits are pulled in.

## Installation

```bash
git clone https://github.com/khalilbenaz/claume ~/Projects/claume
cd ~/Projects/claume
npm install
npm run build
```

Wire it into Claude Code by adding to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node /Users/YOU/Projects/claume/dist/hooks/session-start.js", "timeout": 15 }] }],
    "Stop":         [{ "hooks": [{ "type": "command", "command": "node /Users/YOU/Projects/claume/dist/hooks/stop.js",         "timeout": 120 }] }],
    "PreCompact":   [{ "hooks": [{ "type": "command", "command": "node /Users/YOU/Projects/claume/dist/hooks/pre-compact.js",  "timeout": 60 }] }]
  },
  "mcpServers": {
    "claume": {
      "command": "node",
      "args": ["/Users/YOU/Projects/claume/dist/mcp/server.js"]
    }
  },
  "permissions": { "allow": ["mcp__claume"] }
}
```

claume now starts with every Claude Code session.

### Embeddings

By default claume runs **fully local**: `Xenova/multilingual-e5-small` (384 dims, multilingual, ~120 MB downloaded once on first use) via [`@huggingface/transformers`](https://huggingface.co/docs/transformers.js). No API key, no network after the initial model download.

First embed: ~20s (model load). Subsequent embeds: ~5 ms each.

To use Voyage AI instead (hosted, slightly stronger on code retrieval):

```bash
export CLAUME_EMBED_BACKEND=voyage
export VOYAGE_API_KEY=...   # or store under "voyage-api-key" in macOS keychain
```

Available backends: `local` (default), `voyage`, `auto` (Voyage if key present, else local).

## CLI

```bash
node bin/cli.js search "PRD CNSS PAYSMART"
node bin/cli.js recent budget-app
node bin/cli.js stats
```

## Migrating from claude-mem

```bash
node dist/migrate/from-claude-mem.js
# defaults to ~/.claude-mem/claude-mem.db; pass a path to override
```

Maps:
- `observations.type` → `kind` (with normalization)
- `observations.{subtitle, narrative, facts}` → unified `body`
- `observations.{concepts, files_read, files_modified}` → entity graph links
- `session_summaries` → observations of `kind=session`

## Schema

```
sessions          (id, project, cwd, started_at, ended_at, summary)
observations      (id, session_id, project, kind, title, body, created_at,
                   importance, compressed_into)
entities          (id, type, name)              -- type: file|symbol|person|project|tech|url
observation_entities (observation_id, entity_id)
observations_fts  -- FTS5 mirror of (title, body)
observations_vec  -- vec0 mirror of embeddings (FLOAT[512])
```

## MCP tools

| Tool | What it does |
|---|---|
| `search` | Hybrid BM25+vector search. Args: `query`, `limit`, `project`, `kinds`, `since_days`, `expand_graph`. |
| `recent` | Recent observations for a project (defaults to `cwd`). |
| `neighbors` | Observations linked to a given one via shared entities. |
| `timeline` | Chronological view of a project. |
| `get_observation` | Full observation with linked entities. |

## Stack

- **TypeScript** + **better-sqlite3** + **sqlite-vec**
- **MCP SDK** (`@modelcontextprotocol/sdk`)
- **Voyage AI** for embeddings (optional)
- **Claude Haiku 4.5** for observation extraction (via the `claude` CLI you already have)

Zero servers, zero containers. One SQLite file at `~/.claume/memory.db`.

## License

MIT
