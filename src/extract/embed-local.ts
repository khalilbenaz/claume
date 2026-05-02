import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

const MODEL = process.env.CLAUME_LOCAL_MODEL ?? "Xenova/multilingual-e5-small";

let _pipe: FeatureExtractionPipeline | null = null;
async function getPipe(): Promise<FeatureExtractionPipeline> {
  if (_pipe) return _pipe;
  _pipe = (await pipeline("feature-extraction", MODEL, { dtype: "fp32" })) as FeatureExtractionPipeline;
  return _pipe;
}

// e5 family expects "query: " / "passage: " prefixes for best quality.
function prep(text: string): string {
  return `passage: ${text.slice(0, 8000)}`;
}

export async function embedLocal(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const pipe = await getPipe();
  const out = await pipe(texts.map(prep), { pooling: "mean", normalize: true });
  const dim = out.dims[out.dims.length - 1];
  const flat = out.data as Float32Array;
  const result: Float32Array[] = [];
  for (let i = 0; i < texts.length; i++) {
    result.push(flat.slice(i * dim, (i + 1) * dim));
  }
  return result;
}
