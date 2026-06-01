// The corpus-eval scoring + pipeline moved to src/corpus-eval.ts so the
// dev-page HTTP endpoints (in src/) can share it without a build-time
// src->eval import. This module is kept as a thin re-export so existing
// imports (eval/replay.ts, tests) keep working.
export * from '../../src/corpus-eval.js';
