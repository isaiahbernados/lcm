#!/usr/bin/env node
/**
 * PreCompact hook handler (sync).
 *
 * Runs before Claude's built-in compaction:
 * 1. Ingests any un-captured messages
 * 2. Runs LCM's DAG compaction to build summary hierarchy
 */

import { runHook } from './orchestrator.js';
import type { HookContext } from './orchestrator.js';
import type { HookOutput } from '../core/types.js';
import { ingestNewMessages } from './ingest.js';
import { CompactionEngine } from '../core/compaction-engine.js';
import { createSummarizeFn } from '../core/summarize.js';
import { logger } from '../utils/logger.js';

async function handler(ctx: HookContext): Promise<HookOutput> {
  const { input, conversationStore, summaryStore, config } = ctx;

  // Final snapshot before compaction
  if (input.transcript_path) {
    await ingestNewMessages(
      input.transcript_path,
      input.session_id,
      input.cwd ?? '',
      conversationStore,
      summaryStore
    );
  }

  const conversation = conversationStore.getConversationBySession(input.session_id);
  if (!conversation) return {};

  const summarize = createSummarizeFn(config.anthropicApiKey, config.summaryModel);
  const engine = new CompactionEngine(conversationStore, summaryStore, summarize, {
    leafChunkTokens: config.leafChunkTokens,
    leafFanout: config.leafFanout,
    condensedFanout: config.condensedFanout,
    freshTailCount: config.freshTailCount,
  });

  try {
    const result = await engine.compact(conversation.id);
    logger.info('PreCompact: LCM compaction complete', result);
  } catch (err) {
    logger.error('PreCompact: compaction failed', err);
  }

  return {};
}

runHook(handler);
