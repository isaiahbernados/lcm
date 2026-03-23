/**
 * MCP tool definitions and handlers for LCM retrieval and self-managed compaction.
 */
import type { RetrievalEngine } from '../core/retrieval-engine.js';
import type { SummaryStore } from '../core/summary-store.js';
import type { ConversationStore } from '../core/conversation-store.js';
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
export declare const tools: ToolDefinition[];
//# sourceMappingURL=tools.d.ts.map