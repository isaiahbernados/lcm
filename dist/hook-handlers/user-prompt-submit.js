#!/usr/bin/env node

// src/db/connection.ts
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
var _db = null;
function getDb(dbPath) {
  if (_db) return _db;
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  _db = new DatabaseSync(dbPath);
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec("PRAGMA busy_timeout=5000");
  _db.exec("PRAGMA foreign_keys=ON");
  _db.exec("PRAGMA synchronous=NORMAL");
  return _db;
}

// src/db/migration.ts
function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      project_path TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_session_id
      ON conversations(session_id);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL DEFAULT 0,
      sequence_number INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      metadata TEXT,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
      ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_messages_sequence
      ON messages(conversation_id, sequence_number);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
      USING fts5(content, content=messages, content_rowid=rowid);

    CREATE TRIGGER IF NOT EXISTS messages_fts_insert
      AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_delete
      AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content)
          VALUES ('delete', old.rowid, old.content);
      END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_update
      AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content)
          VALUES ('delete', old.rowid, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

    CREATE TABLE IF NOT EXISTS summaries (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      parent_id TEXT,
      level INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL DEFAULT 0,
      message_range_start INTEGER NOT NULL DEFAULT 0,
      message_range_end INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      metadata TEXT,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_id) REFERENCES summaries(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_summaries_conversation_id
      ON summaries(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_summaries_parent_id
      ON summaries(parent_id);
    CREATE INDEX IF NOT EXISTS idx_summaries_level
      ON summaries(conversation_id, level);

    CREATE TABLE IF NOT EXISTS summary_messages (
      summary_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      PRIMARY KEY (summary_id, message_id),
      FOREIGN KEY (summary_id) REFERENCES summaries(id) ON DELETE CASCADE,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS context_items (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'fact',
      content TEXT NOT NULL,
      importance REAL NOT NULL DEFAULT 0.5,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_context_items_conversation_id
      ON context_items(conversation_id, importance DESC);

    CREATE TABLE IF NOT EXISTS transcript_cursors (
      session_id TEXT PRIMARY KEY,
      byte_offset INTEGER NOT NULL DEFAULT 0,
      last_timestamp INTEGER NOT NULL DEFAULT 0
    );
  `);
}

// src/db/config.ts
import path2 from "node:path";
import os from "node:os";
function defaultDbPath() {
  return path2.join(os.homedir(), ".lcm", "lcm.db");
}
function loadConfig() {
  return {
    databasePath: process.env["LCM_DB_PATH"] ?? defaultDbPath(),
    freshTailCount: parseInt(process.env["LCM_FRESH_TAIL_COUNT"] ?? "32", 10),
    postCompactInjectionTokens: parseInt(process.env["LCM_POST_COMPACT_TOKENS"] ?? "3000", 10),
    enabled: (process.env["LCM_ENABLED"] ?? "true") !== "false",
    anthropicApiKey: process.env["LCM_ANTHROPIC_API_KEY"] ?? process.env["ANTHROPIC_API_KEY"] ?? null,
    granularCompactThreshold: parseInt(process.env["LCM_GRANULAR_THRESHOLD"] ?? "20000", 10),
    useCliSummarizer: (process.env["LCM_USE_CLI"] ?? "false") !== "false"
  };
}

// src/core/conversation-store.ts
import { randomUUID } from "node:crypto";
function rowToConversation(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    projectPath: row.project_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at
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
    metadata: row.metadata ? JSON.parse(row.metadata) : void 0
  };
}
var ConversationStore = class {
  constructor(db) {
    this.db = db;
  }
  getOrCreateConversation(sessionId, projectPath) {
    const existing = this.db.prepare(
      "SELECT * FROM conversations WHERE session_id = ? ORDER BY created_at DESC LIMIT 1"
    ).get(sessionId);
    if (existing) return rowToConversation(existing);
    const now = Date.now();
    const id = `conv_${randomUUID()}`;
    this.db.prepare(
      "INSERT INTO conversations (id, session_id, project_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run(id, sessionId, projectPath, now, now);
    return { id, sessionId, projectPath, createdAt: now, updatedAt: now };
  }
  getConversation(conversationId) {
    const row = this.db.prepare(
      "SELECT * FROM conversations WHERE id = ?"
    ).get(conversationId);
    return row ? rowToConversation(row) : null;
  }
  getConversationBySession(sessionId) {
    const row = this.db.prepare(
      "SELECT * FROM conversations WHERE session_id = ? ORDER BY created_at DESC LIMIT 1"
    ).get(sessionId);
    return row ? rowToConversation(row) : null;
  }
  touchConversation(conversationId) {
    this.db.prepare(
      "UPDATE conversations SET updated_at = ? WHERE id = ?"
    ).run(Date.now(), conversationId);
  }
  /** Returns the next sequence number for a conversation */
  nextSequenceNumber(conversationId) {
    const row = this.db.prepare(
      "SELECT COALESCE(MAX(sequence_number), -1) + 1 AS next FROM messages WHERE conversation_id = ?"
    ).get(conversationId);
    return row.next;
  }
  insertMessage(msg) {
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
  insertMessages(msgs) {
    const results = [];
    for (const msg of msgs) {
      results.push(this.insertMessage(msg));
    }
    return results;
  }
  getMessages(conversationId, fromSeq, toSeq) {
    let sql = "SELECT * FROM messages WHERE conversation_id = ?";
    const params = [conversationId];
    if (fromSeq !== void 0) {
      sql += " AND sequence_number >= ?";
      params.push(fromSeq);
    }
    if (toSeq !== void 0) {
      sql += " AND sequence_number <= ?";
      params.push(toSeq);
    }
    sql += " ORDER BY sequence_number ASC";
    const rows = this.db.prepare(sql).all(...params);
    return rows.map(rowToMessage);
  }
  getMessage(messageId) {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId);
    return row ? rowToMessage(row) : null;
  }
  getMessageCount(conversationId) {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS cnt FROM messages WHERE conversation_id = ?"
    ).get(conversationId);
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
        sql += " AND m.conversation_id = ?";
        params.push(conversationId);
      }
      sql += " ORDER BY m.timestamp DESC LIMIT ?";
      params.push(limit);
      const rows = this.db.prepare(sql).all(...params);
      return rows.map(rowToMessage);
    } catch {
      let sql = "SELECT * FROM messages WHERE content LIKE ?";
      const params = [`%${query}%`];
      if (conversationId) {
        sql += " AND conversation_id = ?";
        params.push(conversationId);
      }
      sql += " ORDER BY timestamp DESC LIMIT ?";
      params.push(limit);
      const rows = this.db.prepare(sql).all(...params);
      return rows.map(rowToMessage);
    }
  }
};

// src/core/summary-store.ts
import { randomUUID as randomUUID2 } from "node:crypto";
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
    metadata: row.metadata ? JSON.parse(row.metadata) : void 0
  };
}
var SummaryStore = class {
  constructor(db) {
    this.db = db;
  }
  insertSummary(summary) {
    const id = `sum_${randomUUID2()}`;
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
  linkSummaryToMessages(summaryId, messageIds) {
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO summary_messages (summary_id, message_id) VALUES (?, ?)"
    );
    for (const msgId of messageIds) {
      stmt.run(summaryId, msgId);
    }
  }
  getSummary(summaryId) {
    const row = this.db.prepare("SELECT * FROM summaries WHERE id = ?").get(summaryId);
    return row ? rowToSummary(row) : null;
  }
  getSummariesForConversation(conversationId, level) {
    let sql = "SELECT * FROM summaries WHERE conversation_id = ?";
    const params = [conversationId];
    if (level !== void 0) {
      sql += " AND level = ?";
      params.push(level);
    }
    sql += " ORDER BY message_range_start ASC";
    const rows = this.db.prepare(sql).all(...params);
    return rows.map(rowToSummary);
  }
  getChildSummaries(parentId) {
    const rows = this.db.prepare(
      "SELECT * FROM summaries WHERE parent_id = ? ORDER BY message_range_start ASC"
    ).all(parentId);
    return rows.map(rowToSummary);
  }
  getChildCount(summaryId) {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS cnt FROM summaries WHERE parent_id = ?"
    ).get(summaryId);
    return row.cnt;
  }
  getMessageIdsForSummary(summaryId) {
    const rows = this.db.prepare(
      "SELECT message_id FROM summary_messages WHERE summary_id = ?"
    ).all(summaryId);
    return rows.map((r) => r.message_id);
  }
  updateParentId(summaryId, parentId) {
    this.db.prepare("UPDATE summaries SET parent_id = ? WHERE id = ?").run(parentId, summaryId);
  }
  /** Get the highest compacted sequence number for a conversation */
  getMaxCompactedSequence(conversationId) {
    const row = this.db.prepare(
      "SELECT COALESCE(MAX(message_range_end), -1) AS max_seq FROM summaries WHERE conversation_id = ? AND level = 0"
    ).get(conversationId);
    return row.max_seq;
  }
  /** Get top-N summaries by level for context injection (most condensed first) */
  getTopSummaries(conversationId, tokenBudget) {
    const rows = this.db.prepare(
      "SELECT * FROM summaries WHERE conversation_id = ? ORDER BY level DESC, message_range_end DESC"
    ).all(conversationId);
    const selected = [];
    let tokensUsed = 0;
    for (const row of rows) {
      if (tokensUsed + row.token_count > tokenBudget) break;
      selected.push(rowToSummary(row));
      tokensUsed += row.token_count;
    }
    return selected;
  }
  // --- Context Items ---
  insertContextItem(item) {
    const id = `ctx_${randomUUID2()}`;
    const createdAt = Date.now();
    this.db.prepare(
      `INSERT INTO context_items (id, conversation_id, category, content, importance, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, item.conversationId, item.category, item.content, item.importance, createdAt, item.expiresAt ?? null);
    return { ...item, id, createdAt };
  }
  getContextItems(conversationId, minImportance = 0) {
    const rows = this.db.prepare(
      `SELECT * FROM context_items
       WHERE conversation_id = ? AND importance >= ?
       AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY importance DESC`
    ).all(conversationId, minImportance, Date.now());
    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      category: r.category,
      content: r.content,
      importance: r.importance,
      createdAt: r.created_at,
      expiresAt: r.expires_at ?? void 0
    }));
  }
  // --- Transcript Cursors ---
  getCursor(sessionId) {
    const row = this.db.prepare(
      "SELECT * FROM transcript_cursors WHERE session_id = ?"
    ).get(sessionId);
    return row ? { sessionId: row.session_id, byteOffset: row.byte_offset, lastTimestamp: row.last_timestamp } : null;
  }
  upsertCursor(cursor) {
    this.db.prepare(
      `INSERT INTO transcript_cursors (session_id, byte_offset, last_timestamp)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         byte_offset = excluded.byte_offset,
         last_timestamp = excluded.last_timestamp`
    ).run(cursor.sessionId, cursor.byteOffset, cursor.lastTimestamp);
  }
};

// src/utils/logger.ts
import fs2 from "node:fs";
import path3 from "node:path";
import os2 from "node:os";
var logFile = process.env["LCM_LOG_FILE"] ?? path3.join(os2.homedir(), ".lcm", "lcm.log");
var _logFd = null;
function getLogFd() {
  if (_logFd !== null) return _logFd;
  fs2.mkdirSync(path3.dirname(logFile), { recursive: true });
  _logFd = fs2.openSync(logFile, "a");
  return _logFd;
}
function write(level, msg, data) {
  try {
    const line = JSON.stringify({
      t: (/* @__PURE__ */ new Date()).toISOString(),
      level,
      msg,
      ...data !== void 0 ? { data } : {}
    });
    fs2.writeSync(getLogFd(), line + "\n");
  } catch {
  }
}
var logger = {
  info: (msg, data) => write("INFO", msg, data),
  warn: (msg, data) => write("WARN", msg, data),
  error: (msg, data) => write("ERROR", msg, data),
  debug: (msg, data) => {
    if (process.env["LCM_DEBUG"]) write("DEBUG", msg, data);
  }
};

// src/hook-handlers/orchestrator.ts
import fs3 from "node:fs";
async function runHook(handler2) {
  let input;
  try {
    const stdin = fs3.readFileSync("/dev/stdin", "utf8");
    input = JSON.parse(stdin);
  } catch {
    input = {
      session_id: process.env["CLAUDE_SESSION_ID"] ?? "unknown",
      transcript_path: "",
      cwd: process.cwd(),
      permission_mode: "default",
      hook_event_name: "unknown"
    };
  }
  const config = loadConfig();
  if (!config.enabled) {
    process.exit(0);
  }
  const db = getDb(config.databasePath);
  try {
    runMigrations(db);
  } catch (err) {
    logger.error("Migration failed", err);
    process.exit(0);
  }
  const conversationStore = new ConversationStore(db);
  const summaryStore = new SummaryStore(db);
  const ctx = { input, conversationStore, summaryStore, config };
  let output = {};
  try {
    output = await handler2(ctx);
  } catch (err) {
    logger.error("Hook handler error", err);
  }
  if (Object.keys(output).length > 0) {
    process.stdout.write(JSON.stringify(output) + "\n");
  }
  process.exit(0);
}

// src/core/transcript-reader.ts
import fs4 from "node:fs";
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}
function extractContent(content) {
  if (typeof content === "string") return content;
  return content.map((block) => {
    if (block.type === "text" && typeof block.text === "string") return block.text;
    if (block.type === "tool_use") {
      const name = block["name"];
      const input = block["input"];
      return `[tool_use: ${name ?? "unknown"} ${JSON.stringify(input ?? {})}]`;
    }
    if (block.type === "tool_result") {
      const toolContent = block["content"];
      if (typeof toolContent === "string") return `[tool_result: ${toolContent}]`;
      if (Array.isArray(toolContent)) {
        return `[tool_result: ${toolContent.map((b) => b.text ?? "").join(" ")}]`;
      }
    }
    return "";
  }).filter(Boolean).join("\n");
}
function readNewTranscriptEntries(transcriptPath, cursor) {
  let fileContent;
  let fileSize;
  try {
    const stat = fs4.statSync(transcriptPath);
    fileSize = stat.size;
    if (fileSize <= cursor.byteOffset) {
      return { messages: [], updatedCursor: cursor };
    }
    const fd = fs4.openSync(transcriptPath, "r");
    const buffer = Buffer.alloc(fileSize - cursor.byteOffset);
    fs4.readSync(fd, buffer, 0, buffer.length, cursor.byteOffset);
    fs4.closeSync(fd);
    fileContent = buffer.toString("utf8");
  } catch {
    return { messages: [], updatedCursor: cursor };
  }
  const lines = fileContent.split("\n").filter((l) => l.trim());
  const messages = [];
  let lastTimestamp = cursor.lastTimestamp;
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();
    if (ts > lastTimestamp) lastTimestamp = ts;
    if (entry.type === "user" || entry.type === "assistant") {
      const raw = entry.message.content;
      const content = extractContent(raw);
      if (!content.trim()) continue;
      if (Array.isArray(entry.message.content)) {
        for (const block of entry.message.content) {
          if (block.type === "tool_use") {
            const toolContent = `[tool_use: ${block["name"] ?? "unknown"} ${JSON.stringify(block["input"] ?? {})}]`;
            messages.push({
              role: "tool_use",
              content: toolContent,
              timestamp: ts,
              metadata: { tool_name: block["name"], tool_use_id: block["id"] }
            });
          } else if (block.type === "tool_result") {
            const resultContent = typeof block["content"] === "string" ? block["content"] : JSON.stringify(block["content"] ?? "");
            messages.push({
              role: "tool_result",
              content: resultContent,
              timestamp: ts,
              metadata: { tool_use_id: block["tool_use_id"] }
            });
          } else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
            messages.push({ role: entry.type, content: block.text, timestamp: ts });
          }
        }
      } else {
        messages.push({ role: entry.type, content, timestamp: ts });
      }
    } else if (entry.type === "system") {
      const content = entry.content;
      if (content?.trim()) {
        messages.push({ role: "system", content, timestamp: ts });
      }
    }
  }
  return {
    messages,
    updatedCursor: {
      sessionId: cursor.sessionId,
      byteOffset: fileSize,
      lastTimestamp
    }
  };
}

// src/hook-handlers/ingest.ts
async function ingestNewMessages(transcriptPath, sessionId, projectPath, conversationStore, summaryStore) {
  if (!transcriptPath) return { messagesIngested: 0 };
  const conversation = conversationStore.getOrCreateConversation(sessionId, projectPath);
  const cursor = summaryStore.getCursor(sessionId) ?? {
    sessionId,
    byteOffset: 0,
    lastTimestamp: 0
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
        metadata: msg.metadata
      });
    } catch (err) {
      logger.warn("Failed to insert message", { err, role: msg.role });
    }
  }
  summaryStore.upsertCursor(updatedCursor);
  conversationStore.touchConversation(conversation.id);
  logger.debug("Ingested messages", { count: messages.length, sessionId });
  return { messagesIngested: messages.length };
}

// src/hook-handlers/user-prompt-submit.ts
async function handler(ctx) {
  const { input, conversationStore, summaryStore } = ctx;
  if (!input.transcript_path) return {};
  await ingestNewMessages(
    input.transcript_path,
    input.session_id,
    input.cwd ?? "",
    conversationStore,
    summaryStore
  );
  return {};
}
runHook(handler);
//# sourceMappingURL=user-prompt-submit.js.map
