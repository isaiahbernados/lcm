/**
 * Granular summarization via `claude -p` subprocess.
 * Uses the existing Claude Code subscription — no separate API key required.
 * Enabled by setting LCM_USE_CLI=true.
 *
 * Recursion guard: sets LCM_SUBPROCESS=1 in the child environment so the
 * child session's Stop hook exits early and doesn't trigger another summarization.
 */
import type { LcmMessage } from './types.js';
export declare function summarizeWithCLI(messages: LcmMessage[]): Promise<string>;
//# sourceMappingURL=summarize-cli.d.ts.map