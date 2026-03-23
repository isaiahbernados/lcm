import type { Db } from '../db/connection.js';
import type { LcmConversation, LcmMessage } from './types.js';
export declare class ConversationStore {
    private db;
    constructor(db: Db);
    getOrCreateConversation(sessionId: string, projectPath: string): LcmConversation;
    getConversation(conversationId: string): LcmConversation | null;
    getConversationBySession(sessionId: string): LcmConversation | null;
    touchConversation(conversationId: string): void;
    /** Returns the next sequence number for a conversation */
    nextSequenceNumber(conversationId: string): number;
    insertMessage(msg: Omit<LcmMessage, 'id' | 'sequenceNumber'>): LcmMessage;
    insertMessages(msgs: Array<Omit<LcmMessage, 'id' | 'sequenceNumber'>>): LcmMessage[];
    getMessages(conversationId: string, fromSeq?: number, toSeq?: number): LcmMessage[];
    getMessage(messageId: string): LcmMessage | null;
    getMessageCount(conversationId: string): number;
    /**
     * Full-text search using FTS5. Falls back to LIKE if FTS fails.
     */
    search(query: string, conversationId?: string, limit?: number): LcmMessage[];
}
//# sourceMappingURL=conversation-store.d.ts.map