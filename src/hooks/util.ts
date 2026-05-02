import { readFileSync } from "fs";

export interface HookInput {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: string;
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

export async function readHookInput(): Promise<HookInput> {
  const raw = await readStdin();
  if (!raw.trim()) return { session_id: "unknown" };
  try { return JSON.parse(raw); } catch { return { session_id: "unknown" }; }
}

export function projectKey(cwd: string | undefined): string {
  return cwd ?? process.cwd();
}

export function readTranscript(path: string): string {
  try {
    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    const out: string[] = [];
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        if (ev.type === "user" && ev.message?.content) {
          out.push(`USER: ${stringify(ev.message.content)}`);
        } else if (ev.type === "assistant" && ev.message?.content) {
          out.push(`ASSISTANT: ${stringify(ev.message.content)}`);
        }
      } catch { /* skip */ }
    }
    return out.join("\n\n");
  } catch {
    return "";
  }
}

function stringify(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b: { type?: string; text?: string; name?: string }) => {
      if (b.type === "text") return b.text ?? "";
      if (b.type === "tool_use") return `[tool_use: ${b.name}]`;
      if (b.type === "tool_result") return "";
      return "";
    }).filter(Boolean).join("\n");
  }
  return JSON.stringify(content);
}
