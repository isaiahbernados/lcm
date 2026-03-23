/**
 * Retrieval engine — search, describe, and expand stored history.
 * Adapted from lossless-claw's RetrievalEngine.
 */
import type { ConversationStore } from './conversation-store.js';
import type { SummaryStore } from './summary-store.js';
import type { GrepResult, DescribeResult, ExpandResult } from './types.js';
export declare class RetrievalEngine {
    private conversationStore;
    private summaryStore;
    constructor(conversationStore: ConversationStore, summaryStore: SummaryStore);
    /**
     * Full-text or LIKE search across all stored messages.
     */
    grep(query: string, conversationId?: string, limit?: number): GrepResult[];
    /**
     * Get metadata + content for a summary or message by ID.
     */
    describe(id: string): DescribeResult | null;
    /**
     * Expand a summary: retrieve its source messages and child summaries.
     * Respects a token budget.
     */
    expand(summaryId: string, depth?: number, tokenCap?: number): ExpandResult;
    /**
     * Combined: search then expand relevant summaries.
     */
    expandQuery(query: string, maxResults?: number, tokenCap?: number): ExpandResult[];
}
//# sourceMappingURL=retrieval-engine.d.ts.map