import type { FileType } from './types.js';

/**
 * Heuristic detection of file type from content string.
 * No LLM calls — purely deterministic.
 */
export function detectFileType(content: string): FileType {
  // Try JSON
  const trimmed = content.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      // Not valid JSON
    }
  }

  // Check for SQL
  const upperContent = content.toUpperCase();
  if (/CREATE\s+TABLE\b|CREATE\s+VIEW\b|CREATE\s+INDEX\b/.test(upperContent)) {
    return 'sql';
  }

  // Check for XML/HTML
  if (/<[a-zA-Z][a-zA-Z0-9]*[\s/>]/.test(content) || /<!DOCTYPE\s/i.test(content)) {
    return 'xml';
  }

  // Check for code (function/class/import/def keywords)
  if (/\bfunction\s+\w+\s*\(|\bclass\s+\w+|\bimport\s+[\w{*]|\bdef\s+\w+\s*\(|\bexport\s+(function|class|const|default)\b/.test(content)) {
    return 'code';
  }

  return 'text';
}

/**
 * Generate a deterministic structural summary of content.
 * No LLM calls.
 */
export function generateExplorationSummary(content: string, fileType: FileType): string {
  switch (fileType) {
    case 'json':
      return summarizeJson(content);
    case 'code':
      return summarizeCode(content);
    case 'sql':
      return summarizeSql(content);
    default:
      return summarizeFallback(content);
  }
}

function summarizeJson(content: string): string {
  try {
    const parsed = JSON.parse(content.trim());
    const lines: string[] = ['[JSON]'];

    if (Array.isArray(parsed)) {
      lines.push(`Array of ${parsed.length} items`);
      if (parsed.length > 0 && typeof parsed[0] === 'object' && parsed[0] !== null) {
        const keys = Object.keys(parsed[0] as Record<string, unknown>);
        lines.push(`Item keys: ${keys.slice(0, 10).join(', ')}${keys.length > 10 ? ` (+${keys.length - 10} more)` : ''}`);
      }
    } else if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      const keys = Object.keys(obj);
      lines.push(`Object with ${keys.length} top-level keys:`);
      for (const key of keys.slice(0, 20)) {
        const val = obj[key];
        if (Array.isArray(val)) {
          lines.push(`  ${key}: Array(${val.length})`);
        } else if (val === null) {
          lines.push(`  ${key}: null`);
        } else {
          lines.push(`  ${key}: ${typeof val}`);
        }
      }
      if (keys.length > 20) {
        lines.push(`  ... and ${keys.length - 20} more keys`);
      }
    } else {
      lines.push(`Primitive: ${typeof parsed}`);
    }

    return lines.join('\n');
  } catch {
    return summarizeFallback(content);
  }
}

function summarizeCode(content: string): string {
  const lines: string[] = ['[CODE]'];

  // Extract function/class signatures
  const signatures: string[] = [];

  // Match: function X(...), async function X(...)
  const funcMatches = content.matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\([^)]*\)/g);
  for (const m of funcMatches) {
    signatures.push(`function ${m[1]}()`);
  }

  // Match: export function X(...)
  const exportFuncMatches = content.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g);
  for (const m of exportFuncMatches) {
    const sig = `export function ${m[1]}()`;
    if (!signatures.includes(sig)) signatures.push(sig);
  }

  // Match: class X
  const classMatches = content.matchAll(/(?:export\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?/g);
  for (const m of classMatches) {
    signatures.push(`class ${m[1]}`);
  }

  // Match: def X(...) (Python)
  const defMatches = content.matchAll(/def\s+(\w+)\s*\([^)]*\)/g);
  for (const m of defMatches) {
    signatures.push(`def ${m[1]}()`);
  }

  // Match: const/let X = (...) => (arrow functions assigned to variables)
  const arrowMatches = content.matchAll(/(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g);
  for (const m of arrowMatches) {
    signatures.push(`${m[1]} = () =>`);
  }

  // Deduplicate while preserving order
  const seen = new Set<string>();
  const unique = signatures.filter(s => {
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  });

  if (unique.length > 0) {
    lines.push(`Signatures (${unique.length}):`);
    for (const sig of unique.slice(0, 30)) {
      lines.push(`  ${sig}`);
    }
    if (unique.length > 30) {
      lines.push(`  ... and ${unique.length - 30} more`);
    }
  } else {
    lines.push('No function/class signatures detected');
    lines.push(content.slice(0, 300) + (content.length > 300 ? '...' : ''));
  }

  return lines.join('\n');
}

function summarizeSql(content: string): string {
  const lines: string[] = ['[SQL]'];
  const statements: string[] = [];

  const tableMatches = content.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\S+)/gi);
  for (const m of tableMatches) {
    statements.push(`CREATE TABLE ${m[1]}`);
  }

  const viewMatches = content.matchAll(/CREATE\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(\S+)/gi);
  for (const m of viewMatches) {
    statements.push(`CREATE VIEW ${m[1]}`);
  }

  const indexMatches = content.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\S+)/gi);
  for (const m of indexMatches) {
    statements.push(`CREATE INDEX ${m[1]}`);
  }

  if (statements.length > 0) {
    lines.push(`Statements (${statements.length}):`);
    for (const stmt of statements) {
      lines.push(`  ${stmt}`);
    }
  } else {
    lines.push('No CREATE TABLE/VIEW/INDEX statements found');
    lines.push(content.slice(0, 300) + (content.length > 300 ? '...' : ''));
  }

  return lines.join('\n');
}

function summarizeFallback(content: string): string {
  const tokenEstimate = Math.ceil(content.length / 4);
  const head = content.slice(0, 500);
  const tail = content.length > 700 ? content.slice(-200) : '';
  const parts = [head];
  if (tail) {
    parts.push('...');
    parts.push(tail);
  }
  parts.push(`[~${tokenEstimate} tokens]`);
  return parts.join('\n');
}
