import path from 'node:path';
import os from 'node:os';

export interface LcmConfig {
  /** Path to the SQLite database file */
  databasePath: string;
  /** Number of recent messages protected from compaction */
  freshTailCount: number;
  /** Fraction of context budget that triggers compaction (0.0-1.0) */
  contextThreshold: number;
  /** Leaf chunk size in tokens before summarization */
  leafChunkTokens: number;
  /** Minimum fanout for leaf summaries */
  leafFanout: number;
  /** Minimum fanout for condensed summaries */
  condensedFanout: number;
  /** Max tokens to inject in PostCompact hook */
  postCompactInjectionTokens: number;
  /** Model to use for summarization */
  summaryModel: string;
  /** Anthropic API key (falls back to ANTHROPIC_API_KEY env var) */
  anthropicApiKey?: string;
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
    contextThreshold: parseFloat(process.env['LCM_CONTEXT_THRESHOLD'] ?? '0.75'),
    leafChunkTokens: parseInt(process.env['LCM_LEAF_CHUNK_TOKENS'] ?? '20000', 10),
    leafFanout: parseInt(process.env['LCM_LEAF_FANOUT'] ?? '8', 10),
    condensedFanout: parseInt(process.env['LCM_CONDENSED_FANOUT'] ?? '4', 10),
    postCompactInjectionTokens: parseInt(process.env['LCM_POST_COMPACT_TOKENS'] ?? '3000', 10),
    summaryModel: process.env['LCM_SUMMARY_MODEL'] ?? 'claude-haiku-4-5-20251001',
    anthropicApiKey: process.env['ANTHROPIC_API_KEY'],
    enabled: (process.env['LCM_ENABLED'] ?? 'true') !== 'false',
  };
}
