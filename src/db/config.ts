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
  };
}
