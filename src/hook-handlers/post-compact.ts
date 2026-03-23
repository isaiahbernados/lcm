#!/usr/bin/env node
/**
 * PostCompact hook handler (sync).
 *
 * Runs after Claude's built-in compaction. Assembles a summary context block
 * from LCM's stored summaries and injects it back into the conversation.
 */

import { runHook } from './orchestrator.js';
import type { HookContext } from './orchestrator.js';
import type { HookOutput } from '../core/types.js';
import { ContextAssembler } from '../core/context-assembler.js';
import { logger } from '../utils/logger.js';

async function handler(ctx: HookContext): Promise<HookOutput> {
  const { input, conversationStore, summaryStore, config } = ctx;

  const conversation = conversationStore.getConversationBySession(input.session_id);
  if (!conversation) return {};

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
