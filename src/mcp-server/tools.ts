/**
 * MCP tool definitions and handlers for LCM retrieval and self-managed compaction.
 */

import type { RetrievalEngine } from '../core/retrieval-engine.js';
import type { SummaryStore } from '../core/summary-store.js';
import type { ConversationStore } from '../core/conversation-store.js';
import { estimateTokens } from '../core/transcript-reader.js';

export interface ToolContext {
  engine: RetrievalEngine;
  summaryStore: SummaryStore;
  conversationStore: ConversationStore;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => unknown;
}

export const tools: ToolDefinition[] = [
  {
    name: 'lcm_grep',
    description:
      'Search the full conversation history preserved by LCM. Use this when you need to find something from earlier in the conversation that may have been compacted. Returns matching messages with context.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (full-text or keyword)',
        },
        conversation_id: {
          type: 'string',
          description: 'Limit search to a specific conversation ID (optional)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (1-200, default 20)',
          minimum: 1,
          maximum: 200,
        },
      },
      required: ['query'],
    },
    handler(args, { engine }) {
      const query = args['query'] as string;
      const conversationId = args['conversation_id'] as string | undefined;
      const limit = Math.min(200, Math.max(1, (args['limit'] as number | undefined) ?? 20));

      const results = engine.grep(query, conversationId, limit);
      if (results.length === 0) {
        return { found: false, message: `No results found for: ${query}` };
      }

      return {
        found: true,
        count: results.length,
        results: results.map((r) => ({
          id: r.messageId,
          role: r.role,
          content: r.content.length > 500 ? r.content.slice(0, 500) + '…' : r.content,
          timestamp: new Date(r.timestamp).toISOString(),
          sequence: r.sequenceNumber,
          conversationId: r.conversationId,
        })),
      };
    },
  },

  {
    name: 'lcm_describe',
    description:
      'Get metadata and content for a specific LCM summary or message by its ID. Use after lcm_grep to inspect a specific item.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The ID of the summary (sum_...) or message (msg_...) to describe',
        },
      },
      required: ['id'],
    },
    handler(args, { engine }) {
      const id = args['id'] as string;
      const result = engine.describe(id);
      if (!result) {
        return { found: false, message: `No item found with ID: ${id}` };
      }
      return { found: true, ...result };
    },
  },

  {
    name: 'lcm_expand',
    description:
      'Retrieve the original messages that were compacted into a summary. Use when you need full details behind a summary.',
    inputSchema: {
      type: 'object',
      properties: {
        summary_id: {
          type: 'string',
          description: 'The summary ID (sum_...) to expand',
        },
        depth: {
          type: 'number',
          description: 'How many levels of summaries to expand (default 1, max 5)',
          minimum: 1,
          maximum: 5,
        },
        token_cap: {
          type: 'number',
          description: 'Maximum tokens to return (default 8000)',
        },
      },
      required: ['summary_id'],
    },
    handler(args, { engine }) {
      const summaryId = args['summary_id'] as string;
      const depth = Math.min(5, Math.max(1, (args['depth'] as number | undefined) ?? 1));
      const tokenCap = (args['token_cap'] as number | undefined) ?? 8000;

      const result = engine.expand(summaryId, depth, tokenCap);
      return {
        summaryId: result.summaryId,
        messageCount: result.messages.length,
        truncated: result.truncated,
        totalTokens: result.totalTokens,
        messages: result.messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          timestamp: new Date(m.timestamp).toISOString(),
          sequence: m.sequenceNumber,
        })),
        childSummaries: result.childSummaries.map((s) => ({
          id: s.id,
          level: s.level,
          content: s.content.length > 200 ? s.content.slice(0, 200) + '…' : s.content,
        })),
      };
    },
  },

  {
    name: 'lcm_expand_query',
    description:
      'Search for content and immediately expand the relevant summaries to retrieve original messages. Combines lcm_grep and lcm_expand in one step.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query to find relevant conversation history',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of summary expansions (default 3)',
          minimum: 1,
          maximum: 10,
        },
        token_cap: {
          type: 'number',
          description: 'Total token budget for results (default 8000)',
        },
      },
      required: ['query'],
    },
    handler(args, { engine }) {
      const query = args['query'] as string;
      const maxResults = Math.min(10, Math.max(1, (args['max_results'] as number | undefined) ?? 3));
      const tokenCap = (args['token_cap'] as number | undefined) ?? 8000;

      const results = engine.expandQuery(query, maxResults, tokenCap);
      if (results.length === 0) {
        return { found: false, message: `No history found for: ${query}` };
      }

      return {
        found: true,
        expansions: results.map((r) => ({
          summaryId: r.summaryId,
          messageCount: r.messages.length,
          truncated: r.truncated,
          messages: r.messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            timestamp: new Date(m.timestamp).toISOString(),
          })),
        })),
      };
    },
  },

  {
    name: 'lcm_request_compact',
    description:
      'Returns accumulated summaries that are ready to be condensed into a higher-level summary. Call this when you want to compress your stored history. After receiving the summaries, condense them into a single concise summary and call lcm_store_summary with the result.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: {
          type: 'string',
          description: 'Conversation ID to compact (optional — uses current session if omitted)',
        },
        min_summaries: {
          type: 'number',
          description: 'Minimum number of summaries required before compacting (default 4)',
        },
      },
    },
    handler(args, { summaryStore, conversationStore }) {
      const conversationId = args['conversation_id'] as string | undefined;
      const minSummaries = (args['min_summaries'] as number | undefined) ?? 4;

      // Find the conversation
      let convId = conversationId;
      if (!convId) {
        // Return all conversations with compactable summaries
        return { ready: false, message: 'Provide a conversation_id to compact.' };
      }

      // Get leaf summaries without a parent (not yet condensed)
      const leafSummaries = summaryStore
        .getSummariesForConversation(convId, 0)
        .filter((s) => s.parentId === null);

      if (leafSummaries.length < minSummaries) {
        return {
          ready: false,
          message: `Only ${leafSummaries.length} leaf summaries exist (need ${minSummaries} to compact).`,
          summaryCount: leafSummaries.length,
        };
      }

      return {
        ready: true,
        conversationId: convId,
        summaryCount: leafSummaries.length,
        instruction:
          'Please condense the following summaries into a single concise summary that preserves all key decisions, facts, and context. Then call lcm_store_summary with your condensed result.',
        summaries: leafSummaries.map((s) => ({
          id: s.id,
          level: s.level,
          messageRange: `${s.messageRangeStart}-${s.messageRangeEnd}`,
          content: s.content,
        })),
      };
    },
  },

  {
    name: 'lcm_store_summary',
    description:
      'Store a summary you have generated into LCM\'s persistent memory. Use after lcm_request_compact — condense the provided summaries and call this with your result.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: {
          type: 'string',
          description: 'The conversation ID this summary belongs to',
        },
        content: {
          type: 'string',
          description: 'The summary text you generated',
        },
        source_summary_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'IDs of the summaries you condensed (from lcm_request_compact)',
        },
        level: {
          type: 'number',
          description: 'DAG level: 1 = condensed from leaf summaries, 2+ = higher condensation',
        },
      },
      required: ['conversation_id', 'content', 'source_summary_ids'],
    },
    handler(args, { summaryStore }) {
      const conversationId = args['conversation_id'] as string;
      const content = args['content'] as string;
      const sourceSummaryIds = args['source_summary_ids'] as string[];
      const level = (args['level'] as number | undefined) ?? 1;

      // Determine message range from source summaries
      const sources = sourceSummaryIds
        .map((id) => summaryStore.getSummary(id))
        .filter((s): s is NonNullable<typeof s> => s !== null);

      if (sources.length === 0) {
        return { success: false, message: 'No valid source summary IDs found.' };
      }

      const rangeStart = Math.min(...sources.map((s) => s.messageRangeStart));
      const rangeEnd = Math.max(...sources.map((s) => s.messageRangeEnd));

      const stored = summaryStore.insertSummary({
        conversationId,
        parentId: null,
        level,
        content,
        tokenCount: estimateTokens(content),
        messageRangeStart: rangeStart,
        messageRangeEnd: rangeEnd,
        metadata: { sourceSummaryIds },
      });

      return {
        success: true,
        summaryId: stored.id,
        level: stored.level,
        tokenCount: stored.tokenCount,
        messageRange: `${rangeStart}-${rangeEnd}`,
        message: `Summary stored as ${stored.id}. It will be injected into context after the next compaction.`,
      };
    },
  },
];
