/**
 * Granular summarization via Haiku.
 * Used by the Stop hook when ANTHROPIC_API_KEY (or LCM_ANTHROPIC_API_KEY) is set,
 * to create fine-grained level-0 summaries every ~20K tokens — same approach as lossless-claw.
 */
import Anthropic from '@anthropic-ai/sdk';
const SUMMARIZE_PROMPT = `Summarize the key facts, decisions, code changes, file paths, and context from this conversation segment. Be concise but preserve important specifics that would be needed to continue this work:`;
export async function summarizeMessages(messages, apiKey) {
    const client = new Anthropic({ apiKey });
    const content = messages
        .map((m) => `[${m.role}]: ${m.content.slice(0, 2000)}`)
        .join('\n\n---\n\n');
    const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        messages: [{ role: 'user', content: `${SUMMARIZE_PROMPT}\n\n${content}` }],
    });
    const block = response.content[0];
    return block.type === 'text' ? block.text : '';
}
//# sourceMappingURL=summarize.js.map