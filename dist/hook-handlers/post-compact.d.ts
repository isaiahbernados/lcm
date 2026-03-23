#!/usr/bin/env node
/**
 * PostCompact hook handler (sync).
 *
 * Runs after Claude's built-in compaction.
 * 1. Captures `compact_summary` (Claude's own generated summary) → stored in SQLite for free
 * 2. Re-injects stored summaries as additionalContext so Claude has its full history
 */
export {};
//# sourceMappingURL=post-compact.d.ts.map