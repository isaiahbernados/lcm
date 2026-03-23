#!/usr/bin/env node
/**
 * PreCompact hook handler (sync).
 *
 * Runs before Claude's built-in compaction.
 * Snapshots any un-captured messages to SQLite, then lets Claude compact normally.
 * Claude's generated summary is captured in PostCompact.
 */

import { runHook } from './orchestrator.js';
import type { HookContext } from './orchestrator.js';
import type { HookOutput } from '../core/types.js';
import { ingestNewMessages } from './ingest.js';
import { logger } from '../utils/logger.js';

async function handler(ctx: HookContext): Promise<HookOutput> {
  const { input, conversationStore, summaryStore } = ctx;

  // Final snapshot — ensure all messages are persisted before Claude compacts
  if (input.transcript_path) {
    const { messagesIngested } = await ingestNewMessages(
      input.transcript_path,
      input.session_id,
      input.cwd ?? '',
      conversationStore,
      summaryStore
    );
    logger.info('PreCompact: snapshot complete', { messagesIngested });
  }

  return {};
}

runHook(handler);
