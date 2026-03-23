import path from 'node:path';
import os from 'node:os';

export interface LcmConfig {
  /** Path to the SQLite database file */
  databasePath: string;
  /** Number of recent messages protected from compaction */
  freshTailCount: number;
  /** Max tokens to inject in PostCompact hook */
  postCompactInjectionTokens: number;
  /** Whether LCM is enabled */
  enabled: boolean;
  /** Anthropic API key for granular compaction (optional). If set, summarizes every ~granularCompactThreshold tokens using Haiku. */
  anthropicApiKey: string | null;
  /** Token threshold for triggering a granular summary (requires anthropicApiKey or useCliSummarizer). Default 20000. */
  granularCompactThreshold: number;
  /** Use `claude -p` subprocess for granular compaction instead of Haiku SDK. Free (uses subscription). Set LCM_USE_CLI=true. */
  useCliSummarizer: boolean;
}

function defaultDbPath(): string {
  return path.join(os.homedir(), '.lcm', 'lcm.db');
}

export function loadConfig(): LcmConfig {
  return {
    databasePath: process.env['LCM_DB_PATH'] ?? defaultDbPath(),
    freshTailCount: parseInt(process.env['LCM_FRESH_TAIL_COUNT'] ?? '32', 10),
    postCompactInjectionTokens: parseInt(process.env['LCM_POST_COMPACT_TOKENS'] ?? '3000', 10),
    enabled: (process.env['LCM_ENABLED'] ?? 'true') !== 'false',
    anthropicApiKey: process.env['LCM_ANTHROPIC_API_KEY'] ?? process.env['ANTHROPIC_API_KEY'] ?? null,
    granularCompactThreshold: parseInt(process.env['LCM_GRANULAR_THRESHOLD'] ?? '20000', 10),
    useCliSummarizer: (process.env['LCM_USE_CLI'] ?? 'false') !== 'false',
  };
}
