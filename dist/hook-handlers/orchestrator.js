/**
 * Main hook orchestrator. Each hook handler entry point calls into this.
 *
 * Reads JSON from stdin (Claude Code hook input), dispatches to the
 * appropriate handler, and writes JSON to stdout (hook output).
 */
import { getDb } from '../db/connection.js';
import { runMigrations } from '../db/migration.js';
import { loadConfig } from '../db/config.js';
import { ConversationStore } from '../core/conversation-store.js';
import { SummaryStore } from '../core/summary-store.js';
import { logger } from '../utils/logger.js';
export async function runHook(handler) {
    let input;
    try {
        const stdin = fs.readFileSync('/dev/stdin', 'utf8');
        input = JSON.parse(stdin);
    }
    catch {
        // No stdin or not JSON — still run with minimal input
        input = {
            session_id: process.env['CLAUDE_SESSION_ID'] ?? 'unknown',
            transcript_path: '',
            cwd: process.cwd(),
            permission_mode: 'default',
            hook_event_name: 'unknown',
        };
    }
    const config = loadConfig();
    if (!config.enabled) {
        process.exit(0);
    }
    const db = getDb(config.databasePath);
    try {
        runMigrations(db);
    }
    catch (err) {
        logger.error('Migration failed', err);
        process.exit(0); // Don't block Claude on DB errors
    }
    const conversationStore = new ConversationStore(db);
    const summaryStore = new SummaryStore(db);
    const ctx = { input, conversationStore, summaryStore, config };
    let output = {};
    try {
        output = await handler(ctx);
    }
    catch (err) {
        logger.error('Hook handler error', err);
        // Don't block Claude on LCM errors
    }
    if (Object.keys(output).length > 0) {
        process.stdout.write(JSON.stringify(output) + '\n');
    }
    process.exit(0);
}
// Need fs for stdin reading
import fs from 'node:fs';
//# sourceMappingURL=orchestrator.js.map