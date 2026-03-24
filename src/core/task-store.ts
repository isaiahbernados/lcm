import type { Db } from '../db/connection.js';
import type { LcmTask, TaskStatus } from './types.js';
import { randomUUID } from 'node:crypto';

interface TaskRow {
  id: string;
  conversation_id: string;
  parent_id: string | null;
  title: string;
  description: string;
  status: string;
  delegated_scope: string | null;
  kept_work: string | null;
  result: string | null;
  created_at: number;
  updated_at: number;
}

function rowToTask(row: TaskRow): LcmTask {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    parentId: row.parent_id,
    title: row.title,
    description: row.description,
    status: row.status as TaskStatus,
    delegatedScope: row.delegated_scope,
    keptWork: row.kept_work,
    result: row.result,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class TaskStore {
  constructor(private db: Db) {}

  createTask(params: {
    conversationId: string;
    title: string;
    description?: string;
    parentId?: string;
    delegatedScope?: string;
    keptWork?: string;
  }): LcmTask {
    const id = `task_${randomUUID()}`;
    const now = Date.now();
    const description = params.description ?? '';
    const parentId = params.parentId ?? null;
    const delegatedScope = params.delegatedScope ?? null;
    const keptWork = params.keptWork ?? null;

    this.db.prepare(
      `INSERT INTO tasks
         (id, conversation_id, parent_id, title, description, status, delegated_scope, kept_work, result, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, ?, ?)`
    ).run(id, params.conversationId, parentId, params.title, description, delegatedScope, keptWork, now, now);

    return {
      id,
      conversationId: params.conversationId,
      parentId,
      title: params.title,
      description,
      status: 'pending',
      delegatedScope,
      keptWork,
      result: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  getTask(taskId: string): LcmTask | null {
    const row = this.db.prepare(
      'SELECT * FROM tasks WHERE id = ?'
    ).get(taskId) as unknown as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  listTasks(filters: { conversationId?: string; status?: string; parentId?: string } = {}): LcmTask[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filters.conversationId !== undefined) {
      conditions.push('conversation_id = ?');
      params.push(filters.conversationId);
    }
    if (filters.status !== undefined) {
      conditions.push('status = ?');
      params.push(filters.status);
    }
    if (filters.parentId !== undefined) {
      conditions.push('parent_id = ?');
      params.push(filters.parentId);
    }

    const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
    const sql = `SELECT * FROM tasks${where} ORDER BY created_at ASC`;
    const rows = this.db.prepare(sql).all(...params) as unknown as TaskRow[];
    return rows.map(rowToTask);
  }

  updateTask(
    taskId: string,
    updates: { status?: string; result?: string; delegatedScope?: string; keptWork?: string }
  ): LcmTask | null {
    const now = Date.now();
    const setClauses: string[] = ['updated_at = ?'];
    const params: (string | number | null)[] = [now];

    if (updates.status !== undefined) {
      setClauses.push('status = ?');
      params.push(updates.status);
    }
    if (updates.result !== undefined) {
      setClauses.push('result = ?');
      params.push(updates.result);
    }
    if (updates.delegatedScope !== undefined) {
      setClauses.push('delegated_scope = ?');
      params.push(updates.delegatedScope);
    }
    if (updates.keptWork !== undefined) {
      setClauses.push('kept_work = ?');
      params.push(updates.keptWork);
    }

    params.push(taskId);
    const sql = `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...params);

    return this.getTask(taskId);
  }
}
