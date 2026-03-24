/**
 * Common message ingestion logic shared by multiple hook handlers.
 * Reads new transcript entries and stores them in the ConversationStore.
 */

import { readNewTranscriptEntries, estimateTokens } from '../core/transcript-reader.js';
import type { ConversationStore } from '../core/conversation-store.js';
import type { SummaryStore } from '../core/summary-store.js';
import type { FileStore } from '../core/file-store.js';
import { detectFileType, generateExplorationSummary } from '../core/file-analyzer.js';
import { logger } from '../utils/logger.js';

export async function ingestNewMessages(
  transcriptPath: string,
  sessionId: string,
  projectPath: string,
  conversationStore: ConversationStore,
  summaryStore: SummaryStore,
  fileStore?: FileStore,
  largeFileThreshold?: number,
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

  const threshold = largeFileThreshold ?? 25000;
  const now = Date.now();
  for (const msg of messages) {
    try {
      const tokenCount = estimateTokens(msg.content);
      const inserted = conversationStore.insertMessage({
        conversationId: conversation.id,
        role: msg.role,
        content: msg.content,
        tokenCount,
        timestamp: msg.timestamp || now,
        metadata: msg.metadata,
      });

      // Detect large tool_result messages and store as files
      if (fileStore && msg.role === 'tool_result' && tokenCount > threshold) {
        try {
          const fileType = detectFileType(msg.content);
          const explorationSummary = generateExplorationSummary(msg.content, fileType);
          const contentPreview = msg.content.slice(0, 500);
          fileStore.insertFile({
            messageId: inserted.id,
            conversationId: conversation.id,
            filePath: null,
            fileType,
            rawTokenCount: tokenCount,
            contentPreview,
            explorationSummary,
          });
          logger.debug('Large file detected and stored', { messageId: inserted.id, fileType, tokenCount });
        } catch (fileErr) {
          logger.warn('Failed to store large file metadata', { fileErr, messageId: inserted.id });
        }
      }
    } catch (err) {
      logger.warn('Failed to insert message', { err, role: msg.role });
    }
  }

  summaryStore.upsertCursor(updatedCursor);
  conversationStore.touchConversation(conversation.id);

  logger.debug('Ingested messages', { count: messages.length, sessionId });
  return { messagesIngested: messages.length };
}
