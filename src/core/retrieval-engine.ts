/**
 * Retrieval engine — search, describe, and expand stored history.
 * Adapted from lossless-claw's RetrievalEngine.
 */

import type { ConversationStore } from './conversation-store.js';
import type { SummaryStore } from './summary-store.js';
import type { GrepResult, DescribeResult, ExpandResult } from './types.js';

export class RetrievalEngine {
  constructor(
    private conversationStore: ConversationStore,
    private summaryStore: SummaryStore
  ) {}

  /**
   * Full-text or LIKE search across all stored messages.
   */
  grep(query: string, conversationId?: string, limit = 50): GrepResult[] {
    const messages = this.conversationStore.search(query, conversationId, limit);
    return messages.map((m) => {
      const conv = this.conversationStore.getConversation(m.conversationId);
      return {
        messageId: m.id,
        conversationId: m.conversationId,
        sessionId: conv?.sessionId ?? '',
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        sequenceNumber: m.sequenceNumber,
      };
    });
  }

  /**
   * Get metadata + content for a summary or message by ID.
   */
  describe(id: string): DescribeResult | null {
    if (id.startsWith('sum_')) {
      const summary = this.summaryStore.getSummary(id);
      if (!summary) return null;
      const childCount = this.summaryStore.getChildCount(id);
      return {
        id: summary.id,
        type: 'summary',
        content: summary.content,
        tokenCount: summary.tokenCount,
        level: summary.level,
        parentId: summary.parentId,
        childCount,
        messageRangeStart: summary.messageRangeStart,
        messageRangeEnd: summary.messageRangeEnd,
        createdAt: summary.createdAt,
      };
    }

    if (id.startsWith('msg_')) {
      const message = this.conversationStore.getMessage(id);
      if (!message) return null;
      return {
        id: message.id,
        type: 'message',
        content: message.content,
        tokenCount: message.tokenCount,
        createdAt: message.timestamp,
      };
    }

    return null;
  }

  /**
   * Expand a summary: retrieve its source messages and child summaries.
   * Respects a token budget.
   */
  expand(summaryId: string, depth = 1, tokenCap = 8000): ExpandResult {
    const summary = this.summaryStore.getSummary(summaryId);
    if (!summary) {
      return { summaryId, messages: [], childSummaries: [], truncated: false, totalTokens: 0 };
    }

    const messageIds = this.summaryStore.getMessageIdsForSummary(summaryId);
    const childSummaries = this.summaryStore.getChildSummaries(summaryId);

    let totalTokens = 0;
    const messages = [];
    let truncated = false;

    for (const msgId of messageIds) {
      const msg = this.conversationStore.getMessage(msgId);
      if (!msg) continue;
      if (totalTokens + msg.tokenCount > tokenCap) {
        truncated = true;
        break;
      }
      messages.push(msg);
      totalTokens += msg.tokenCount;
    }

    // Also get messages by sequence range if not linked directly
    if (messages.length === 0 && summary.conversationId) {
      const rangeMessages = this.conversationStore.getMessages(
        summary.conversationId,
        summary.messageRangeStart,
        summary.messageRangeEnd
      );
      for (const msg of rangeMessages) {
        if (totalTokens + msg.tokenCount > tokenCap) {
          truncated = true;
          break;
        }
        messages.push(msg);
        totalTokens += msg.tokenCount;
      }
    }

    return { summaryId, messages, childSummaries, truncated, totalTokens };
  }

  /**
   * Combined: search then expand relevant summaries.
   */
  expandQuery(query: string, maxResults = 5, tokenCap = 8000): ExpandResult[] {
    const grepResults = this.grep(query, undefined, maxResults);
    if (grepResults.length === 0) return [];

    // Find summaries that cover the matched messages
    const results: ExpandResult[] = [];
    const seenConvIds = new Set<string>();

    for (const match of grepResults) {
      if (seenConvIds.has(match.conversationId)) continue;
      seenConvIds.add(match.conversationId);

      const summaries = this.summaryStore.getSummariesForConversation(match.conversationId, 0);
      const relevant = summaries.filter(
        (s) =>
          s.messageRangeStart <= match.sequenceNumber &&
          s.messageRangeEnd >= match.sequenceNumber
      );

      if (relevant.length > 0) {
        const summary = relevant[0]!;
        results.push(this.expand(summary.id, 1, Math.floor(tokenCap / maxResults)));
      } else {
        // No summary covers it — return the message directly
        const msg = this.conversationStore.getMessage(match.messageId);
        if (msg) {
          results.push({
            summaryId: null,
            isFallback: true,
            messages: [msg],
            childSummaries: [],
            truncated: false,
            totalTokens: msg.tokenCount,
          });
        }
      }
    }

    return results;
  }
}
