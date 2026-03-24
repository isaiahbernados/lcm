import type { Db } from '../db/connection.js';
import type { LcmFile, FileType } from './types.js';
import { randomUUID } from 'node:crypto';

interface FileRow {
  id: string;
  message_id: string;
  conversation_id: string;
  file_path: string | null;
  file_type: string;
  raw_token_count: number;
  content_preview: string;
  exploration_summary: string | null;
  created_at: number;
}

function rowToFile(row: FileRow): LcmFile {
  return {
    id: row.id,
    messageId: row.message_id,
    conversationId: row.conversation_id,
    filePath: row.file_path,
    fileType: row.file_type as FileType,
    rawTokenCount: row.raw_token_count,
    contentPreview: row.content_preview,
    explorationSummary: row.exploration_summary,
    createdAt: row.created_at,
  };
}

export interface InsertFileParams {
  messageId: string;
  conversationId: string;
  filePath?: string | null;
  fileType: FileType;
  rawTokenCount: number;
  contentPreview: string;
  explorationSummary?: string | null;
}

export class FileStore {
  constructor(private db: Db) {}

  insertFile(params: InsertFileParams): LcmFile {
    const id = `file_${randomUUID()}`;
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO files (id, message_id, conversation_id, file_path, file_type, raw_token_count, content_preview, exploration_summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      params.messageId,
      params.conversationId,
      params.filePath ?? null,
      params.fileType,
      params.rawTokenCount,
      params.contentPreview,
      params.explorationSummary ?? null,
      now
    );
    return {
      id,
      messageId: params.messageId,
      conversationId: params.conversationId,
      filePath: params.filePath ?? null,
      fileType: params.fileType,
      rawTokenCount: params.rawTokenCount,
      contentPreview: params.contentPreview,
      explorationSummary: params.explorationSummary ?? null,
      createdAt: now,
    };
  }

  getFile(fileId: string): LcmFile | null {
    const row = this.db.prepare(
      'SELECT * FROM files WHERE id = ?'
    ).get(fileId) as unknown as FileRow | undefined;
    return row ? rowToFile(row) : null;
  }

  getFilesForConversation(conversationId: string): LcmFile[] {
    const rows = this.db.prepare(
      'SELECT * FROM files WHERE conversation_id = ? ORDER BY created_at ASC'
    ).all(conversationId) as unknown as FileRow[];
    return rows.map(rowToFile);
  }

  updateExplorationSummary(fileId: string, summary: string): void {
    this.db.prepare(
      'UPDATE files SET exploration_summary = ? WHERE id = ?'
    ).run(summary, fileId);
  }
}
