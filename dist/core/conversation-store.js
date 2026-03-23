import { randomUUID } from 'node:crypto';
function rowToConversation(row) {
    return {
        id: row.id,
        sessionId: row.session_id,
        projectPath: row.project_path,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
function rowToMessage(row) {
    return {
        id: row.id,
        conversationId: row.conversation_id,
        role: row.role,
        content: row.content,
        tokenCount: row.token_count,
        sequenceNumber: row.sequence_number,
        timestamp: row.timestamp,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
}
export class ConversationStore {
    db;
    constructor(db) {
        this.db = db;
    }
    getOrCreateConversation(sessionId, projectPath) {
        const existing = this.db.prepare('SELECT * FROM conversations WHERE session_id = ? ORDER BY created_at DESC LIMIT 1').get(sessionId);
        if (existing)
            return rowToConversation(existing);
        const now = Date.now();
        const id = `conv_${randomUUID()}`;
        this.db.prepare('INSERT INTO conversations (id, session_id, project_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, sessionId, projectPath, now, now);
        return { id, sessionId, projectPath, createdAt: now, updatedAt: now };
    }
    getConversation(conversationId) {
        const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
        return row ? rowToConversation(row) : null;
    }
    getConversationBySession(sessionId) {
        const row = this.db.prepare('SELECT * FROM conversations WHERE session_id = ? ORDER BY created_at DESC LIMIT 1').get(sessionId);
        return row ? rowToConversation(row) : null;
    }
    touchConversation(conversationId) {
        this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), conversationId);
    }
    /** Returns the next sequence number for a conversation */
    nextSequenceNumber(conversationId) {
        const row = this.db.prepare('SELECT COALESCE(MAX(sequence_number), -1) + 1 AS next FROM messages WHERE conversation_id = ?').get(conversationId);
        return row.next;
    }
    insertMessage(msg) {
        const id = `msg_${randomUUID()}`;
        const seqNum = this.nextSequenceNumber(msg.conversationId);
        this.db.prepare(`INSERT INTO messages (id, conversation_id, role, content, token_count, sequence_number, timestamp, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, msg.conversationId, msg.role, msg.content, msg.tokenCount, seqNum, msg.timestamp, msg.metadata ? JSON.stringify(msg.metadata) : null);
        return { ...msg, id, sequenceNumber: seqNum };
    }
    insertMessages(msgs) {
        const results = [];
        for (const msg of msgs) {
            results.push(this.insertMessage(msg));
        }
        return results;
    }
    getMessages(conversationId, fromSeq, toSeq) {
        let sql = 'SELECT * FROM messages WHERE conversation_id = ?';
        const params = [conversationId];
        if (fromSeq !== undefined) {
            sql += ' AND sequence_number >= ?';
            params.push(fromSeq);
        }
        if (toSeq !== undefined) {
            sql += ' AND sequence_number <= ?';
            params.push(toSeq);
        }
        sql += ' ORDER BY sequence_number ASC';
        const rows = this.db.prepare(sql).all(...params);
        return rows.map(rowToMessage);
    }
    getMessage(messageId) {
        const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
        return row ? rowToMessage(row) : null;
    }
    getMessageCount(conversationId) {
        const row = this.db.prepare('SELECT COUNT(*) AS cnt FROM messages WHERE conversation_id = ?').get(conversationId);
        return row.cnt;
    }
    /**
     * Full-text search using FTS5. Falls back to LIKE if FTS fails.
     */
    search(query, conversationId, limit = 50) {
        try {
            let sql = `
        SELECT m.* FROM messages m
        INNER JOIN messages_fts f ON f.rowid = m.rowid
        WHERE messages_fts MATCH ?
      `;
            const params = [query];
            if (conversationId) {
                sql += ' AND m.conversation_id = ?';
                params.push(conversationId);
            }
            sql += ' ORDER BY m.timestamp DESC LIMIT ?';
            params.push(limit);
            const rows = this.db.prepare(sql).all(...params);
            return rows.map(rowToMessage);
        }
        catch {
            // FTS fallback: simple LIKE
            let sql = 'SELECT * FROM messages WHERE content LIKE ?';
            const params = [`%${query}%`];
            if (conversationId) {
                sql += ' AND conversation_id = ?';
                params.push(conversationId);
            }
            sql += ' ORDER BY timestamp DESC LIMIT ?';
            params.push(limit);
            const rows = this.db.prepare(sql).all(...params);
            return rows.map(rowToMessage);
        }
    }
}
//# sourceMappingURL=conversation-store.js.map