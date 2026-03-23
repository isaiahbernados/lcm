/**
 * Main hook orchestrator. Each hook handler entry point calls into this.
 *
 * Reads JSON from stdin (Claude Code hook input), dispatches to the
 * appropriate handler, and writes JSON to stdout (hook output).
 */
import { loadConfig } from '../db/config.js';
import { ConversationStore } from '../core/conversation-store.js';
import { SummaryStore } from '../core/summary-store.js';
import type { HookInput, HookOutput } from '../core/types.js';
export interface HookContext {
    input: HookInput;
    conversationStore: ConversationStore;
    summaryStore: SummaryStore;
    config: ReturnType<typeof loadConfig>;
}
export type HookHandler = (ctx: HookContext) => Promise<HookOutput>;
export declare function runHook(handler: HookHandler): Promise<void>;
//# sourceMappingURL=orchestrator.d.ts.map