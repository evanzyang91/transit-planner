// Seeds/updates the Langfuse dataset that backs the "Ask AI" map-assistant
// regression benchmark. Safe to re-run: each item has a stable `id`, and
// Langfuse upserts dataset items by id (confirmed via
// `npx langfuse-cli api dataset-items create --help`) — re-running this after
// editing questions.mjs updates the existing items instead of duplicating them.
//
// Usage (from web/): node scripts/ai-benchmark/dataset.mjs

import { config } from "dotenv";
import { resolve } from "node:path";
import { LangfuseClient } from "@langfuse/client";
import { BENCHMARK_ITEMS } from "./questions.mjs";
import { DATASET_NAME } from "./constants.mjs";

// Next.js reads .env.local automatically; a plain Node script doesn't, so we
// load it explicitly. Must be run with cwd = web/ (same as every other script
// in this directory).
config({ path: resolve(process.cwd(), ".env.local") });

async function main() {
  if (!process.env.LANGFUSE_SECRET_KEY || !process.env.LANGFUSE_PUBLIC_KEY) {
    console.error(
      "Missing LANGFUSE_SECRET_KEY / LANGFUSE_PUBLIC_KEY. Run this from web/ with .env.local populated.",
    );
    process.exit(1);
  }

  const langfuse = new LangfuseClient();

  try {
    await langfuse.api.datasets.create({
      name: DATASET_NAME,
      description:
        "Regression checks for the Ask AI map assistant's tool-selection, grounding, edge-case-rejection, multi-turn, and output-discipline rules (see web/src/server/map-data/prompt.ts).",
    });
    console.log(`Created dataset "${DATASET_NAME}".`);
  } catch (err) {
    // Already exists — fine, we're here to upsert items into it.
    console.log(`Dataset "${DATASET_NAME}" already exists, continuing.`);
  }

  for (const item of BENCHMARK_ITEMS) {
    await langfuse.dataset.createItem({
      datasetName: DATASET_NAME,
      id: item.id,
      input: item.input,
      expectedOutput: item.expectedOutput,
      metadata: item.metadata,
    });
    console.log(`  upserted item "${item.id}" (${item.metadata.category})`);
  }

  console.log(`\nDone — ${BENCHMARK_ITEMS.length} items in "${DATASET_NAME}".`);
}

// Guard so importing this file (e.g. run.mjs importing a constant from it)
// never triggers a live Langfuse write as a side effect — only running it
// directly (`node scripts/ai-benchmark/dataset.mjs`) does.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
