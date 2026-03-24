/**
 * Granular summarization via Haiku.
 * Used by the Stop hook when ANTHROPIC_API_KEY (or LCM_ANTHROPIC_API_KEY) is set,
 * to create fine-grained level-0 summaries every ~20K tokens — same approach as lossless-claw.
 *
 * Three-level escalation:
 *   Level 1 — preserve_details (detailed summary, target T tokens)
 *   Level 2 — bullet_points   (concise bullets, target T/2 tokens)
 *   Level 3 — deterministicTruncate (pure truncation, guaranteed convergence)
 */

import Anthropic from '@anthropic-ai/sdk';
import type { LcmMessage } from './types.js';
import { estimateTokens } from './transcript-reader.js';

const PROMPTS = {
  preserve_details:
    'Summarize the key facts, decisions, code changes, file paths, and context from this conversation segment. Be concise but preserve important specifics that would be needed to continue this work:',
  bullet_points:
    'Summarize as concise bullet points. Include only: key decisions, file paths changed, and critical state. One bullet per fact:',
} as const;

export type SummarizeMode = 'preserve_details' | 'bullet_points';

/**
 * Deterministic truncation fallback (level 3).
 * Concatenates messages in `[role]: content` format and hard-truncates
 * at `maxTokens * 4` characters (matching the estimateTokens heuristic of length/4).
 * Pure function — no LLM call, guaranteed to converge.
 */
export function deterministicTruncate(messages: LcmMessage[], maxTokens: number): string {
  const full = messages
    .map((m) => `[${m.role}]: ${m.content}`)
    .join('\n\n---\n\n');

  const charLimit = maxTokens * 4;
  return full.slice(0, charLimit);
}

export async function summarizeMessages(
  messages: LcmMessage[],
  apiKey: string,
  options?: { mode?: SummarizeMode; targetTokens?: number },
): Promise<string> {
  const mode = options?.mode ?? 'preserve_details';
  const targetTokens = options?.targetTokens ?? 512;
  const client = new Anthropic({ apiKey });

  const content = messages
    .map((m) => `[${m.role}]: ${m.content.slice(0, 2000)}`)
    .join('\n\n---\n\n');

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: targetTokens,
    messages: [{ role: 'user', content: `${PROMPTS[mode]}\n\n${content}` }],
  });

  const block = response.content[0];
  return block.type === 'text' ? block.text : '';
}

/**
 * Three-level summarization escalation with guaranteed convergence.
 *
 * 1. preserve_details at targetTokens
 * 2. bullet_points   at targetTokens / 2  (if level 1 did not shrink)
 * 3. deterministicTruncate at 512          (guaranteed fallback)
 */
export async function summarizeWithEscalation(
  messages: LcmMessage[],
  apiKey: string,
  targetTokens: number = 512,
): Promise<{ text: string; level: number }> {
  const inputTokens = messages.reduce((sum, m) => sum + m.tokenCount, 0);

  // Level 1 — preserve_details
  const l1 = await summarizeMessages(messages, apiKey, { mode: 'preserve_details', targetTokens });
  if (estimateTokens(l1) < inputTokens) {
    return { text: l1, level: 1 };
  }

  // Level 2 — bullet_points at half budget
  const l2 = await summarizeMessages(messages, apiKey, {
    mode: 'bullet_points',
    targetTokens: Math.floor(targetTokens / 2),
  });
  if (estimateTokens(l2) < inputTokens) {
    return { text: l2, level: 2 };
  }

  // Level 3 — deterministic truncation (guaranteed convergence)
  const l3 = deterministicTruncate(messages, 512);
  return { text: l3, level: 3 };
}
