/**
 * Common message ingestion logic shared by multiple hook handlers.
 * Reads new transcript entries and stores them in the ConversationStore.
 */

import { readNewTranscriptEntries, estimateTokens } from '../core/transcript-reader.js';
import type { ConversationStore } from '../core/conversation-store.js';
import type { SummaryStore } from '../core/summary-store.js';
import { logger } from '../utils/logger.js';

export async function ingestNewMessages(
  transcriptPath: string,
  sessionId: string,
  projectPath: string,
  conversationStore: ConversationStore,
  summaryStore: SummaryStore
): Promise<{ messagesIngested: number }> {
  if (!transcriptPath) return { messagesIngested: 0 };

  const conversation = conversationStore.getOrCreateConversation(sessionId, projectPath);

  const cursor = summaryStore.getCursor(sessionId) ?? {
    sessionId,
    byteOffset: 0,
    lastTimestamp: 0,
  };

  const { messages, updatedCursor } = readNewTranscriptEntries(transcriptPath, cursor);

  if (messages.length === 0) {
    return { messagesIngested: 0 };
  }

  const now = Date.now();
  for (const msg of messages) {
    try {
      conversationStore.insertMessage({
        conversationId: conversation.id,
        role: msg.role,
        content: msg.content,
        tokenCount: estimateTokens(msg.content),
        timestamp: msg.timestamp || now,
        metadata: msg.metadata,
      });
    } catch (err) {
      logger.warn('Failed to insert message', { err, role: msg.role });
    }
  }

  summaryStore.upsertCursor(updatedCursor);
  conversationStore.touchConversation(conversation.id);

  logger.debug('Ingested messages', { count: messages.length, sessionId });
  return { messagesIngested: messages.length };
}
