import type { Db } from '../db/connection.js';
import type { LcmConversation, LcmMessage, MessageRole } from './types.js';
import { randomUUID } from 'node:crypto';

interface ConversationRow {
  id: string;
  session_id: string;
  project_path: string;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  token_count: number;
  sequence_number: number;
  timestamp: number;
  metadata: string | null;
  rowid?: number;
}

function rowToConversation(row: ConversationRow): LcmConversation {
  return {
    id: row.id,
    sessionId: row.session_id,
    projectPath: row.project_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMessage(row: MessageRow): LcmMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as MessageRole,
    content: row.content,
    tokenCount: row.token_count,
    sequenceNumber: row.sequence_number,
    timestamp: row.timestamp,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
  };
}

export class ConversationStore {
  constructor(private db: Db) {}

  getOrCreateConversation(sessionId: string, projectPath: string): LcmConversation {
    const existing = this.db.prepare(
      'SELECT * FROM conversations WHERE session_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(sessionId) as unknown as ConversationRow | undefined;

    if (existing) return rowToConversation(existing);

    const now = Date.now();
    const id = `conv_${randomUUID()}`;
    this.db.prepare(
      'INSERT INTO conversations (id, session_id, project_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, sessionId, projectPath, now, now);

    return { id, sessionId, projectPath, createdAt: now, updatedAt: now };
  }

  getConversation(conversationId: string): LcmConversation | null {
    const row = this.db.prepare(
      'SELECT * FROM conversations WHERE id = ?'
    ).get(conversationId) as unknown as ConversationRow | undefined;
    return row ? rowToConversation(row) : null;
  }

  getConversationBySession(sessionId: string): LcmConversation | null {
    const row = this.db.prepare(
      'SELECT * FROM conversations WHERE session_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(sessionId) as unknown as ConversationRow | undefined;
    return row ? rowToConversation(row) : null;
  }

  touchConversation(conversationId: string): void {
    this.db.prepare(
      'UPDATE conversations SET updated_at = ? WHERE id = ?'
    ).run(Date.now(), conversationId);
  }

  /** Returns the next sequence number for a conversation */
  nextSequenceNumber(conversationId: string): number {
    const row = this.db.prepare(
      'SELECT COALESCE(MAX(sequence_number), -1) + 1 AS next FROM messages WHERE conversation_id = ?'
    ).get(conversationId) as unknown as { next: number };
    return row.next;
  }

  insertMessage(msg: Omit<LcmMessage, 'id' | 'sequenceNumber'>): LcmMessage {
    const id = `msg_${randomUUID()}`;
    const seqNum = this.nextSequenceNumber(msg.conversationId);
    this.db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, token_count, sequence_number, timestamp, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      msg.conversationId,
      msg.role,
      msg.content,
      msg.tokenCount,
      seqNum,
      msg.timestamp,
      msg.metadata ? JSON.stringify(msg.metadata) : null
    );
    return { ...msg, id, sequenceNumber: seqNum };
  }

  insertMessages(msgs: Array<Omit<LcmMessage, 'id' | 'sequenceNumber'>>): LcmMessage[] {
    const results: LcmMessage[] = [];
    for (const msg of msgs) {
      results.push(this.insertMessage(msg));
    }
    return results;
  }

  getMessages(conversationId: string, fromSeq?: number, toSeq?: number): LcmMessage[] {
    let sql = 'SELECT * FROM messages WHERE conversation_id = ?';
    const params: (string | number)[] = [conversationId];
    if (fromSeq !== undefined) { sql += ' AND sequence_number >= ?'; params.push(fromSeq); }
    if (toSeq !== undefined) { sql += ' AND sequence_number <= ?'; params.push(toSeq); }
    sql += ' ORDER BY sequence_number ASC';
    const rows = this.db.prepare(sql).all(...params) as unknown as MessageRow[];
    return rows.map(rowToMessage);
  }

  getMessage(messageId: string): LcmMessage | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as unknown as MessageRow | undefined;
    return row ? rowToMessage(row) : null;
  }

  getMessageCount(conversationId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS cnt FROM messages WHERE conversation_id = ?'
    ).get(conversationId) as unknown as { cnt: number };
    return row.cnt;
  }

  /**
   * Full-text search using FTS5. Falls back to LIKE if FTS fails.
   */
  search(query: string, conversationId?: string, limit = 50): LcmMessage[] {
    try {
      let sql = `
        SELECT m.* FROM messages m
        INNER JOIN messages_fts f ON f.rowid = m.rowid
        WHERE messages_fts MATCH ?
      `;
      const params: (string | number)[] = [query];
      if (conversationId) { sql += ' AND m.conversation_id = ?'; params.push(conversationId); }
      sql += ' ORDER BY m.timestamp DESC LIMIT ?';
      params.push(limit);
      const rows = this.db.prepare(sql).all(...params) as unknown as MessageRow[];
      return rows.map(rowToMessage);
    } catch {
      // FTS fallback: simple LIKE
      let sql = 'SELECT * FROM messages WHERE content LIKE ?';
      const params: (string | number)[] = [`%${query}%`];
      if (conversationId) { sql += ' AND conversation_id = ?'; params.push(conversationId); }
      sql += ' ORDER BY timestamp DESC LIMIT ?';
      params.push(limit);
      const rows = this.db.prepare(sql).all(...params) as unknown as MessageRow[];
      return rows.map(rowToMessage);
    }
  }
}
