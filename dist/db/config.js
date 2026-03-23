import path from 'node:path';
import os from 'node:os';
function defaultDbPath() {
    return path.join(os.homedir(), '.lcm', 'lcm.db');
}
export function loadConfig() {
    return {
        databasePath: process.env['LCM_DB_PATH'] ?? defaultDbPath(),
        freshTailCount: parseInt(process.env['LCM_FRESH_TAIL_COUNT'] ?? '32', 10),
        postCompactInjectionTokens: parseInt(process.env['LCM_POST_COMPACT_TOKENS'] ?? '3000', 10),
        enabled: (process.env['LCM_ENABLED'] ?? 'true') !== 'false',
        anthropicApiKey: process.env['LCM_ANTHROPIC_API_KEY'] ?? process.env['ANTHROPIC_API_KEY'] ?? null,
        granularCompactThreshold: parseInt(process.env['LCM_GRANULAR_THRESHOLD'] ?? '20000', 10),
    };
}
//# sourceMappingURL=config.js.map