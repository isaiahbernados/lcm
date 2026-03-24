/**
 * Comprehensive vitest tests for the LCM plugin.
 *
 * Each describe block uses its own fresh in-memory SQLite database to avoid
 * singleton cross-contamination from connection.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../db/migration.js';
import { ConversationStore } from '../core/conversation-store.js';
import { SummaryStore } from '../core/summary-store.js';
import { RetrievalEngine } from '../core/retrieval-engine.js';
import { ContextAssembler } from '../core/context-assembler.js';
import { deterministicTruncate } from '../core/summarize.js';
import { estimateTokens } from '../core/transcript-reader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  runMigrations(db);
  return db;
}

/** Minimal timestamp helper so tests are not time-sensitive. */
const NOW = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Suite 1 — ConversationStore
// ---------------------------------------------------------------------------

describe('ConversationStore', () => {
  let db: DatabaseSync;
  let store: ConversationStore;

  beforeEach(() => {
    db = makeDb();
    store = new ConversationStore(db);
  });

  it('getOrCreateConversation creates a new conversation when none exists', () => {
    const conv = store.getOrCreateConversation('session-abc', '/project/foo');

    expect(conv.id).toMatch(/^conv_/);
    expect(conv.sessionId).toBe('session-abc');
    expect(conv.projectPath).toBe('/project/foo');
    expect(typeof conv.createdAt).toBe('number');
    expect(typeof conv.updatedAt).toBe('number');
  });

  it('getOrCreateConversation returns the same conversation on second call with same sessionId', () => {
    const first = store.getOrCreateConversation('session-abc', '/project/foo');
    const second = store.getOrCreateConversation('session-abc', '/project/foo');

    expect(second.id).toBe(first.id);
  });

  it('insertMessage assigns sequential sequenceNumber starting at 0', () => {
    const conv = store.getOrCreateConversation('session-seq', '/proj');

    const m0 = store.insertMessage({
      conversationId: conv.id,
      role: 'user',
      content: 'Hello',
      tokenCount: 1,
      timestamp: NOW,
    });
    const m1 = store.insertMessage({
      conversationId: conv.id,
      role: 'assistant',
      content: 'Hi there',
      tokenCount: 2,
      timestamp: NOW + 1,
    });
    const m2 = store.insertMessage({
      conversationId: conv.id,
      role: 'user',
      content: 'What is up',
      tokenCount: 3,
      timestamp: NOW + 2,
    });

    expect(m0.sequenceNumber).toBe(0);
    expect(m1.sequenceNumber).toBe(1);
    expect(m2.sequenceNumber).toBe(2);
  });

  it('insertMessage returns message with id prefixed msg_', () => {
    const conv = store.getOrCreateConversation('session-id-prefix', '/proj');
    const msg = store.insertMessage({
      conversationId: conv.id,
      role: 'user',
      content: 'test',
      tokenCount: 1,
      timestamp: NOW,
    });

    expect(msg.id).toMatch(/^msg_/);
  });

  it('getMessages(convId) returns all messages ordered by sequence', () => {
    const conv = store.getOrCreateConversation('session-getmsgs', '/proj');

    store.insertMessage({ conversationId: conv.id, role: 'user', content: 'A', tokenCount: 1, timestamp: NOW });
    store.insertMessage({ conversationId: conv.id, role: 'assistant', content: 'B', tokenCount: 1, timestamp: NOW + 1 });
    store.insertMessage({ conversationId: conv.id, role: 'user', content: 'C', tokenCount: 1, timestamp: NOW + 2 });

    const msgs = store.getMessages(conv.id);

    expect(msgs).toHaveLength(3);
    expect(msgs[0]!.content).toBe('A');
    expect(msgs[1]!.content).toBe('B');
    expect(msgs[2]!.content).toBe('C');
    // Verify ascending sequence order
    expect(msgs[0]!.sequenceNumber).toBeLessThan(msgs[1]!.sequenceNumber);
    expect(msgs[1]!.sequenceNumber).toBeLessThan(msgs[2]!.sequenceNumber);
  });

  it('getMessages(convId, fromSeq, toSeq) filters by range correctly', () => {
    const conv = store.getOrCreateConversation('session-range', '/proj');

    for (let i = 0; i < 5; i++) {
      store.insertMessage({ conversationId: conv.id, role: 'user', content: `msg${i}`, tokenCount: 1, timestamp: NOW + i });
    }

    const msgs = store.getMessages(conv.id, 1, 3);

    expect(msgs).toHaveLength(3);
    expect(msgs[0]!.sequenceNumber).toBe(1);
    expect(msgs[2]!.sequenceNumber).toBe(3);
  });

  it('getMessage(id) returns the message', () => {
    const conv = store.getOrCreateConversation('session-getmsg', '/proj');
    const inserted = store.insertMessage({
      conversationId: conv.id,
      role: 'user',
      content: 'find me',
      tokenCount: 5,
      timestamp: NOW,
    });

    const found = store.getMessage(inserted.id);

    expect(found).not.toBeNull();
    expect(found!.id).toBe(inserted.id);
    expect(found!.content).toBe('find me');
    expect(found!.tokenCount).toBe(5);
  });

  it('getMessage(id) returns null for unknown ID', () => {
    const result = store.getMessage('msg_does-not-exist');
    expect(result).toBeNull();
  });

  it('search(query) finds messages via FTS5', () => {
    const conv = store.getOrCreateConversation('session-fts', '/proj');

    store.insertMessage({ conversationId: conv.id, role: 'user', content: 'the quick brown fox', tokenCount: 4, timestamp: NOW });
    store.insertMessage({ conversationId: conv.id, role: 'assistant', content: 'nothing relevant here', tokenCount: 3, timestamp: NOW + 1 });

    const results = store.search('quick');

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((m) => m.content.includes('quick'))).toBe(true);
  });

  it('getMessageCount returns the correct count', () => {
    const conv = store.getOrCreateConversation('session-count', '/proj');

    expect(store.getMessageCount(conv.id)).toBe(0);

    store.insertMessage({ conversationId: conv.id, role: 'user', content: 'one', tokenCount: 1, timestamp: NOW });
    store.insertMessage({ conversationId: conv.id, role: 'assistant', content: 'two', tokenCount: 1, timestamp: NOW + 1 });

    expect(store.getMessageCount(conv.id)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — SummaryStore
// ---------------------------------------------------------------------------

describe('SummaryStore', () => {
  let db: DatabaseSync;
  let convStore: ConversationStore;
  let store: SummaryStore;
  let convId: string;

  beforeEach(() => {
    db = makeDb();
    convStore = new ConversationStore(db);
    store = new SummaryStore(db);
    const conv = convStore.getOrCreateConversation('session-ss', '/proj');
    convId = conv.id;
  });

  it('insertSummary returns summary with id prefixed sum_', () => {
    const summary = store.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 0,
      content: 'A brief summary.',
      tokenCount: 10,
      messageRangeStart: 0,
      messageRangeEnd: 5,
    });

    expect(summary.id).toMatch(/^sum_/);
  });

  it('insertSummary stores parentId: null when not provided', () => {
    const summary = store.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 0,
      content: 'No parent.',
      tokenCount: 5,
      messageRangeStart: 0,
      messageRangeEnd: 2,
    });

    const fetched = store.getSummary(summary.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.parentId).toBeNull();
  });

  it('getSummary(id) returns correct summary', () => {
    const inserted = store.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 1,
      content: 'High-level summary',
      tokenCount: 20,
      messageRangeStart: 0,
      messageRangeEnd: 10,
    });

    const found = store.getSummary(inserted.id);

    expect(found).not.toBeNull();
    expect(found!.id).toBe(inserted.id);
    expect(found!.content).toBe('High-level summary');
    expect(found!.level).toBe(1);
    expect(found!.tokenCount).toBe(20);
    expect(found!.messageRangeStart).toBe(0);
    expect(found!.messageRangeEnd).toBe(10);
  });

  it('getSummary(id) returns null for unknown id', () => {
    expect(store.getSummary('sum_does-not-exist')).toBeNull();
  });

  it('getSummariesForConversation(convId) returns all summaries', () => {
    store.insertSummary({ conversationId: convId, parentId: null, level: 0, content: 'S1', tokenCount: 5, messageRangeStart: 0, messageRangeEnd: 3 });
    store.insertSummary({ conversationId: convId, parentId: null, level: 1, content: 'S2', tokenCount: 5, messageRangeStart: 4, messageRangeEnd: 7 });

    const summaries = store.getSummariesForConversation(convId);
    expect(summaries).toHaveLength(2);
  });

  it('getSummariesForConversation(convId, 0) filters to level-0 only', () => {
    store.insertSummary({ conversationId: convId, parentId: null, level: 0, content: 'Level 0', tokenCount: 5, messageRangeStart: 0, messageRangeEnd: 3 });
    store.insertSummary({ conversationId: convId, parentId: null, level: 1, content: 'Level 1', tokenCount: 5, messageRangeStart: 4, messageRangeEnd: 7 });
    store.insertSummary({ conversationId: convId, parentId: null, level: 0, content: 'Level 0 again', tokenCount: 5, messageRangeStart: 8, messageRangeEnd: 11 });

    const level0 = store.getSummariesForConversation(convId, 0);

    expect(level0).toHaveLength(2);
    expect(level0.every((s) => s.level === 0)).toBe(true);
  });

  it('getChildSummaries(parentId) returns summaries with matching parent_id', () => {
    const parent = store.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 1,
      content: 'Parent',
      tokenCount: 10,
      messageRangeStart: 0,
      messageRangeEnd: 20,
    });
    const child1 = store.insertSummary({
      conversationId: convId,
      parentId: parent.id,
      level: 0,
      content: 'Child 1',
      tokenCount: 5,
      messageRangeStart: 0,
      messageRangeEnd: 9,
    });
    const child2 = store.insertSummary({
      conversationId: convId,
      parentId: parent.id,
      level: 0,
      content: 'Child 2',
      tokenCount: 5,
      messageRangeStart: 10,
      messageRangeEnd: 20,
    });

    const children = store.getChildSummaries(parent.id);

    expect(children).toHaveLength(2);
    const ids = children.map((c) => c.id);
    expect(ids).toContain(child1.id);
    expect(ids).toContain(child2.id);
  });

  it('getChildCount(summaryId) returns correct count', () => {
    const parent = store.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 1,
      content: 'Parent',
      tokenCount: 10,
      messageRangeStart: 0,
      messageRangeEnd: 20,
    });

    expect(store.getChildCount(parent.id)).toBe(0);

    store.insertSummary({ conversationId: convId, parentId: parent.id, level: 0, content: 'C1', tokenCount: 5, messageRangeStart: 0, messageRangeEnd: 9 });
    store.insertSummary({ conversationId: convId, parentId: parent.id, level: 0, content: 'C2', tokenCount: 5, messageRangeStart: 10, messageRangeEnd: 20 });

    expect(store.getChildCount(parent.id)).toBe(2);
  });

  it('getMaxCompactedSequence returns -1 when no summaries exist', () => {
    expect(store.getMaxCompactedSequence(convId)).toBe(-1);
  });

  it('getMaxCompactedSequence returns correct max when summaries exist', () => {
    store.insertSummary({ conversationId: convId, parentId: null, level: 0, content: 'S1', tokenCount: 5, messageRangeStart: 0, messageRangeEnd: 9 });
    store.insertSummary({ conversationId: convId, parentId: null, level: 0, content: 'S2', tokenCount: 5, messageRangeStart: 10, messageRangeEnd: 19 });
    // level 1 summary — should NOT count, only level 0 is considered
    store.insertSummary({ conversationId: convId, parentId: null, level: 1, content: 'S3', tokenCount: 5, messageRangeStart: 0, messageRangeEnd: 30 });

    expect(store.getMaxCompactedSequence(convId)).toBe(19);
  });

  it('getTopSummaries(convId, budget) respects token budget', () => {
    // Insert three summaries; combined token cost exceeds budget of 15
    store.insertSummary({ conversationId: convId, parentId: null, level: 0, content: 'S1', tokenCount: 8, messageRangeStart: 0, messageRangeEnd: 5 });
    store.insertSummary({ conversationId: convId, parentId: null, level: 0, content: 'S2', tokenCount: 8, messageRangeStart: 6, messageRangeEnd: 11 });
    store.insertSummary({ conversationId: convId, parentId: null, level: 0, content: 'S3', tokenCount: 8, messageRangeStart: 12, messageRangeEnd: 17 });

    // Budget of 15 — only one or two summaries (8 or 16 tokens); exactly 8 fits, 16 > 15
    const selected = store.getTopSummaries(convId, 15);

    const totalTokens = selected.reduce((acc, s) => acc + s.tokenCount, 0);
    expect(totalTokens).toBeLessThanOrEqual(15);
  });

});

// ---------------------------------------------------------------------------
// Suite 3 — RetrievalEngine
// ---------------------------------------------------------------------------

describe('RetrievalEngine', () => {
  let db: DatabaseSync;
  let convStore: ConversationStore;
  let summaryStore: SummaryStore;
  let engine: RetrievalEngine;
  let convId: string;
  let sessionId: string;

  beforeEach(() => {
    db = makeDb();
    convStore = new ConversationStore(db);
    summaryStore = new SummaryStore(db);
    engine = new RetrievalEngine(convStore, summaryStore);

    sessionId = 'session-re';
    const conv = convStore.getOrCreateConversation(sessionId, '/proj');
    convId = conv.id;
  });

  it('grep(query) returns matching messages as GrepResult[]', () => {
    convStore.insertMessage({ conversationId: convId, role: 'user', content: 'refactor the database layer', tokenCount: 4, timestamp: NOW });
    convStore.insertMessage({ conversationId: convId, role: 'assistant', content: 'sure, here is a plan', tokenCount: 5, timestamp: NOW + 1 });

    const results = engine.grep('refactor');

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.messageId).toMatch(/^msg_/);
    expect(results[0]!.conversationId).toBe(convId);
    expect(results[0]!.sessionId).toBe(sessionId);
    expect(results[0]!.content).toContain('refactor');
    expect(typeof results[0]!.sequenceNumber).toBe('number');
    expect(typeof results[0]!.timestamp).toBe('number');
    expect(results[0]!.coveringSummaryId).toBeNull();
  });

  it('grep(query) returns empty array when no matches', () => {
    convStore.insertMessage({ conversationId: convId, role: 'user', content: 'hello world', tokenCount: 2, timestamp: NOW });

    const results = engine.grep('xyzzy_no_match_expected');

    expect(results).toEqual([]);
  });

  it('grep(query) includes coveringSummaryId when a summary covers the message', () => {
    const m0 = convStore.insertMessage({ conversationId: convId, role: 'user', content: 'covered search term alpha', tokenCount: 5, timestamp: NOW });
    const m1 = convStore.insertMessage({ conversationId: convId, role: 'assistant', content: 'response to alpha', tokenCount: 5, timestamp: NOW + 1 });

    const summary = summaryStore.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 0,
      content: 'Summary of alpha discussion.',
      tokenCount: 10,
      messageRangeStart: m0.sequenceNumber,
      messageRangeEnd: m1.sequenceNumber,
    });

    const results = engine.grep('alpha');

    expect(results.length).toBeGreaterThanOrEqual(1);
    const covered = results.find((r) => r.messageId === m0.id);
    expect(covered).toBeDefined();
    expect(covered!.coveringSummaryId).toBe(summary.id);
  });

  it('grep(query, undefined, 50, summaryId) restricts results to messages within summary scope', () => {
    // Insert messages at seq 0-3
    const m0 = convStore.insertMessage({ conversationId: convId, role: 'user', content: 'scoped keyword beta', tokenCount: 3, timestamp: NOW });
    const m1 = convStore.insertMessage({ conversationId: convId, role: 'assistant', content: 'reply with beta', tokenCount: 3, timestamp: NOW + 1 });
    const m2 = convStore.insertMessage({ conversationId: convId, role: 'user', content: 'another beta mention outside', tokenCount: 3, timestamp: NOW + 2 });
    const m3 = convStore.insertMessage({ conversationId: convId, role: 'assistant', content: 'no keyword here', tokenCount: 3, timestamp: NOW + 3 });

    // Summary covers only m0 and m1
    const summary = summaryStore.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 0,
      content: 'Summary covering first two.',
      tokenCount: 10,
      messageRangeStart: m0.sequenceNumber,
      messageRangeEnd: m1.sequenceNumber,
    });

    // Search with summary_id filter
    const results = engine.grep('beta', undefined, 50, summary.id);

    // Only m0 and m1 match "beta" within the summary scope; m2 is outside
    expect(results.length).toBe(2);
    const ids = results.map((r) => r.messageId);
    expect(ids).toContain(m0.id);
    expect(ids).toContain(m1.id);
    expect(ids).not.toContain(m2.id);
  });

  it('describe("sum_...") returns summary metadata with type "summary"', () => {
    const summary = summaryStore.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 0,
      content: 'A concise summary.',
      tokenCount: 15,
      messageRangeStart: 0,
      messageRangeEnd: 4,
    });

    const result = engine.describe(summary.id);

    expect(result).not.toBeNull();
    expect(result!.type).toBe('summary');
    expect(result!.id).toBe(summary.id);
    expect(result!.content).toBe('A concise summary.');
    expect(result!.tokenCount).toBe(15);
    expect(result!.level).toBe(0);
    expect(result!.messageRangeStart).toBe(0);
    expect(result!.messageRangeEnd).toBe(4);
    expect(typeof result!.childCount).toBe('number');
  });

  it('describe("msg_...") returns message metadata with type "message"', () => {
    const msg = convStore.insertMessage({
      conversationId: convId,
      role: 'user',
      content: 'A user message.',
      tokenCount: 4,
      timestamp: NOW,
    });

    const result = engine.describe(msg.id);

    expect(result).not.toBeNull();
    expect(result!.type).toBe('message');
    expect(result!.id).toBe(msg.id);
    expect(result!.content).toBe('A user message.');
    expect(result!.tokenCount).toBe(4);
  });

  it('describe("unknown_id") returns null', () => {
    expect(engine.describe('unknown_id_xyz')).toBeNull();
  });

  it('expand(summaryId) returns messages linked via summary_messages', () => {
    const msg0 = convStore.insertMessage({ conversationId: convId, role: 'user', content: 'linked message A', tokenCount: 5, timestamp: NOW });
    const msg1 = convStore.insertMessage({ conversationId: convId, role: 'assistant', content: 'linked message B', tokenCount: 5, timestamp: NOW + 1 });

    const summary = summaryStore.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 0,
      content: 'Summary of A and B.',
      tokenCount: 10,
      messageRangeStart: msg0.sequenceNumber,
      messageRangeEnd: msg1.sequenceNumber,
    });

    // linkSummaryToMessages exists — verified in source
    summaryStore.linkSummaryToMessages(summary.id, [msg0.id, msg1.id]);

    const result = engine.expand(summary.id);

    expect(result.summaryId).toBe(summary.id);
    expect(result.messages).toHaveLength(2);
    const ids = result.messages.map((m) => m.id);
    expect(ids).toContain(msg0.id);
    expect(ids).toContain(msg1.id);
  });

  it('expand(summaryId) falls back to sequence range when no summary_messages links exist', () => {
    // Insert messages with sequences 0-2
    const m0 = convStore.insertMessage({ conversationId: convId, role: 'user', content: 'range msg 0', tokenCount: 3, timestamp: NOW });
    const m1 = convStore.insertMessage({ conversationId: convId, role: 'assistant', content: 'range msg 1', tokenCount: 3, timestamp: NOW + 1 });
    const m2 = convStore.insertMessage({ conversationId: convId, role: 'user', content: 'range msg 2', tokenCount: 3, timestamp: NOW + 2 });

    // No links — only range
    const summary = summaryStore.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 0,
      content: 'Range fallback summary.',
      tokenCount: 10,
      messageRangeStart: m0.sequenceNumber,
      messageRangeEnd: m2.sequenceNumber,
    });

    const result = engine.expand(summary.id);

    expect(result.summaryId).toBe(summary.id);
    expect(result.messages).toHaveLength(3);
    const seqs = result.messages.map((m) => m.sequenceNumber);
    expect(seqs).toContain(m0.sequenceNumber);
    expect(seqs).toContain(m1.sequenceNumber);
    expect(seqs).toContain(m2.sequenceNumber);
  });

  it('expand(summaryId) respects tokenCap and sets truncated: true', () => {
    // Each message costs 100 tokens; tokenCap = 150 => only one fits
    const m0 = convStore.insertMessage({ conversationId: convId, role: 'user', content: 'big msg 0', tokenCount: 100, timestamp: NOW });
    const m1 = convStore.insertMessage({ conversationId: convId, role: 'assistant', content: 'big msg 1', tokenCount: 100, timestamp: NOW + 1 });

    const summary = summaryStore.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 0,
      content: 'Big messages summary.',
      tokenCount: 20,
      messageRangeStart: m0.sequenceNumber,
      messageRangeEnd: m1.sequenceNumber,
    });

    // Link both messages explicitly so we exercise the direct-link path
    summaryStore.linkSummaryToMessages(summary.id, [m0.id, m1.id]);

    const result = engine.expand(summary.id, 1, 150);

    expect(result.truncated).toBe(true);
    expect(result.messages).toHaveLength(1);
    expect(result.totalTokens).toBeLessThanOrEqual(150);
  });

  it('expandQuery(query) returns expand results for summaries covering matched messages', () => {
    const m0 = convStore.insertMessage({ conversationId: convId, role: 'user', content: 'neural network architecture', tokenCount: 10, timestamp: NOW });
    const m1 = convStore.insertMessage({ conversationId: convId, role: 'assistant', content: 'here are the layers', tokenCount: 10, timestamp: NOW + 1 });

    const summary = summaryStore.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 0,
      content: 'Discussion of neural networks.',
      tokenCount: 20,
      messageRangeStart: m0.sequenceNumber,
      messageRangeEnd: m1.sequenceNumber,
    });

    const results = engine.expandQuery('neural');

    expect(results.length).toBeGreaterThanOrEqual(1);
    // The covering summary should appear
    expect(results.some((r) => r.summaryId === summary.id)).toBe(true);
  });

  it('expandQuery(query) returns fallback result with summaryId === null and isFallback === true when no summary covers the match', () => {
    // Insert a message but no summary covering it
    convStore.insertMessage({
      conversationId: convId,
      role: 'user',
      content: 'uncovered unique message zeta',
      tokenCount: 5,
      timestamp: NOW,
    });

    const results = engine.expandQuery('uncovered unique message zeta');

    expect(results.length).toBeGreaterThanOrEqual(1);
    const fallback = results.find((r) => r.isFallback === true);
    expect(fallback).toBeDefined();
    // Being added/fixed in parallel — asserting the spec
    expect(fallback!.summaryId).toBeNull();
    expect(fallback!.isFallback).toBe(true);
    expect(fallback!.messages.length).toBeGreaterThanOrEqual(1);
  });

  it('expandQuery(query) respects tokenCap in fallback path when no summary covers the match', () => {
    // Insert a message with a large token count but no covering summary
    convStore.insertMessage({
      conversationId: convId,
      role: 'user',
      content: 'huge fallback message omega',
      tokenCount: 5000,
      timestamp: NOW,
    });

    // tokenCap=50, maxResults defaults to 5 → perResultCap=10, far below 5000
    const results = engine.expandQuery('huge fallback message omega', 5, 50);

    expect(results.length).toBeGreaterThanOrEqual(1);
    const fallback = results.find((r) => r.isFallback === true);
    expect(fallback).toBeDefined();
    expect(fallback!.truncated).toBe(true);
    expect(fallback!.messages).toHaveLength(0);
  });

  it('expandQuery(query) returns empty array when no messages match', () => {
    convStore.insertMessage({ conversationId: convId, role: 'user', content: 'something completely different', tokenCount: 4, timestamp: NOW });

    const results = engine.expandQuery('zzzzz_no_match_at_all');

    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — ContextAssembler
// ---------------------------------------------------------------------------

describe('ContextAssembler', () => {
  let db: DatabaseSync;
  let convStore: ConversationStore;
  let summaryStore: SummaryStore;
  let assembler: ContextAssembler;
  let convId: string;

  beforeEach(() => {
    db = makeDb();
    convStore = new ConversationStore(db);
    summaryStore = new SummaryStore(db);
    assembler = new ContextAssembler(convStore, summaryStore);

    const conv = convStore.getOrCreateConversation('session-ca', '/proj');
    convId = conv.id;
  });

  it('buildPostCompactContext returns null when no summaries and no context items', () => {
    const result = assembler.buildPostCompactContext(convId, 10_000);
    expect(result).toBeNull();
  });

  it('returns a string containing <lcm-restored-context> when summaries exist', () => {
    summaryStore.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 0,
      content: 'Discussed feature X implementation.',
      tokenCount: 20,
      messageRangeStart: 0,
      messageRangeEnd: 5,
    });

    const result = assembler.buildPostCompactContext(convId, 10_000);

    expect(result).not.toBeNull();
    expect(result).toContain('<lcm-restored-context>');
    expect(result).toContain('</lcm-restored-context>');
  });

  it('includes message range label in output (e.g. "messages 0–5")', () => {
    summaryStore.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 0,
      content: 'Summary content here.',
      tokenCount: 20,
      messageRangeStart: 0,
      messageRangeEnd: 5,
    });

    const result = assembler.buildPostCompactContext(convId, 10_000);

    expect(result).not.toBeNull();
    // The assembler formats this as "messages 0–5"
    expect(result).toContain('messages 0\u20135');
  });

  it('respects token budget (does not include summaries exceeding budget)', () => {
    // Each summary costs 500 tokens; budget = 600 => only one fits
    summaryStore.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 0,
      content: 'Summary A — large.',
      tokenCount: 500,
      messageRangeStart: 0,
      messageRangeEnd: 9,
    });
    summaryStore.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 0,
      content: 'Summary B — also large.',
      tokenCount: 500,
      messageRangeStart: 10,
      messageRangeEnd: 19,
    });

    const result = assembler.buildPostCompactContext(convId, 600);

    expect(result).not.toBeNull();
    // Only one summary should appear; the second is cut by budget
    const countA = (result!.match(/Summary A/g) ?? []).length;
    const countB = (result!.match(/Summary B/g) ?? []).length;
    // Exactly one of the two should appear
    expect(countA + countB).toBe(1);
  });

  it('includes context items section when items with importance >= 0.5 exist', () => {
    // insertContextItem and getContextItems exist in SummaryStore (verified in source)
    summaryStore.insertContextItem({
      conversationId: convId,
      category: 'fact',
      content: 'The deployment target is Kubernetes.',
      importance: 0.9,
    });
    summaryStore.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 0,
      content: 'Infra discussion.',
      tokenCount: 10,
      messageRangeStart: 0,
      messageRangeEnd: 2,
    });

    const result = assembler.buildPostCompactContext(convId, 10_000);

    expect(result).not.toBeNull();
    expect(result).toContain('Key Context Items');
    expect(result).toContain('Kubernetes');
  });

  it('does not include context items section when all items have importance < 0.5', () => {
    summaryStore.insertContextItem({
      conversationId: convId,
      category: 'fact',
      content: 'Low importance detail.',
      importance: 0.3,
    });
    summaryStore.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 0,
      content: 'Some summary.',
      tokenCount: 10,
      messageRangeStart: 0,
      messageRangeEnd: 2,
    });

    const result = assembler.buildPostCompactContext(convId, 10_000);

    expect(result).not.toBeNull();
    // Low-importance item should be filtered out by getContextItems(convId, 0.5)
    expect(result).not.toContain('Low importance detail.');
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — Summarization
// ---------------------------------------------------------------------------

describe('Summarization', () => {
  it('deterministicTruncate concatenates messages in [role]: content format', () => {
    const messages = [
      { role: 'user' as const, content: 'Hello world', tokenCount: 3, id: 'msg_1', conversationId: 'c1', sequenceNumber: 0, timestamp: NOW },
      { role: 'assistant' as const, content: 'Hi there', tokenCount: 2, id: 'msg_2', conversationId: 'c1', sequenceNumber: 1, timestamp: NOW + 1 },
    ];

    const result = deterministicTruncate(messages, 512);

    expect(result).toContain('[user]: Hello world');
    expect(result).toContain('[assistant]: Hi there');
    expect(result).toContain('---');
    expect(result.length).toBeLessThanOrEqual(512 * 4);
  });

  it('deterministicTruncate always produces output smaller than input for large messages', () => {
    // Create messages totaling ~10000 tokens (each token ~4 chars)
    const bigContent = 'x'.repeat(4 * 2500); // 2500 tokens per message
    const messages = [
      { role: 'user' as const, content: bigContent, tokenCount: 2500, id: 'msg_1', conversationId: 'c1', sequenceNumber: 0, timestamp: NOW },
      { role: 'assistant' as const, content: bigContent, tokenCount: 2500, id: 'msg_2', conversationId: 'c1', sequenceNumber: 1, timestamp: NOW + 1 },
      { role: 'user' as const, content: bigContent, tokenCount: 2500, id: 'msg_3', conversationId: 'c1', sequenceNumber: 2, timestamp: NOW + 2 },
      { role: 'assistant' as const, content: bigContent, tokenCount: 2500, id: 'msg_4', conversationId: 'c1', sequenceNumber: 3, timestamp: NOW + 3 },
    ];

    const result = deterministicTruncate(messages, 512);
    const resultTokens = estimateTokens(result);

    expect(resultTokens).toBeLessThanOrEqual(512);
  });
});
