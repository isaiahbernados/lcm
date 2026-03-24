import type { Db } from '../db/connection.js';
import type { LcmSummary, LcmContextItem, TranscriptCursor } from './types.js';
import { randomUUID } from 'node:crypto';

interface SummaryRow {
  id: string;
  conversation_id: string;
  parent_id: string | null;
  level: number;
  content: string;
  token_count: number;
  message_range_start: number;
  message_range_end: number;
  created_at: number;
  metadata: string | null;
}

interface ContextItemRow {
  id: string;
  conversation_id: string;
  category: string;
  content: string;
  importance: number;
  created_at: number;
  expires_at: number | null;
}

interface CursorRow {
  session_id: string;
  byte_offset: number;
  last_timestamp: number;
}

function rowToSummary(row: SummaryRow): LcmSummary {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    parentId: row.parent_id,
    level: row.level,
    content: row.content,
    tokenCount: row.token_count,
    messageRangeStart: row.message_range_start,
    messageRangeEnd: row.message_range_end,
    createdAt: row.created_at,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
  };
}

export class SummaryStore {
  constructor(private db: Db) {}

  insertSummary(summary: Omit<LcmSummary, 'id' | 'createdAt'>): LcmSummary {
    const id = `sum_${randomUUID()}`;
    const createdAt = Date.now();
    this.db.prepare(
      `INSERT INTO summaries
         (id, conversation_id, parent_id, level, content, token_count,
          message_range_start, message_range_end, created_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      summary.conversationId,
      summary.parentId ?? null,
      summary.level,
      summary.content,
      summary.tokenCount,
      summary.messageRangeStart,
      summary.messageRangeEnd,
      createdAt,
      summary.metadata ? JSON.stringify(summary.metadata) : null
    );
    return { ...summary, id, createdAt };
  }

  linkSummaryToMessages(summaryId: string, messageIds: string[]): void {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO summary_messages (summary_id, message_id) VALUES (?, ?)'
    );
    for (const msgId of messageIds) {
      stmt.run(summaryId, msgId);
    }
  }

  getSummary(summaryId: string): LcmSummary | null {
    const row = this.db.prepare('SELECT * FROM summaries WHERE id = ?').get(summaryId) as unknown as SummaryRow | undefined;
    return row ? rowToSummary(row) : null;
  }

  getSummariesForConversation(conversationId: string, level?: number): LcmSummary[] {
    let sql = 'SELECT * FROM summaries WHERE conversation_id = ?';
    const params: (string | number)[] = [conversationId];
    if (level !== undefined) { sql += ' AND level = ?'; params.push(level); }
    sql += ' ORDER BY message_range_start ASC';
    const rows = this.db.prepare(sql).all(...params) as unknown as SummaryRow[];
    return rows.map(rowToSummary);
  }

  getChildSummaries(parentId: string): LcmSummary[] {
    const rows = this.db.prepare(
      'SELECT * FROM summaries WHERE parent_id = ? ORDER BY message_range_start ASC'
    ).all(parentId) as unknown as SummaryRow[];
    return rows.map(rowToSummary);
  }

  getChildCount(summaryId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS cnt FROM summaries WHERE parent_id = ?'
    ).get(summaryId) as unknown as { cnt: number };
    return row.cnt;
  }

  getMessageIdsForSummary(summaryId: string): string[] {
    const rows = this.db.prepare(
      'SELECT message_id FROM summary_messages WHERE summary_id = ?'
    ).all(summaryId) as unknown as Array<{ message_id: string }>;
    return rows.map((r) => r.message_id);
  }

  updateParentId(summaryId: string, parentId: string): void {
    this.db.prepare('UPDATE summaries SET parent_id = ? WHERE id = ?').run(parentId, summaryId);
  }

  /** Get the highest compacted sequence number for a conversation */
  getMaxCompactedSequence(conversationId: string): number {
    const row = this.db.prepare(
      'SELECT COALESCE(MAX(message_range_end), -1) AS max_seq FROM summaries WHERE conversation_id = ? AND level = 0'
    ).get(conversationId) as unknown as { max_seq: number };
    return row.max_seq;
  }

  /** Get top-N summaries by level for context injection (most condensed first) */
  getTopSummaries(conversationId: string, tokenBudget: number): LcmSummary[] {
    const rows = this.db.prepare(
      'SELECT * FROM summaries WHERE conversation_id = ? ORDER BY level DESC, message_range_end DESC'
    ).all(conversationId) as unknown as SummaryRow[];

    const selected: LcmSummary[] = [];
    let tokensUsed = 0;
    for (const row of rows) {
      if (tokensUsed + row.token_count > tokenBudget) break;
      selected.push(rowToSummary(row));
      tokensUsed += row.token_count;
    }
    return selected;
  }

  // --- Context Items ---

  insertContextItem(item: Omit<LcmContextItem, 'id' | 'createdAt'>): LcmContextItem {
    const id = `ctx_${randomUUID()}`;
    const createdAt = Date.now();
    this.db.prepare(
      `INSERT INTO context_items (id, conversation_id, category, content, importance, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, item.conversationId, item.category, item.content, item.importance, createdAt, item.expiresAt ?? null);
    return { ...item, id, createdAt };
  }

  getContextItems(conversationId: string, minImportance = 0.0): LcmContextItem[] {
    const rows = this.db.prepare(
      `SELECT * FROM context_items
       WHERE conversation_id = ? AND importance >= ?
       AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY importance DESC`
    ).all(conversationId, minImportance, Date.now()) as unknown as ContextItemRow[];
    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      category: r.category as LcmContextItem['category'],
      content: r.content,
      importance: r.importance,
      createdAt: r.created_at,
      expiresAt: r.expires_at ?? undefined,
    }));
  }

  // --- Transcript Cursors ---

  getCursor(sessionId: string): TranscriptCursor | null {
    const row = this.db.prepare(
      'SELECT * FROM transcript_cursors WHERE session_id = ?'
    ).get(sessionId) as unknown as CursorRow | undefined;
    return row
      ? { sessionId: row.session_id, byteOffset: row.byte_offset, lastTimestamp: row.last_timestamp }
      : null;
  }

  upsertCursor(cursor: TranscriptCursor): void {
    this.db.prepare(
      `INSERT INTO transcript_cursors (session_id, byte_offset, last_timestamp)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         byte_offset = excluded.byte_offset,
         last_timestamp = excluded.last_timestamp`
    ).run(cursor.sessionId, cursor.byteOffset, cursor.lastTimestamp);
  }
}
