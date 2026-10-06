// Shared, side-effect-free constants for dataset.mjs and run.mjs. Kept
// separate from dataset.mjs specifically so run.mjs can import the name
// without also triggering dataset.mjs's unconditional main() (a live
// Langfuse write) as an import side effect.
export const DATASET_NAME = "ask-ai-map-assistant-regression";
