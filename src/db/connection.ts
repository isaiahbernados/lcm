import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

export type Db = DatabaseSync;

let _db: DatabaseSync | null = null;

export function getDb(dbPath: string): DatabaseSync {
  if (_db) return _db;

  // Ensure directory exists
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  _db = new DatabaseSync(dbPath);

  // WAL mode for concurrent read access (MCP server + hooks)
  _db.exec('PRAGMA journal_mode=WAL');
  _db.exec('PRAGMA busy_timeout=5000');
  _db.exec('PRAGMA foreign_keys=ON');
  _db.exec('PRAGMA synchronous=NORMAL');

  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
