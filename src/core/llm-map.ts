/**
 * llm_map — processes each line of a JSONL file through the Anthropic API
 * with a prompt template, writing results to an output JSONL file.
 */

import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';

// ---------------------------------------------------------------------------
// Semaphore
// ---------------------------------------------------------------------------

export class Semaphore {
  private max: number;
  private current: number = 0;
  private queue: Array<() => void> = [];

  constructor(max: number) {
    this.max = max;
  }

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.current--;
    }
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LlmMapOptions {
  inputPath: string;
  outputPath: string;
  promptTemplate: string; // {{line}} placeholder
  model?: string; // default 'claude-haiku-4-5-20251001'
  maxConcurrency?: number; // default 5, max 20
  outputSchema?: Record<string, unknown>; // optional JSON Schema validation
  apiKey: string;
}

export interface LlmMapResult {
  processed: number;
  succeeded: number;
  failed: number;
  errors: Array<{ line: number; error: string }>;
  outputPath: string;
}

// ---------------------------------------------------------------------------
// Schema validation (basic type/required check)
// ---------------------------------------------------------------------------

function validateSchema(data: unknown, schema: Record<string, unknown>): string | null {
  if (typeof data !== 'object' || data === null) {
    return 'Response is not a JSON object';
  }

  const obj = data as Record<string, unknown>;

  // Check required fields
  const required = schema['required'];
  if (Array.isArray(required)) {
    for (const field of required) {
      if (!(field in obj)) {
        return `Missing required field: ${field}`;
      }
    }
  }

  // Check property types
  const properties = schema['properties'];
  if (properties && typeof properties === 'object') {
    const props = properties as Record<string, Record<string, unknown>>;
    for (const [key, propSchema] of Object.entries(props)) {
      if (key in obj && propSchema['type']) {
        const expectedType = propSchema['type'] as string;
        const actualType = Array.isArray(obj[key]) ? 'array' : typeof obj[key];
        if (actualType !== expectedType) {
          return `Field "${key}" should be ${expectedType}, got ${actualType}`;
        }
      }
    }
  }

  return null; // valid
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

export async function llmMap(options: LlmMapOptions): Promise<LlmMapResult> {
  const {
    inputPath,
    outputPath,
    promptTemplate,
    model = 'claude-haiku-4-5-20251001',
    maxConcurrency = 5,
    outputSchema,
    apiKey,
  } = options;

  const concurrency = Math.min(20, Math.max(1, maxConcurrency));

  // Read input file, split into non-empty lines
  const inputContent = fs.readFileSync(inputPath, 'utf-8');
  const lines = inputContent.split('\n').filter((l) => l.trim() !== '');

  const client = new Anthropic({ apiKey });
  const semaphore = new Semaphore(concurrency);

  const results: Array<{ lineIndex: number; output: string | null; error: string | null }> = new Array(lines.length);
  const errors: Array<{ line: number; error: string }> = [];

  async function processLine(lineContent: string, lineIndex: number): Promise<void> {
    await semaphore.acquire();
    try {
      const prompt = promptTemplate.replace(/\{\{line\}\}/g, lineContent);

      let responseText: string;

      if (outputSchema) {
        // With schema: parse as JSON, validate, retry once on failure
        const schemaPrompt = `${prompt}\n\nRespond with valid JSON only. No markdown, no explanation.`;

        const firstResponse = await client.messages.create({
          model,
          max_tokens: 1024,
          messages: [{ role: 'user', content: schemaPrompt }],
        });

        const firstText = extractText(firstResponse);
        const firstParsed = tryParseJson(firstText);

        if (firstParsed !== null) {
          const validationError = validateSchema(firstParsed, outputSchema);
          if (validationError === null) {
            responseText = firstText;
          } else {
            // Retry with error feedback
            const retryResponse = await client.messages.create({
              model,
              max_tokens: 1024,
              messages: [
                { role: 'user', content: schemaPrompt },
                { role: 'assistant', content: firstText },
                {
                  role: 'user',
                  content: `The previous response had a validation error: ${validationError}. Please fix and respond with valid JSON only.`,
                },
              ],
            });
            const retryText = extractText(retryResponse);
            const retryParsed = tryParseJson(retryText);
            if (retryParsed === null) {
              throw new Error(`Retry response was not valid JSON`);
            }
            const retryValidationError = validateSchema(retryParsed, outputSchema);
            if (retryValidationError !== null) {
              throw new Error(`Retry response failed schema validation: ${retryValidationError}`);
            }
            responseText = retryText;
          }
        } else {
          // First response wasn't valid JSON, retry
          const retryResponse = await client.messages.create({
            model,
            max_tokens: 1024,
            messages: [
              { role: 'user', content: schemaPrompt },
              { role: 'assistant', content: firstText },
              {
                role: 'user',
                content: `The previous response was not valid JSON. Please respond with valid JSON only, no markdown or explanation.`,
              },
            ],
          });
          const retryText = extractText(retryResponse);
          const retryParsed = tryParseJson(retryText);
          if (retryParsed === null) {
            throw new Error(`Retry response was not valid JSON`);
          }
          const retryValidationError = validateSchema(retryParsed, outputSchema);
          if (retryValidationError !== null) {
            throw new Error(`Retry response failed schema validation: ${retryValidationError}`);
          }
          responseText = retryText;
        }
      } else {
        const response = await client.messages.create({
          model,
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }],
        });
        responseText = extractText(response);
      }

      results[lineIndex] = { lineIndex, output: responseText, error: null };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      results[lineIndex] = { lineIndex, output: null, error: errorMsg };
      errors.push({ line: lineIndex + 1, error: errorMsg });
    } finally {
      semaphore.release();
    }
  }

  // Launch all tasks concurrently (semaphore limits actual concurrency)
  await Promise.all(lines.map((line, i) => processLine(line, i)));

  // Write output JSONL
  const outputLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const r = results[i];
    if (r.error !== null) {
      outputLines.push(JSON.stringify({ input: lines[i], output: null, error: r.error }));
    } else {
      outputLines.push(JSON.stringify({ input: lines[i], output: r.output }));
    }
  }

  fs.writeFileSync(outputPath, outputLines.join('\n') + (outputLines.length > 0 ? '\n' : ''));

  const succeeded = results.filter((r) => r?.error === null).length;
  const failed = results.filter((r) => r?.error !== null).length;

  return {
    processed: lines.length,
    succeeded,
    failed,
    errors,
    outputPath,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractText(response: Anthropic.Message): string {
  const textBlock = response.content.find((b) => b.type === 'text');
  return textBlock && textBlock.type === 'text' ? textBlock.text : '';
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    return null;
  }
}
