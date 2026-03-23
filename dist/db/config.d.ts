export interface LcmConfig {
    /** Path to the SQLite database file */
    databasePath: string;
    /** Number of recent messages protected from compaction */
    freshTailCount: number;
    /** Max tokens to inject in PostCompact hook */
    postCompactInjectionTokens: number;
    /** Whether LCM is enabled */
    enabled: boolean;
    /** Anthropic API key for granular compaction (optional). If set, summarizes every ~granularCompactThreshold tokens using Haiku. */
    anthropicApiKey: string | null;
    /** Token threshold for triggering a granular summary (requires anthropicApiKey or useCliSummarizer). Default 20000. */
    granularCompactThreshold: number;
    /** Use `claude -p` subprocess for granular compaction instead of Haiku SDK. Free (uses subscription). Set LCM_USE_CLI=true. */
    useCliSummarizer: boolean;
}
export declare function loadConfig(): LcmConfig;
//# sourceMappingURL=config.d.ts.map