#!/usr/bin/env node
/**
 * Stop hook handler (async).
 * Ingests the assistant's response + tool results after Claude finishes.
 */

import { runHook } from './orchestrator.js';
import type { HookContext } from './orchestrator.js';
import type { HookOutput } from '../core/types.js';
import { ingestNewMessages } from './ingest.js';
import { summarizeWithEscalation } from '../core/summarize.js';
import { summarizeWithCLIEscalation } from '../core/summarize-cli.js';
import { estimateTokens } from '../core/transcript-reader.js';
import { logger } from '../utils/logger.js';

async function handler(ctx: HookContext): Promise<HookOutput> {
  // Recursion guard: claude -p subprocesses set this to prevent re-triggering
  if (process.env['LCM_SUBPROCESS'] === '1') return {};

  const { input, conversationStore, summaryStore, config } = ctx;
  if (!input.transcript_path) return {};

  const { messagesIngested } = await ingestNewMessages(
    input.transcript_path,
    input.session_id,
    input.cwd ?? '',
    conversationStore,
    summaryStore
  );

  // Granular compaction: summarize every ~granularCompactThreshold tokens
  // Priority: Haiku SDK (if API key set) > claude -p CLI (if LCM_USE_CLI=true) > skip
  const granularEnabled = config.anthropicApiKey || config.useCliSummarizer;
  if (granularEnabled && messagesIngested > 0) {
    try {
      const conversation = conversationStore.getOrCreateConversation(input.session_id, input.cwd ?? '');
      const lastSeq = summaryStore.getMaxCompactedSequence(conversation.id);
      const pending = conversationStore.getMessages(conversation.id, lastSeq + 1);
      const pendingTokens = pending.reduce((sum, m) => sum + m.tokenCount, 0);

      if (pendingTokens >= config.granularCompactThreshold && pending.length > 0) {
        const maxSeq = pending[pending.length - 1]!.sequenceNumber;
        const mode = config.anthropicApiKey ? 'haiku-sdk' : 'claude-cli';
        logger.info('Stop: token threshold reached, summarizing', { tokens: pendingTokens, messages: pending.length, mode });

        const { text: summaryText, level: escalationLevel } = config.anthropicApiKey
          ? await summarizeWithEscalation(pending, config.anthropicApiKey)
          : await summarizeWithCLIEscalation(pending);

        const summary = summaryStore.insertSummary({
          conversationId: conversation.id,
          parentId: null,
          level: 0,
          content: summaryText,
          tokenCount: estimateTokens(summaryText),
          messageRangeStart: lastSeq + 1,
          messageRangeEnd: maxSeq,
        });

        // Link summary to the specific messages it covers
        summaryStore.linkSummaryToMessages(summary.id, pending.map(m => m.id));

        logger.info('Stop: granular summary stored', { range: `${lastSeq + 1}-${maxSeq}`, mode, escalationLevel });
      }
    } catch (err) {
      // Granular compaction is best-effort — never block the Stop hook
      logger.warn('Stop: granular summarization failed', { err });
    }
  }

  return {};
}

runHook(handler);
