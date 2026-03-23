import { randomUUID } from 'node:crypto';
function rowToSummary(row) {
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
    db;
    constructor(db) {
        this.db = db;
    }
    insertSummary(summary) {
        const id = `sum_${randomUUID()}`;
        const createdAt = Date.now();
        this.db.prepare(`INSERT INTO summaries
         (id, conversation_id, parent_id, level, content, token_count,
          message_range_start, message_range_end, created_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, summary.conversationId, summary.parentId ?? null, summary.level, summary.content, summary.tokenCount, summary.messageRangeStart, summary.messageRangeEnd, createdAt, summary.metadata ? JSON.stringify(summary.metadata) : null);
        return { ...summary, id, createdAt };
    }
    linkSummaryToMessages(summaryId, messageIds) {
        const stmt = this.db.prepare('INSERT OR IGNORE INTO summary_messages (summary_id, message_id) VALUES (?, ?)');
        for (const msgId of messageIds) {
            stmt.run(summaryId, msgId);
        }
    }
    getSummary(summaryId) {
        const row = this.db.prepare('SELECT * FROM summaries WHERE id = ?').get(summaryId);
        return row ? rowToSummary(row) : null;
    }
    getSummariesForConversation(conversationId, level) {
        let sql = 'SELECT * FROM summaries WHERE conversation_id = ?';
        const params = [conversationId];
        if (level !== undefined) {
            sql += ' AND level = ?';
            params.push(level);
        }
        sql += ' ORDER BY message_range_start ASC';
        const rows = this.db.prepare(sql).all(...params);
        return rows.map(rowToSummary);
    }
    getChildSummaries(parentId) {
        const rows = this.db.prepare('SELECT * FROM summaries WHERE parent_id = ? ORDER BY message_range_start ASC').all(parentId);
        return rows.map(rowToSummary);
    }
    getChildCount(summaryId) {
        const row = this.db.prepare('SELECT COUNT(*) AS cnt FROM summaries WHERE parent_id = ?').get(summaryId);
        return row.cnt;
    }
    getMessageIdsForSummary(summaryId) {
        const rows = this.db.prepare('SELECT message_id FROM summary_messages WHERE summary_id = ?').all(summaryId);
        return rows.map((r) => r.message_id);
    }
    /** Get the highest compacted sequence number for a conversation */
    getMaxCompactedSequence(conversationId) {
        const row = this.db.prepare('SELECT COALESCE(MAX(message_range_end), -1) AS max_seq FROM summaries WHERE conversation_id = ? AND level = 0').get(conversationId);
        return row.max_seq;
    }
    /** Get top-N summaries by level for context injection (most condensed first) */
    getTopSummaries(conversationId, tokenBudget) {
        const rows = this.db.prepare('SELECT * FROM summaries WHERE conversation_id = ? ORDER BY level DESC, message_range_end DESC').all(conversationId);
        const selected = [];
        let tokensUsed = 0;
        for (const row of rows) {
            if (tokensUsed + row.token_count > tokenBudget)
                break;
            selected.push(rowToSummary(row));
            tokensUsed += row.token_count;
        }
        return selected;
    }
    // --- Context Items ---
    insertContextItem(item) {
        const id = `ctx_${randomUUID()}`;
        const createdAt = Date.now();
        this.db.prepare(`INSERT INTO context_items (id, conversation_id, category, content, importance, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, item.conversationId, item.category, item.content, item.importance, createdAt, item.expiresAt ?? null);
        return { ...item, id, createdAt };
    }
    getContextItems(conversationId, minImportance = 0.0) {
        const rows = this.db.prepare(`SELECT * FROM context_items
       WHERE conversation_id = ? AND importance >= ?
       AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY importance DESC`).all(conversationId, minImportance, Date.now());
        return rows.map((r) => ({
            id: r.id,
            conversationId: r.conversation_id,
            category: r.category,
            content: r.content,
            importance: r.importance,
            createdAt: r.created_at,
            expiresAt: r.expires_at ?? undefined,
        }));
    }
    // --- Transcript Cursors ---
    getCursor(sessionId) {
        const row = this.db.prepare('SELECT * FROM transcript_cursors WHERE session_id = ?').get(sessionId);
        return row
            ? { sessionId: row.session_id, byteOffset: row.byte_offset, lastTimestamp: row.last_timestamp }
            : null;
    }
    upsertCursor(cursor) {
        this.db.prepare(`INSERT INTO transcript_cursors (session_id, byte_offset, last_timestamp)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         byte_offset = excluded.byte_offset,
         last_timestamp = excluded.last_timestamp`).run(cursor.sessionId, cursor.byteOffset, cursor.lastTimestamp);
    }
}
//# sourceMappingURL=summary-store.js.map