---
name: lcm-usage
description: How and when to use LCM tools (lcm_grep, lcm_describe, lcm_expand, lcm_expand_query) to retrieve conversation history that was compacted
autoload: true
---

# Lossless Context Management (LCM)

Your conversation history is fully preserved by LCM even after context compaction. When the active context window doesn't contain information you need, use these tools to search and retrieve it.

## When to use LCM tools

- After context compaction, when you need details from earlier in the conversation
- When the user references something discussed "earlier" or "before"
- When you need to verify a decision, file path, or approach from a previous turn
- When working on a task that spans multiple compaction cycles
- When you're unsure what was already discussed or decided

## Tools available

### `lcm_grep` — Search conversation history
Search all stored messages by keyword or phrase. Results are grouped by the summary node that covers them.
```
lcm_grep(query: "authentication bug")
lcm_grep(query: "database schema", limit: 10)
lcm_grep(query: "login flow", summary_id: "sum_abc123")
```

### `lcm_describe` — Inspect a specific item
Get metadata and content for a summary (sum_...) or message (msg_...) by ID.
```
lcm_describe(id: "sum_abc123")
lcm_describe(id: "msg_xyz789")
```

### `lcm_expand` — Retrieve original messages from a summary
Expand a summary back to its source messages.
```
lcm_expand(summary_id: "sum_abc123")
lcm_expand(summary_id: "sum_abc123", depth: 2, token_cap: 4000)
```

### `lcm_expand_query` — Search + expand in one step
Find relevant history and immediately retrieve the full messages.
```
lcm_expand_query(query: "the login flow we discussed")
lcm_expand_query(query: "error handling approach", max_results: 3)
```

## Retrieval workflow

1. Start with `lcm_grep` to find what you're looking for
2. Use `lcm_describe` on promising IDs to see metadata
3. Use `lcm_expand` to retrieve full original messages
4. Or use `lcm_expand_query` to do steps 1-3 in one call

