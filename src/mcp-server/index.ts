#!/usr/bin/env node
/**
 * LCM MCP Server — stdio transport.
 *
 * Exposes lcm_grep, lcm_describe, lcm_expand, lcm_expand_query as MCP tools
 * so Claude can search and retrieve its full conversation history.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { getDb } from '../db/connection.js';
import { runMigrations } from '../db/migration.js';
import { loadConfig } from '../db/config.js';
import { ConversationStore } from '../core/conversation-store.js';
import { SummaryStore } from '../core/summary-store.js';
import { RetrievalEngine } from '../core/retrieval-engine.js';
import { tools } from './tools.js';
import { logger } from '../utils/logger.js';

async function main() {
  const config = loadConfig();
  const db = getDb(config.databasePath);
  runMigrations(db);

  const conversationStore = new ConversationStore(db);
  const summaryStore = new SummaryStore(db);
  const engine = new RetrievalEngine(conversationStore, summaryStore);

  const server = new Server(
    { name: 'lcm', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = tools.find((t) => t.name === name);

    if (!tool) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    try {
      const result = tool.handler(args ?? {}, engine);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      logger.error('Tool handler error', { tool: name, err: String(err) });
      return {
        content: [{ type: 'text', text: `Error: ${String(err)}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('LCM MCP server started');
}

main().catch((err) => {
  logger.error('MCP server fatal error', err);
  process.exit(1);
});
