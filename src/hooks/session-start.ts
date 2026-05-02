#!/usr/bin/env node
import { readHookInput, projectKey } from "./util.js";
import { recentByProject } from "../search/search.js";
import { startSession } from "../db/index.js";

const MAX_OBS = 25;

async function main() {
  const input = await readHookInput();
  const project = projectKey(input.cwd);
  startSession(input.session_id, project, project);

  const obs = recentByProject(project, MAX_OBS);
  if (obs.length === 0) {
    process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const lines = obs.map((o) => {
    const date = new Date(o.created_at).toISOString().slice(0, 10);
    return `- #${o.id} [${date}] ${o.kind}: ${o.title} — ${o.body}`;
  });

  const ctx = `# claude-mem2 — recent context for ${project}\n\n${lines.join("\n")}\n\nUse the \`search\` MCP tool for semantic recall across all projects.`;

  process.stdout.write(JSON.stringify({
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: ctx,
    },
  }));
}

main().catch((e) => {
  process.stderr.write(`[claude-mem2 session-start] ${(e as Error).message}\n`);
  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
});
