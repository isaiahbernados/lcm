/**
 * Granular summarization via `claude -p` subprocess.
 * Uses the existing Claude Code subscription — no separate API key required.
 * Enabled by setting LCM_USE_CLI=true.
 *
 * Recursion guard: sets LCM_SUBPROCESS=1 in the child environment so the
 * child session's Stop hook exits early and doesn't trigger another summarization.
 */
import { spawn } from 'node:child_process';
const CLAUDE_CLI = process.env['LCM_CLAUDE_CMD'] ?? 'claude';
const CLAUDE_MODEL = process.env['LCM_CLI_MODEL'] ?? 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 8000;
const SUMMARIZE_PROMPT = `Summarize the key facts, decisions, code changes, file paths, and context from this conversation segment. Be concise but preserve important specifics:`;
export async function summarizeWithCLI(messages) {
    const content = messages
        .map((m) => `[${m.role}]: ${m.content.slice(0, 2000)}`)
        .join('\n\n---\n\n');
    const prompt = `${SUMMARIZE_PROMPT}\n\n${content}`;
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
        child.stdout.on('data', (d) => { output += d.toString(); });
        child.stderr.on('data', (d) => { error += d.toString(); });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0 && output.trim()) {
                resolve(output.trim());
            }
            else {
                reject(new Error(`claude -p failed (exit ${code}): ${error.slice(0, 200)}`));
            }
        });
    });
}
//# sourceMappingURL=summarize-cli.js.map