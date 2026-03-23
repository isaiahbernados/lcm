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

import fs from 'node:fs';
import type { TranscriptEntry, TranscriptCursor } from './types.js';

/** Estimate token count: ~4 chars per token */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Extract plain-text content from a message content field */
function extractContent(
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>
): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => {
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
      if (block.type === 'tool_use') {
        const name = block['name'] as string | undefined;
        const input = block['input'];
        return `[tool_use: ${name ?? 'unknown'} ${JSON.stringify(input ?? {})}]`;
      }
      if (block.type === 'tool_result') {
        const toolContent = block['content'];
        if (typeof toolContent === 'string') return `[tool_result: ${toolContent}]`;
        if (Array.isArray(toolContent)) {
          return `[tool_result: ${(toolContent as Array<{ text?: string }>)
            .map((b) => b.text ?? '')
            .join(' ')}]`;
        }
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

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
export function readNewTranscriptEntries(
  transcriptPath: string,
  cursor: TranscriptCursor
): { messages: ParsedMessage[]; updatedCursor: TranscriptCursor } {
  let fileContent: string;
  let fileSize: number;

  try {
    const stat = fs.statSync(transcriptPath);
    fileSize = stat.size;
    if (fileSize <= cursor.byteOffset) {
      return { messages: [], updatedCursor: cursor };
    }

    const fd = fs.openSync(transcriptPath, 'r');
    const buffer = Buffer.alloc(fileSize - cursor.byteOffset);
    fs.readSync(fd, buffer, 0, buffer.length, cursor.byteOffset);
    fs.closeSync(fd);
    fileContent = buffer.toString('utf8');
  } catch {
    return { messages: [], updatedCursor: cursor };
  }

  const lines = fileContent.split('\n').filter((l) => l.trim());
  const messages: ParsedMessage[] = [];
  let lastTimestamp = cursor.lastTimestamp;

  for (const line of lines) {
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();
    if (ts > lastTimestamp) lastTimestamp = ts;

    if (entry.type === 'user' || entry.type === 'assistant') {
      const raw = entry.message.content;
      const content = extractContent(raw);
      if (!content.trim()) continue;

      // Check for tool_use / tool_result blocks inside content
      if (Array.isArray(entry.message.content)) {
        for (const block of entry.message.content) {
          if (block.type === 'tool_use') {
            const toolContent = `[tool_use: ${block['name'] ?? 'unknown'} ${JSON.stringify(block['input'] ?? {})}]`;
            messages.push({
              role: 'tool_use',
              content: toolContent,
              timestamp: ts,
              metadata: { tool_name: block['name'], tool_use_id: block['id'] },
            });
          } else if (block.type === 'tool_result') {
            const resultContent =
              typeof block['content'] === 'string'
                ? block['content']
                : JSON.stringify(block['content'] ?? '');
            messages.push({
              role: 'tool_result',
              content: resultContent,
              timestamp: ts,
              metadata: { tool_use_id: block['tool_use_id'] },
            });
          } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            messages.push({ role: entry.type, content: block.text, timestamp: ts });
          }
        }
      } else {
        messages.push({ role: entry.type, content, timestamp: ts });
      }
    } else if (entry.type === 'system') {
      const content = (entry as { content?: string }).content;
      if (content?.trim()) {
        messages.push({ role: 'system', content, timestamp: ts });
      }
    }
  }

  return {
    messages,
    updatedCursor: {
      sessionId: cursor.sessionId,
      byteOffset: fileSize,
      lastTimestamp,
    },
  };
}
