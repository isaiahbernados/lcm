#!/usr/bin/env node
/**
 * Stop hook handler (async).
 * Ingests the assistant's response + tool results after Claude finishes.
 */

import { runHook } from './orchestrator.js';
import type { HookContext } from './orchestrator.js';
import type { HookOutput } from '../core/types.js';
import { ingestNewMessages } from './ingest.js';
import { summarizeMessages } from '../core/summarize.js';
import { estimateTokens } from '../core/transcript-reader.js';
import { logger } from '../utils/logger.js';

async function handler(ctx: HookContext): Promise<HookOutput> {
  const { input, conversationStore, summaryStore, config } = ctx;
  if (!input.transcript_path) return {};

  const { messagesIngested } = await ingestNewMessages(
    input.transcript_path,
    input.session_id,
    input.cwd ?? '',
    conversationStore,
    summaryStore
  );

  // Granular compaction: if an API key is set, summarize every ~granularCompactThreshold tokens
  if (config.anthropicApiKey && messagesIngested > 0) {
    try {
      const conversation = conversationStore.getOrCreateConversation(input.session_id, input.cwd ?? '');
      const lastSeq = summaryStore.getMaxCompactedSequence(conversation.id);
      const pending = conversationStore.getMessages(conversation.id, lastSeq + 1);
      const pendingTokens = pending.reduce((sum, m) => sum + m.tokenCount, 0);

      if (pendingTokens >= config.granularCompactThreshold && pending.length > 0) {
        const maxSeq = pending[pending.length - 1]!.sequenceNumber;
        logger.info('Stop: token threshold reached, summarizing', { tokens: pendingTokens, messages: pending.length });

        const summaryText = await summarizeMessages(pending, config.anthropicApiKey);
        summaryStore.insertSummary({
          conversationId: conversation.id,
          parentId: null,
          level: 0,
          content: summaryText,
          tokenCount: estimateTokens(summaryText),
          messageRangeStart: lastSeq + 1,
          messageRangeEnd: maxSeq,
        });

        logger.info('Stop: granular summary stored', { range: `${lastSeq + 1}-${maxSeq}` });
      }
    } catch (err) {
      // Granular compaction is best-effort — never block the Stop hook
      logger.warn('Stop: granular summarization failed', { err });
    }
  }

  return {};
}

runHook(handler);
