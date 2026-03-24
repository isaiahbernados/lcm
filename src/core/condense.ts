/**
 * DAG condensation — creates level-1+ summaries from groups of level-0 summaries.
 *
 * When enough uncondensed (parentId === null) level-0 summaries accumulate,
 * this module groups them and generates a condensed summary-of-summaries.
 * The condensed summary becomes the parent of its constituents in the DAG.
 */

import type { SummaryStore } from './summary-store.js';
import type { LcmMessage } from './types.js';
import { summarizeWithEscalation } from './summarize.js';
import { summarizeWithCLIEscalation } from './summarize-cli.js';
import { estimateTokens } from './transcript-reader.js';
import { logger } from '../utils/logger.js';

interface CondenseConfig {
  condensationThreshold: number;
  anthropicApiKey: string | null;
  useCliSummarizer: boolean;
}

/**
 * Check if condensation is needed and perform it.
 * Groups uncondensed level-0 summaries into batches and creates level-1 parents.
 */
export async function condenseIfNeeded(
  conversationId: string,
  summaryStore: SummaryStore,
  config: CondenseConfig,
): Promise<number> {
  const threshold = config.condensationThreshold;
  const uncondensed = summaryStore.getUncondensedSummaries(conversationId, 0);

  if (uncondensed.length < threshold) {
    return 0;
  }

  const granularEnabled = config.anthropicApiKey || config.useCliSummarizer;
  if (!granularEnabled) {
    return 0;
  }

  let condensedCount = 0;

  // Group into batches of `threshold` consecutive summaries
  for (let i = 0; i + threshold <= uncondensed.length; i += threshold) {
    const batch = uncondensed.slice(i, i + threshold);

    const rangeStart = batch[0]!.messageRangeStart;
    const rangeEnd = batch[batch.length - 1]!.messageRangeEnd;

    // Treat summary contents as "messages" for the escalation summarizer
    const pseudoMessages: LcmMessage[] = batch.map((s, idx) => ({
      id: s.id,
      conversationId: s.conversationId,
      role: 'assistant' as const,
      content: s.content,
      tokenCount: s.tokenCount,
      sequenceNumber: idx,
      timestamp: s.createdAt,
    }));

    try {
      const { text, level: escalationLevel } = config.anthropicApiKey
        ? await summarizeWithEscalation(pseudoMessages, config.anthropicApiKey)
        : await summarizeWithCLIEscalation(pseudoMessages);

      const parent = summaryStore.insertSummary({
        conversationId,
        parentId: null,
        level: 1,
        content: text,
        tokenCount: estimateTokens(text),
        messageRangeStart: rangeStart,
        messageRangeEnd: rangeEnd,
      });

      // Point each child's parentId to the new condensed summary
      for (const child of batch) {
        summaryStore.updateParentId(child.id, parent.id);
      }

      condensedCount++;
      logger.info('Condense: created level-1 summary', {
        parentId: parent.id,
        children: batch.length,
        range: `${rangeStart}-${rangeEnd}`,
        escalationLevel,
      });
    } catch (err) {
      logger.warn('Condense: failed to create condensed summary', { err });
    }
  }

  return condensedCount;
}
