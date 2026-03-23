export interface LcmConfig {
    /** Path to the SQLite database file */
    databasePath: string;
    /** Number of recent messages protected from compaction */
    freshTailCount: number;
    /** Max tokens to inject in PostCompact hook */
    postCompactInjectionTokens: number;
    /** Whether LCM is enabled */
    enabled: boolean;
}
export declare function loadConfig(): LcmConfig;
//# sourceMappingURL=config.d.ts.map