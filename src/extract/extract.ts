import { spawn } from "child_process";

export interface ExtractedObservation {
  kind: "decision" | "discovery" | "bugfix" | "feature" | "refactor" | "change" | "session";
  title: string;
  body: string;
  importance: number; // 1..5
  entities: { type: "file" | "symbol" | "person" | "project" | "tech" | "url"; name: string }[];
}

const SYSTEM = `You analyze a Claude Code session transcript and extract durable, high-signal observations worth remembering across sessions.

Rules:
- Only extract things that would be useful in a FUTURE conversation: decisions made (with rationale), non-obvious discoveries, bugs fixed (root cause + fix), features shipped, refactors, important changes, user preferences.
- Skip: trivial commands, file lists, intermediate exploration, things derivable from git/code.
- Title: under 80 chars, specific. Body: 1-3 sentences with the WHY when relevant.
- Importance 1=trivial, 5=critical decision/architecture.
- Entities: extract referenced files (paths), symbols (function/class names), tech (libraries/services), people, projects, URLs.

Output ONLY a JSON array of objects: [{"kind","title","body","importance","entities":[{"type","name"}]}]
No prose, no markdown fences, just JSON. Empty array [] if nothing worth remembering.`;

export async function extractObservations(transcript: string): Promise<ExtractedObservation[]> {
  if (!transcript.trim()) return [];
  const prompt = `${SYSTEM}\n\n<transcript>\n${transcript.slice(-60000)}\n</transcript>`;
  const out = await runClaude(prompt);
  const json = stripFences(out).trim();
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValid);
  } catch {
    const m = json.match(/\[[\s\S]*\]/);
    if (m) {
      try { return (JSON.parse(m[0]) as unknown[]).filter(isValid); } catch { /* ignore */ }
    }
    return [];
  }
}

function isValid(x: unknown): x is ExtractedObservation {
  return typeof x === "object" && x !== null && "kind" in x && "title" in x && "body" in x;
}

function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
}

function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", ["-p", "--output-format", "text", "--model", "claude-haiku-4-5-20251001"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "", err = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`claude exited ${code}: ${err}`));
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}
