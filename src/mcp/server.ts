#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { search, recentByProject, neighborsOf } from "../search/search.js";
import { db } from "../db/index.js";

const server = new Server({ name: "claude-mem2", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search",
      description: "Hybrid (BM25 + vector) semantic search over persistent memory across all sessions. Returns ranked observations.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language query" },
          limit: { type: "number", default: 15 },
          project: { type: "string", description: "Filter to a specific project" },
          kinds: { type: "array", items: { type: "string" }, description: "Filter by kind: decision|discovery|bugfix|feature|refactor|change|session" },
          since_days: { type: "number", description: "Only results from the last N days" },
          expand_graph: { type: "boolean", description: "Include observations linked via shared entities", default: false },
        },
        required: ["query"],
      },
    },
    {
      name: "get_observation",
      description: "Fetch a single observation by ID with its linked entities.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
      },
    },
    {
      name: "recent",
      description: "Recent observations for a project (defaults to current cwd).",
      inputSchema: {
        type: "object",
        properties: { project: { type: "string" }, limit: { type: "number", default: 30 } },
      },
    },
    {
      name: "neighbors",
      description: "Find observations linked to the given one via shared entities (files, symbols, tech).",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number" }, limit: { type: "number", default: 20 } },
        required: ["id"],
      },
    },
    {
      name: "timeline",
      description: "Chronological timeline of observations for a project.",
      inputSchema: {
        type: "object",
        properties: { project: { type: "string" }, days: { type: "number", default: 30 }, limit: { type: "number", default: 50 } },
        required: ["project"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    switch (name) {
      case "search": {
        const since = args.since_days ? Date.now() - Number(args.since_days) * 86400_000 : undefined;
        const hits = await search(String(args.query), {
          limit: Number(args.limit ?? 15),
          project: args.project as string | undefined,
          kinds: args.kinds as string[] | undefined,
          since,
          expandGraph: Boolean(args.expand_graph),
        });
        return { content: [{ type: "text", text: formatHits(hits) }] };
      }
      case "get_observation": {
        const id = Number(args.id);
        const obs = db().prepare(`SELECT * FROM observations WHERE id=?`).get(id);
        if (!obs) return { content: [{ type: "text", text: `Not found: ${id}` }], isError: true };
        const ents = db().prepare(`
          SELECT e.type, e.name FROM observation_entities oe
          JOIN entities e ON e.id = oe.entity_id WHERE oe.observation_id=?
        `).all(id);
        return { content: [{ type: "text", text: JSON.stringify({ ...obs, entities: ents }, null, 2) }] };
      }
      case "recent": {
        const project = (args.project as string) ?? process.cwd();
        const hits = recentByProject(project, Number(args.limit ?? 30));
        return { content: [{ type: "text", text: formatHits(hits) }] };
      }
      case "neighbors": {
        const hits = neighborsOf(Number(args.id), Number(args.limit ?? 20));
        return { content: [{ type: "text", text: formatHits(hits) }] };
      }
      case "timeline": {
        const since = Date.now() - Number(args.days ?? 30) * 86400_000;
        const rows = db().prepare(`
          SELECT id, kind, title, created_at, importance FROM observations
          WHERE project=? AND created_at >= ? ORDER BY created_at DESC LIMIT ?
        `).all(args.project, since, Number(args.limit ?? 50));
        return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
      }
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
  }
});

interface SimpleHit { id: number; project: string; kind: string; title: string; body: string; created_at: number; importance: number; score?: number; source?: string[]; }
function formatHits(hits: SimpleHit[]): string {
  if (hits.length === 0) return "No results.";
  return hits.map((h) => {
    const date = new Date(h.created_at).toISOString().slice(0, 10);
    const src = h.source?.length ? ` [${h.source.join("+")}]` : "";
    return `#${h.id} ${date} ${h.kind} (imp:${h.importance})${src} — ${h.title}\n  ${h.body}`;
  }).join("\n\n");
}

await server.connect(new StdioServerTransport());
process.stderr.write("[claude-mem2] MCP server ready\n");
