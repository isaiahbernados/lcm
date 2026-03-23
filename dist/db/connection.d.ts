import { DatabaseSync } from 'node:sqlite';
export type Db = DatabaseSync;
export declare function getDb(dbPath: string): DatabaseSync;
export declare function closeDb(): void;
//# sourceMappingURL=connection.d.ts.map