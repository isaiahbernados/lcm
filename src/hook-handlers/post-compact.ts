#!/usr/bin/env node
/**
 * PostCompact hook handler (sync).
 *
 * Runs after Claude's built-in compaction.
 * 1. Captures `compact_summary` (Claude's own generated summary) → stored in SQLite for free
 * 2. Re-injects stored summaries as additionalContext so Claude has its full history
 */

import { runHook } from './orchestrator.js';
import type { HookContext } from './orchestrator.js';
import type { HookOutput } from '../core/types.js';
import { ContextAssembler } from '../core/context-assembler.js';
import { estimateTokens } from '../core/transcript-reader.js';
import { logger } from '../utils/logger.js';

async function handler(ctx: HookContext): Promise<HookOutput> {
  const { input, conversationStore, summaryStore, config } = ctx;

  const conversation = conversationStore.getOrCreateConversation(input.session_id, input.cwd ?? '');

  // Capture the summary Claude Code just generated — free, uses subscription model
  const compactSummary = (input['compact_summary'] as string | undefined)?.trim();
  if (compactSummary) {
    const msgCount = conversationStore.getMessageCount(conversation.id);
    const rangeEnd = Math.max(0, msgCount - 1);
    const existingMax = summaryStore.getMaxCompactedSequence(conversation.id);
    const rangeStart = Math.max(0, existingMax + 1);

    summaryStore.insertSummary({
      conversationId: conversation.id,
      parentId: null,
      level: 0,
      content: compactSummary,
      tokenCount: estimateTokens(compactSummary),
      messageRangeStart: rangeStart,
      messageRangeEnd: rangeEnd,
    });

    logger.info('PostCompact: stored Claude-generated summary', {
      tokens: estimateTokens(compactSummary),
      range: `${rangeStart}-${rangeEnd}`,
    });
  }

  // Re-inject accumulated summaries as context
  const assembler = new ContextAssembler(conversationStore, summaryStore);
  const contextBlock = assembler.buildPostCompactContext(
    conversation.id,
    config.postCompactInjectionTokens
  );

  if (!contextBlock) {
    logger.debug('PostCompact: nothing to inject');
    return {};
  }

  logger.info('PostCompact: injecting context block');
  return {
    hookSpecificOutput: {
      hookEventName: 'PostCompact',
      additionalContext: contextBlock,
    },
  };
}

runHook(handler);
