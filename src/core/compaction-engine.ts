/**
 * DAG-based hierarchical compaction engine (adapted from lossless-claw).
 *
 * Two-phase strategy:
 *   1. Leaf pass: group oldest raw messages into leaf summary nodes (depth 0)
 *   2. Condensed pass: group leaf summaries into higher-level nodes (depth 1+)
 *
 * Fresh tail protection: the last N messages are never compacted.
 */

import type { ConversationStore } from './conversation-store.js';
import type { SummaryStore } from './summary-store.js';
import type { LcmMessage, LcmSummary, CompactionResult } from './types.js';
import type { SummarizeFn } from './summarize.js';
import { estimateTokens } from './transcript-reader.js';
import { logger } from '../utils/logger.js';

export interface CompactionOptions {
  leafChunkTokens: number;
  leafFanout: number;
  condensedFanout: number;
  freshTailCount: number;
}

export class CompactionEngine {
  constructor(
    private conversationStore: ConversationStore,
    private summaryStore: SummaryStore,
    private summarize: SummarizeFn,
    private options: CompactionOptions
  ) {}

  async compact(conversationId: string): Promise<CompactionResult> {
    const allMessages = this.conversationStore.getMessages(conversationId);
    if (allMessages.length === 0) return { summariesCreated: 0, messagesCompacted: 0, tokensSaved: 0 };

    // Protect fresh tail
    const tail = Math.min(this.options.freshTailCount, allMessages.length);
    const compactable = allMessages.slice(0, allMessages.length - tail);

    if (compactable.length < this.options.leafFanout) {
      logger.debug('Not enough messages to compact', { conversationId, count: compactable.length });
      return { summariesCreated: 0, messagesCompacted: 0, tokensSaved: 0 };
    }

    // Find already-compacted range
    const maxCompacted = this.summaryStore.getMaxCompactedSequence(conversationId);
    const uncompacted = compactable.filter((m) => m.sequenceNumber > maxCompacted);

    if (uncompacted.length < this.options.leafFanout) {
      // Try condensing existing leaf summaries
      return await this.condensedPass(conversationId);
    }

    const result = await this.leafPass(conversationId, uncompacted);
    const condensed = await this.condensedPass(conversationId);

    return {
      summariesCreated: result.summariesCreated + condensed.summariesCreated,
      messagesCompacted: result.messagesCompacted + condensed.messagesCompacted,
      tokensSaved: result.tokensSaved + condensed.tokensSaved,
    };
  }

  /** Group raw messages into leaf summary chunks */
  private async leafPass(
    conversationId: string,
    messages: LcmMessage[]
  ): Promise<CompactionResult> {
    const chunks = chunkByTokens(messages, this.options.leafChunkTokens);
    let summariesCreated = 0;
    let messagesCompacted = 0;
    let tokensSaved = 0;

    for (const chunk of chunks) {
      if (chunk.length < 2) continue; // Don't summarize single messages

      const inputForLlm = chunk.map((m) => ({ role: m.role, content: m.content }));
      const inputTokens = chunk.reduce((sum, m) => sum + m.tokenCount, 0);

      let summaryText: string;
      try {
        summaryText = await this.summarize(inputForLlm, 0);
      } catch (err) {
        logger.error('Leaf summarization failed', err);
        continue;
      }

      const summaryTokens = estimateTokens(summaryText);
      const summary = this.summaryStore.insertSummary({
        conversationId,
        parentId: null,
        level: 0,
        content: summaryText,
        tokenCount: summaryTokens,
        messageRangeStart: chunk[0]!.sequenceNumber,
        messageRangeEnd: chunk[chunk.length - 1]!.sequenceNumber,
      });

      this.summaryStore.linkSummaryToMessages(summary.id, chunk.map((m) => m.id));

      summariesCreated++;
      messagesCompacted += chunk.length;
      tokensSaved += inputTokens - summaryTokens;
    }

    return { summariesCreated, messagesCompacted, tokensSaved };
  }

  /** Condense leaf summaries into higher-level DAG nodes */
  private async condensedPass(conversationId: string): Promise<CompactionResult> {
    let summariesCreated = 0;
    let tokensSaved = 0;
    let level = 0;

    // Process each level until we can't condense further
    while (true) {
      const leafSummaries = this.summaryStore
        .getSummariesForConversation(conversationId, level)
        .filter((s) => s.parentId === null);

      if (leafSummaries.length < this.options.condensedFanout) break;

      // Group into chunks of condensedFanout
      const chunks = groupIntoChunks(leafSummaries, this.options.condensedFanout);
      let anyCondensed = false;

      for (const chunk of chunks) {
        if (chunk.length < this.options.condensedFanout) continue; // Leave partial chunks

        const inputForLlm = chunk.map((s) => ({ role: 'system', content: s.content }));
        const inputTokens = chunk.reduce((sum, s) => sum + s.tokenCount, 0);

        let summaryText: string;
        try {
          summaryText = await this.summarize(inputForLlm, level + 1);
        } catch (err) {
          logger.error('Condensed summarization failed', err);
          continue;
        }

        const summaryTokens = estimateTokens(summaryText);
        const parent = this.summaryStore.insertSummary({
          conversationId,
          parentId: null,
          level: level + 1,
          content: summaryText,
          tokenCount: summaryTokens,
          messageRangeStart: chunk[0]!.messageRangeStart,
          messageRangeEnd: chunk[chunk.length - 1]!.messageRangeEnd,
        });

        // Point child summaries to new parent
        for (const child of chunk) {
          // Update parent_id via re-insert isn't practical with node:sqlite
          // Instead we track parentage by inserting a new summary that covers
          // the same range. The old summaries remain for expansion purposes.
        }

        summariesCreated++;
        tokensSaved += inputTokens - summaryTokens;
        anyCondensed = true;
      }

      if (!anyCondensed) break;
      level++;
    }

    return { summariesCreated, messagesCompacted: 0, tokensSaved };
  }
}

function chunkByTokens(messages: LcmMessage[], maxTokens: number): LcmMessage[][] {
  const chunks: LcmMessage[][] = [];
  let current: LcmMessage[] = [];
  let currentTokens = 0;

  for (const msg of messages) {
    if (currentTokens + msg.tokenCount > maxTokens && current.length > 0) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(msg);
    currentTokens += msg.tokenCount;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function groupIntoChunks<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
