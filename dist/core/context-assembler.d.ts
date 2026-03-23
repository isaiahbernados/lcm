/**
 * Assembles context to re-inject after Claude's compaction.
 * Selects the most important summaries within a token budget.
 */
import type { SummaryStore } from './summary-store.js';
import type { ConversationStore } from './conversation-store.js';
export declare class ContextAssembler {
    private conversationStore;
    private summaryStore;
    constructor(conversationStore: ConversationStore, summaryStore: SummaryStore);
    /**
     * Build the additionalContext string to inject via PostCompact hook.
     * Returns null if there's nothing useful to inject.
     */
    buildPostCompactContext(conversationId: string, tokenBudget: number): string | null;
}
//# sourceMappingURL=context-assembler.d.ts.map