import { EMBED_DIM } from "../db/schema.js";

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const MODEL = process.env.CLAUDE_MEM2_EMBED_MODEL ?? "voyage-3-lite";

export async function embed(texts: string[]): Promise<Float32Array[] | null> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key || texts.length === 0) return null;
  const res = await fetch(VOYAGE_URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: texts, model: MODEL, output_dimension: EMBED_DIM, output_dtype: "float" }),
  });
  if (!res.ok) {
    process.stderr.write(`[claude-mem2] voyage embed failed: ${res.status} ${await res.text()}\n`);
    return null;
  }
  const data = (await res.json()) as { data: { embedding: number[] }[] };
  return data.data.map((d) => Float32Array.from(d.embedding));
}

export async function embedOne(text: string): Promise<Float32Array | null> {
  const out = await embed([text]);
  return out?.[0] ?? null;
}
