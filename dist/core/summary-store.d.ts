import type { Db } from '../db/connection.js';
import type { LcmSummary, LcmContextItem, TranscriptCursor } from './types.js';
export declare class SummaryStore {
    private db;
    constructor(db: Db);
    insertSummary(summary: Omit<LcmSummary, 'id' | 'createdAt'>): LcmSummary;
    linkSummaryToMessages(summaryId: string, messageIds: string[]): void;
    getSummary(summaryId: string): LcmSummary | null;
    getSummariesForConversation(conversationId: string, level?: number): LcmSummary[];
    getChildSummaries(parentId: string): LcmSummary[];
    getChildCount(summaryId: string): number;
    getMessageIdsForSummary(summaryId: string): string[];
    /** Get the highest compacted sequence number for a conversation */
    getMaxCompactedSequence(conversationId: string): number;
    /** Get top-N summaries by level for context injection (most condensed first) */
    getTopSummaries(conversationId: string, tokenBudget: number): LcmSummary[];
    insertContextItem(item: Omit<LcmContextItem, 'id' | 'createdAt'>): LcmContextItem;
    getContextItems(conversationId: string, minImportance?: number): LcmContextItem[];
    getCursor(sessionId: string): TranscriptCursor | null;
    upsertCursor(cursor: TranscriptCursor): void;
}
//# sourceMappingURL=summary-store.d.ts.map