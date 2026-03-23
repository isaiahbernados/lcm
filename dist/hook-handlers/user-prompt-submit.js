#!/usr/bin/env node
/**
 * UserPromptSubmit hook handler (async).
 * Ingests new messages from the transcript into SQLite.
 */
import { runHook } from './orchestrator.js';
import { ingestNewMessages } from './ingest.js';
async function handler(ctx) {
    const { input, conversationStore, summaryStore } = ctx;
    if (!input.transcript_path)
        return {};
    await ingestNewMessages(input.transcript_path, input.session_id, input.cwd ?? '', conversationStore, summaryStore);
    return {};
}
runHook(handler);
//# sourceMappingURL=user-prompt-submit.js.map