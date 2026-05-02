#!/usr/bin/env node
import { readHookInput, readTranscript, projectKey } from "./util.js";
import { extractObservations } from "../extract/extract.js";
import { embed } from "../extract/embed.js";
import { insertObservation, linkEntities, endSession } from "../db/index.js";

async function main() {
  const input = await readHookInput();
  const project = projectKey(input.cwd);
  if (!input.transcript_path) {
    process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }
  const transcript = readTranscript(input.transcript_path);
  if (!transcript || transcript.length < 200) {
    endSession(input.session_id);
    process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const observations = await extractObservations(transcript);
  if (observations.length === 0) {
    endSession(input.session_id);
    process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const texts = observations.map((o) => `${o.title}\n${o.body}`);
  const embeddings = await embed(texts);

  const now = Date.now();
  observations.forEach((o, i) => {
    const id = insertObservation(
      {
        session_id: input.session_id,
        project,
        kind: o.kind,
        title: o.title,
        body: o.body,
        created_at: now + i,
        importance: o.importance ?? 3,
      },
      embeddings?.[i],
    );
    if (o.entities?.length) linkEntities(id, o.entities);
  });

  endSession(input.session_id, `${observations.length} observations captured`);
  process.stderr.write(`[claude-mem2] captured ${observations.length} obs for ${project}\n`);
  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
}

main().catch((e) => {
  process.stderr.write(`[claude-mem2 stop] ${(e as Error).message}\n`);
  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
});
