/**
 * LLM-powered summarization using claude-haiku with deterministic fallback.
 *
 * Three-tier escalation:
 *   1. Normal: standard summarization targeting 35% compression
 *   2. Aggressive: targeting 20% compression when output >= input
 *   3. Deterministic: extractive truncation when LLM unavailable/failing
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../utils/logger.js';
import { estimateTokens } from './transcript-reader.js';

const TIMEOUT_MS = 60_000;

function buildPrompt(level: number, aggressive: boolean): string {
  const ratio = aggressive ? '20%' : '35%';

  if (level === 0) {
    return `You are compressing a segment of a conversation into a dense summary.
Preserve ALL important facts, decisions, file paths, code details, error messages, and task context.
Target length: approximately ${ratio} of the input length.
Output ONLY the summary text with no preamble.`;
  }

  if (level === 1) {
    return `You are condensing multiple conversation summaries into a single higher-level summary.
Preserve key decisions, active tasks, important technical details, and unresolved issues.
Merge redundant information. Target length: approximately ${ratio} of total input length.
Output ONLY the summary text with no preamble.`;
  }

  return `You are creating a high-level session memory from multiple phase summaries.
Capture the most important decisions, outcomes, and unresolved items.
Target length: approximately ${ratio} of total input length.
Output ONLY the summary text with no preamble.`;
}

/** Deterministic fallback: take first 40% + last 10% of text */
function deterministicSummary(text: string, targetChars = 2048): string {
  if (text.length <= targetChars) return text;
  const head = Math.floor(targetChars * 0.8);
  const tail = targetChars - head;
  return text.slice(0, head) + '\n[...truncated...]\n' + text.slice(-tail);
}

export interface SummarizeFn {
  (messages: Array<{ role: string; content: string }>, level: number): Promise<string>;
}

export function createSummarizeFn(apiKey: string | undefined, model: string): SummarizeFn {
  return async function summarize(
    messages: Array<{ role: string; content: string }>,
    level: number
  ): Promise<string> {
    const fullText = messages.map((m) => `[${m.role}]: ${m.content}`).join('\n\n');
    const inputTokens = estimateTokens(fullText);

    if (!apiKey) {
      logger.warn('No Anthropic API key — using deterministic summarization');
      return deterministicSummary(fullText, Math.floor(fullText.length * 0.35));
    }

    const client = new Anthropic({ apiKey });

    // Try normal, then aggressive, then deterministic
    for (const aggressive of [false, true]) {
      try {
        const result = await Promise.race([
          client.messages.create({
            model,
            max_tokens: Math.max(512, Math.floor(inputTokens * (aggressive ? 0.2 : 0.35))),
            system: buildPrompt(level, aggressive),
            messages: [{ role: 'user', content: fullText }],
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Summarization timeout')), TIMEOUT_MS)
          ),
        ]);

        const text = result.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('');

        if (!text.trim()) {
          logger.warn('Empty summarization response, retrying aggressive');
          continue;
        }

        return text;
      } catch (err) {
        logger.warn('Summarization attempt failed', { aggressive, err: String(err) });
        if (!aggressive) continue; // Try aggressive next
      }
    }

    // Deterministic fallback
    logger.warn('Falling back to deterministic summarization');
    return deterministicSummary(fullText, Math.floor(fullText.length * 0.35));
  };
}
