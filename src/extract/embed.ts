import { execSync } from "child_process";
import { EMBED_DIM } from "../db/schema.js";
import { embedLocal } from "./embed-local.js";

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const VOYAGE_MODEL = process.env.CLAUME_EMBED_MODEL ?? "voyage-3-lite";
const BACKEND = (process.env.CLAUME_EMBED_BACKEND ?? "local").toLowerCase(); // local | voyage | auto

let _cachedKey: string | null | undefined;
function getVoyageKey(): string | null {
  if (_cachedKey !== undefined) return _cachedKey;
  if (process.env.VOYAGE_API_KEY) return (_cachedKey = process.env.VOYAGE_API_KEY);
  if (process.platform === "darwin") {
    try {
      const out = execSync(`security find-generic-password -s voyage-api-key -w`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      if (out) return (_cachedKey = out);
    } catch { /* not in keychain */ }
  }
  return (_cachedKey = null);
}

async function embedVoyage(texts: string[], key: string): Promise<Float32Array[] | null> {
  const res = await fetch(VOYAGE_URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: texts, model: VOYAGE_MODEL, output_dimension: EMBED_DIM, output_dtype: "float" }),
  });
  if (!res.ok) {
    process.stderr.write(`[claume] voyage embed failed: ${res.status}\n`);
    return null;
  }
  const data = (await res.json()) as { data: { embedding: number[] }[] };
  return data.data.map((d) => Float32Array.from(d.embedding));
}

export async function embed(texts: string[]): Promise<Float32Array[] | null> {
  if (texts.length === 0) return null;
  const key = BACKEND !== "local" ? getVoyageKey() : null;
  if (BACKEND === "voyage" || (BACKEND === "auto" && key)) {
    if (key) {
      const out = await embedVoyage(texts, key);
      if (out) return out;
    }
  }
  // local fallback
  try {
    return await embedLocal(texts);
  } catch (e) {
    process.stderr.write(`[claume] local embed failed: ${(e as Error).message}\n`);
    return null;
  }
}

export async function embedOne(text: string): Promise<Float32Array | null> {
  const out = await embed([text]);
  return out?.[0] ?? null;
}
