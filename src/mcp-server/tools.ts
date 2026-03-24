/**
 * MCP tool definitions and handlers for LCM retrieval and self-managed compaction.
 */

import type { RetrievalEngine } from '../core/retrieval-engine.js';
import type { ConversationStore } from '../core/conversation-store.js';
import type { LcmConfig } from '../db/config.js';
import { llmMap } from '../core/llm-map.js';
import os from 'node:os';
import path from 'node:path';

export interface ToolContext {
  engine: RetrievalEngine;
  conversationStore: ConversationStore;
  config: LcmConfig;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => unknown | Promise<unknown>;
}

export const tools: ToolDefinition[] = [
  {
    name: 'lcm_grep',
    description:
      'Search the full conversation history preserved by LCM. Returns matching messages grouped by the summary node that currently covers them. Use an optional summary_id to restrict search to a specific summary\'s scope.',
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
        summary_id: {
          type: 'string',
          description: 'Restrict search to messages within this summary\'s scope (optional)',
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
      const summaryId = args['summary_id'] as string | undefined;
      const limit = Math.min(200, Math.max(1, (args['limit'] as number | undefined) ?? 20));

      const results = engine.grep(query, conversationId, limit, summaryId);
      if (results.length === 0) {
        return { found: false, message: `No results found for: ${query}` };
      }

      // Group results by covering summary (per LCM paper spec)
      const groups = new Map<string, typeof results>();
      for (const r of results) {
        const key = r.coveringSummaryId ?? '__uncovered__';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(r);
      }

      return {
        found: true,
        count: results.length,
        groups: Array.from(groups.entries()).map(([key, matches]) => ({
          summaryId: key === '__uncovered__' ? null : key,
          matches: matches.map((r) => ({
            id: r.messageId,
            role: r.role,
            content: r.content.length > 500 ? r.content.slice(0, 500) + '…' : r.content,
            timestamp: new Date(r.timestamp).toISOString(),
            sequence: r.sequenceNumber,
            conversationId: r.conversationId,
          })),
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
          summaryId: r.summaryId,            // null when direct message match
          isFallback: r.isFallback ?? false,
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
    name: 'lcm_llm_map',
    description:
      'Process each line of an input JSONL file through an LLM prompt template and write results to an output JSONL file. Each line is substituted into {{line}} in the prompt template. Supports concurrency control and optional JSON Schema validation of responses. Requires LCM_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY to be configured.',
    inputSchema: {
      type: 'object',
      properties: {
        input_path: {
          type: 'string',
          description: 'Absolute path to the input JSONL file (one record per line)',
        },
        prompt_template: {
          type: 'string',
          description: 'Prompt template with {{line}} placeholder that will be replaced by each input line',
        },
        output_path: {
          type: 'string',
          description: 'Absolute path for the output JSONL file (default: input_path with .out.jsonl suffix)',
        },
        model: {
          type: 'string',
          description: 'Anthropic model to use (default: claude-haiku-4-5-20251001)',
        },
        max_concurrency: {
          type: 'number',
          description: 'Maximum number of concurrent API calls (1-20, default 5)',
          minimum: 1,
          maximum: 20,
        },
        output_schema: {
          type: 'object',
          description: 'Optional JSON Schema to validate each response. If provided, responses are parsed as JSON and validated. On failure, one retry is attempted.',
        },
      },
      required: ['input_path', 'prompt_template'],
    },
    async handler(args, ctx) {
      const apiKey = ctx.config.anthropicApiKey;
      if (!apiKey) {
        throw new Error(
          'No Anthropic API key configured. Set LCM_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY environment variable.'
        );
      }

      const inputPath = args['input_path'] as string;
      const promptTemplate = args['prompt_template'] as string;
      const outputPath =
        (args['output_path'] as string | undefined) ??
        path.join(os.tmpdir(), path.basename(inputPath, path.extname(inputPath)) + '.out.jsonl');
      const model = args['model'] as string | undefined;
      const maxConcurrency = args['max_concurrency'] as number | undefined;
      const outputSchema = args['output_schema'] as Record<string, unknown> | undefined;

      return llmMap({
        inputPath,
        outputPath,
        promptTemplate,
        model,
        maxConcurrency,
        outputSchema,
        apiKey,
      });
    },
  },

];
