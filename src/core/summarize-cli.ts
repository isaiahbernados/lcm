/**
 * Granular summarization via `claude -p` subprocess.
 * Uses the existing Claude Code subscription — no separate API key required.
 * Enabled by setting LCM_USE_CLI=true.
 *
 * Recursion guard: sets LCM_SUBPROCESS=1 in the child environment so the
 * child session's Stop hook exits early and doesn't trigger another summarization.
 *
 * Three-level escalation mirrors the SDK path in summarize.ts.
 */

import { spawn } from 'node:child_process';
import type { LcmMessage } from './types.js';
import type { SummarizeMode } from './summarize.js';
import { deterministicTruncate } from './summarize.js';
import { estimateTokens } from './transcript-reader.js';

const CLAUDE_CLI = process.env['LCM_CLAUDE_CMD'] ?? 'claude';
const CLAUDE_MODEL = process.env['LCM_CLI_MODEL'] ?? 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 8000;

const PROMPTS: Record<SummarizeMode, string> = {
  preserve_details:
    'Summarize the key facts, decisions, code changes, file paths, and context from this conversation segment. Be concise but preserve important specifics:',
  bullet_points:
    'Summarize as concise bullet points. Include only: key decisions, file paths changed, and critical state. One bullet per fact:',
};

export async function summarizeWithCLI(
  messages: LcmMessage[],
  options?: { mode?: SummarizeMode },
): Promise<string> {
  const mode = options?.mode ?? 'preserve_details';
  const content = messages
    .map((m) => `[${m.role}]: ${m.content.slice(0, 2000)}`)
    .join('\n\n---\n\n');
  const prompt = `${PROMPTS[mode]}\n\n${content}`;

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_CLI, ['-p', '--model', CLAUDE_MODEL], {
      env: { ...process.env, LCM_SUBPROCESS: '1' },
    });

    let output = '';
    let error = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('claude -p timed out after 8s'));
    }, TIMEOUT_MS);

    child.stdin.write(prompt);
    child.stdin.end();
    child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { error += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && output.trim()) {
        resolve(output.trim());
      } else {
        reject(new Error(`claude -p failed (exit ${code}): ${error.slice(0, 200)}`));
      }
    });
  });
}

/**
 * Three-level summarization escalation via CLI with guaranteed convergence.
 */
export async function summarizeWithCLIEscalation(
  messages: LcmMessage[],
  targetTokens: number = 512,
): Promise<{ text: string; level: number }> {
  const inputTokens = messages.reduce((sum, m) => sum + m.tokenCount, 0);

  // Level 1 — preserve_details
  const l1 = await summarizeWithCLI(messages, { mode: 'preserve_details' });
  if (estimateTokens(l1) < inputTokens) {
    return { text: l1, level: 1 };
  }

  // Level 2 — bullet_points
  const l2 = await summarizeWithCLI(messages, { mode: 'bullet_points' });
  if (estimateTokens(l2) < inputTokens) {
    return { text: l2, level: 2 };
  }

  // Level 3 — deterministic truncation (guaranteed convergence)
  const l3 = deterministicTruncate(messages, 512);
  return { text: l3, level: 3 };
}
