/**
 * Granular summarization via Haiku.
 * Used by the Stop hook when ANTHROPIC_API_KEY (or LCM_ANTHROPIC_API_KEY) is set,
 * to create fine-grained level-0 summaries every ~20K tokens — same approach as lossless-claw.
 */
import type { LcmMessage } from './types.js';
export declare function summarizeMessages(messages: LcmMessage[], apiKey: string): Promise<string>;
//# sourceMappingURL=summarize.d.ts.map