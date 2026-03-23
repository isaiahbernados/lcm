/**
 * Common message ingestion logic shared by multiple hook handlers.
 * Reads new transcript entries and stores them in the ConversationStore.
 */
import type { ConversationStore } from '../core/conversation-store.js';
import type { SummaryStore } from '../core/summary-store.js';
export declare function ingestNewMessages(transcriptPath: string, sessionId: string, projectPath: string, conversationStore: ConversationStore, summaryStore: SummaryStore): Promise<{
    messagesIngested: number;
}>;
//# sourceMappingURL=ingest.d.ts.map