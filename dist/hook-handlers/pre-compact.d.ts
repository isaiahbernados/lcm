#!/usr/bin/env node
/**
 * PreCompact hook handler (sync).
 *
 * Runs before Claude's built-in compaction.
 * Snapshots any un-captured messages to SQLite, then lets Claude compact normally.
 * Claude's generated summary is captured in PostCompact.
 */
export {};
//# sourceMappingURL=pre-compact.d.ts.map