#!/usr/bin/env node
/**
 * Stop hook handler (async).
 * Ingests the assistant's response + tool results after Claude finishes.
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
//# sourceMappingURL=stop.js.map