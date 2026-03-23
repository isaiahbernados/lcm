#!/usr/bin/env node
/**
 * SessionStart hook handler.
 *
 * - Initializes DB for this session
 * - Injects prior session context if available (cross-session continuity)
 */
import { runHook } from './orchestrator.js';
import { ingestNewMessages } from './ingest.js';
import { logger } from '../utils/logger.js';
async function handler(ctx) {
    const { input, conversationStore, summaryStore, config } = ctx;
    const sessionId = input.session_id;
    const projectPath = input.cwd ?? '';
    // Ingest any messages already in transcript (e.g. session resumed)
    if (input.transcript_path) {
        await ingestNewMessages(input.transcript_path, sessionId, projectPath, conversationStore, summaryStore);
    }
    // Check if there are summaries from previous compactions to inject
    const conversation = conversationStore.getConversationBySession(sessionId);
    if (!conversation) {
        logger.debug('SessionStart: no existing conversation', { sessionId });
        return {};
    }
    const summaries = summaryStore.getTopSummaries(conversation.id, config.postCompactInjectionTokens);
    if (summaries.length === 0)
        return {};
    const contextBlock = buildContextBlock(summaries.map((s) => s.content));
    return {
        hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: contextBlock,
        },
    };
}
function buildContextBlock(summaryTexts) {
    return [
        '<lcm-session-context>',
        '## Prior Session Memory (LCM)',
        '',
        'The following context was preserved from earlier in this conversation:',
        '',
        ...summaryTexts.map((t, i) => `### Summary ${i + 1}\n${t}`),
        '',
        'Use lcm_grep or lcm_expand tools to retrieve full details on any topic.',
        '</lcm-session-context>',
    ].join('\n');
}
runHook(handler);
//# sourceMappingURL=session-start.js.map