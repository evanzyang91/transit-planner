/**
 * The /docs chat corpus now comes from ~/lib/project-knowledge.ts — the single
 * source of truth that the Ask AI map assistant reads too.
 *
 * Why this file is (almost) empty: it used to hold its own hand-written copy
 * of the docs (USER_DOCS / TECHNICAL_DOCS), which had drifted from the app —
 * a "6-round" council with the wrong roster, a bottom toolbar that no longer
 * exists, only two of the map's fifteen layers. Rather than fix a second copy,
 * it was retired. This re-export keeps any old `~/lib/docs-content` import
 * working; new code should import from `~/lib/project-knowledge` directly.
 */

export { buildDocsCorpus } from "./project-knowledge";
