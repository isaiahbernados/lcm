/**
 * Assembles context to re-inject after Claude's compaction.
 * Selects the most important summaries within a token budget.
 */
import { logger } from '../utils/logger.js';
export class ContextAssembler {
    conversationStore;
    summaryStore;
    constructor(conversationStore, summaryStore) {
        this.conversationStore = conversationStore;
        this.summaryStore = summaryStore;
    }
    /**
     * Build the additionalContext string to inject via PostCompact hook.
     * Returns null if there's nothing useful to inject.
     */
    buildPostCompactContext(conversationId, tokenBudget) {
        const summaries = this.summaryStore.getTopSummaries(conversationId, tokenBudget);
        const contextItems = this.summaryStore.getContextItems(conversationId, 0.5);
        if (summaries.length === 0 && contextItems.length === 0) {
            logger.debug('No summaries or context items to inject', { conversationId });
            return null;
        }
        const parts = [
            '<lcm-restored-context>',
            '## Conversation Memory (LCM)',
            '',
            'The following context was preserved across compaction:',
            '',
        ];
        if (summaries.length > 0) {
            parts.push('### Conversation Summaries');
            parts.push('');
            for (const summary of summaries) {
                const levelLabel = summary.level === 0 ? 'Recent' : `Level ${summary.level}`;
                parts.push(`**[${levelLabel} — messages ${summary.messageRangeStart}–${summary.messageRangeEnd}]**`);
                parts.push(summary.content);
                parts.push('');
            }
        }
        if (contextItems.length > 0) {
            parts.push('### Key Context Items');
            parts.push('');
            for (const item of contextItems.slice(0, 10)) {
                parts.push(`- **[${item.category}]** ${item.content}`);
            }
            parts.push('');
        }
        parts.push('> Use `lcm_grep` or `lcm_expand` tools to retrieve full details on any topic above.');
        parts.push('</lcm-restored-context>');
        return parts.join('\n');
    }
}
//# sourceMappingURL=context-assembler.js.map