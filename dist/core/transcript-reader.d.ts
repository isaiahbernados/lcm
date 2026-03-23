/**
 * Reads Claude Code's JSONL transcript files incrementally.
 *
 * Claude Code writes transcript entries as newline-delimited JSON to a file
 * at `transcript_path` (provided in hook input). Each entry is a JSON object
 * representing a conversation event.
 *
 * We track the byte offset per session so each hook invocation only processes
 * new lines since the last read.
 */
import type { TranscriptCursor } from './types.js';
/** Estimate token count: ~4 chars per token */
export declare function estimateTokens(text: string): number;
export interface ParsedMessage {
    role: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system';
    content: string;
    timestamp: number;
    metadata?: Record<string, unknown>;
}
/**
 * Reads new lines from `transcriptPath` starting at `cursor.byteOffset`.
 * Returns parsed messages and the updated cursor.
 */
export declare function readNewTranscriptEntries(transcriptPath: string, cursor: TranscriptCursor): {
    messages: ParsedMessage[];
    updatedCursor: TranscriptCursor;
};
//# sourceMappingURL=transcript-reader.d.ts.map