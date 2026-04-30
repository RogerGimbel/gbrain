import {
  existsSync as fsExistsSync,
  readFileSync as fsReadFileSync,
  appendFileSync as fsAppendFileSync,
  mkdirSync as fsMkdirSync,
  writeFileSync as fsWriteFileSync,
} from 'fs';
import { dirname } from 'path';
import { createHash } from 'crypto';
import { gbrainPath } from './config.ts';

/**
 * Sync utilities — pure functions for git diff parsing, filtering, and slug management.
 *
 * SYNC DATA FLOW:
 *   git diff --name-status -M LAST..HEAD
 *       │
 *   buildSyncManifest()  →  parse A/M/D/R lines
 *       │
 *   isSyncable()  →  filter to .md pages only
 *       │
 *   pathToSlug()  →  convert file paths to page slugs
 */

export interface SyncManifest {
  added: string[];
  modified: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string }>;
}

export interface RawManifestEntry {
  action: 'A' | 'M' | 'D' | 'R';
  path: string;
  oldPath?: string;
}

/**
 * Parse the output of `git diff --name-status -M LAST..HEAD` into structured entries.
 *
 * Input format (tab-separated):
 *   A       path/to/new-file.md
 *   M       path/to/modified-file.md
 *   D       path/to/deleted-file.md
 *   R100    old/path.md     new/path.md
 */
export function buildSyncManifest(gitDiffOutput: string): SyncManifest {
  const manifest: SyncManifest = {
    added: [],
    modified: [],
    deleted: [],
    renamed: [],
  };

  const lines = gitDiffOutput.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parts = trimmed.split('\t');
    if (parts.length < 2) continue;

    const action = parts[0];
    const path = parts[parts.length === 3 ? 2 : 1]; // For renames, new path is 3rd column

    if (action === 'A') {
      manifest.added.push(path);
    } else if (action === 'M') {
      manifest.modified.push(path);
    } else if (action === 'D') {
      manifest.deleted.push(parts[1]);
    } else if (action.startsWith('R')) {
      // Rename: R100\told-path\tnew-path
      const oldPath = parts[1];
      const newPath = parts[2];
      if (oldPath && newPath) {
        manifest.renamed.push({ from: oldPath, to: newPath });
      }
    }
  }

  return manifest;
}

/**
 * Filter a file path to determine if it should be synced to GBrain.
 */
export function isSyncable(path: string): boolean {
  // Must be .md or .mdx
  if (!path.endsWith('.md') && !path.endsWith('.mdx')) return false;

  // Skip hidden directories
  if (path.split('/').some(p => p.startsWith('.'))) return false;

  // Skip .raw/ sidecar directories
  if (path.includes('.raw/')) return false;

  // Skip meta files that aren't pages
  const skipFiles = ['schema.md', 'index.md', 'log.md', 'README.md'];
  const basename = path.split('/').pop() || '';
  if (skipFiles.includes(basename)) return false;

  // Skip ops/ directory
  if (path.startsWith('ops/')) return false;

  return true;
}

/**
 * Slugify a single path segment: lowercase, strip special chars, spaces → hyphens.
 */
export function slugifySegment(segment: string): string {
  return segment
    .normalize('NFD')                     // Decompose accented chars
    .replace(/[\u0300-\u036f]/g, '')      // Strip accent marks
    .toLowerCase()
    .replace(/[^a-z0-9.\s_-]/g, '')      // Keep alphanumeric, dots, spaces, underscores, hyphens
    .replace(/[\s]+/g, '-')              // Spaces → hyphens
    .replace(/-+/g, '-')                 // Collapse multiple hyphens
    .replace(/^-|-$/g, '');              // Strip leading/trailing hyphens
}

/**
 * Slugify a file path: strip .md, normalize separators, slugify each segment.
 *
 * Examples:
 *   Apple Notes/2017-05-03 ohmygreen.md → apple-notes/2017-05-03-ohmygreen
 *   people/alice-smith.md → people/alice-smith
 *   notes/v1.0.0.md → notes/v1.0.0
 */
export function slugifyPath(filePath: string): string {
  let path = filePath.replace(/\.mdx?$/i, '');
  path = path.replace(/\\/g, '/');
  path = path.replace(/^\.?\//, '');
  return path.split('/').map(slugifySegment).filter(Boolean).join('/');
}

/**
 * Convert a repo-relative file path to a GBrain page slug.
 */
export function pathToSlug(filePath: string, repoPrefix?: string): string {
  let slug = slugifyPath(filePath);
  if (repoPrefix) slug = `${repoPrefix}/${slug}`;
  return slug.toLowerCase();
}

// ─────────────────────────────────────────────────────────────────
// Sync failure tracking
// ─────────────────────────────────────────────────────────────────

export interface SyncFailure {
  path: string;
  error: string;
  /** Structured error code extracted from the error message. */
  code?: string;
  commit: string;
  line?: number;
  ts: string;
  acknowledged?: boolean;
  acknowledged_at?: string;
}

export function classifyErrorCode(errorMsg: string): string {
  if (/slug.*does not match|SLUG_MISMATCH/i.test(errorMsg)) return 'SLUG_MISMATCH';

  // DB-layer errors before YAML duplicate-key so Postgres unique-constraint
  // messages are not mislabeled as frontmatter syntax errors.
  if (/duplicate key value violates unique constraint|DB_DUPLICATE_KEY/i.test(errorMsg)) return 'DB_DUPLICATE_KEY';
  if (/canceling statement due to statement timeout|STATEMENT_TIMEOUT/i.test(errorMsg)) return 'STATEMENT_TIMEOUT';

  if (/YAML parse failed|YAML_PARSE/i.test(errorMsg)) return 'YAML_PARSE';
  if (/YAMLException|duplicated mapping key|YAML_DUPLICATE_KEY/i.test(errorMsg)) return 'YAML_DUPLICATE_KEY';
  if (/File is empty or whitespace-only|Frontmatter must start with ---|MISSING_OPEN/i.test(errorMsg)) return 'MISSING_OPEN';
  if (/No closing --- delimiter|Heading at line .* found inside frontmatter|MISSING_CLOSE/i.test(errorMsg)) return 'MISSING_CLOSE';
  if (/Frontmatter block is empty|EMPTY_FRONTMATTER/i.test(errorMsg)) return 'EMPTY_FRONTMATTER';
  if (/Content contains null bytes|NULL_BYTES|null byte/i.test(errorMsg)) return 'NULL_BYTES';
  if (/Nested double quotes|NESTED_QUOTES/i.test(errorMsg)) return 'NESTED_QUOTES';
  if (/invalid UTF-?8|INVALID_UTF8/i.test(errorMsg)) return 'INVALID_UTF8';
  if (/file too large|content too large|FILE_TOO_LARGE/i.test(errorMsg)) return 'FILE_TOO_LARGE';
  if (/skipping symlink|symlink|SYMLINK_NOT_ALLOWED/i.test(errorMsg)) return 'SYMLINK_NOT_ALLOWED';

  return 'UNKNOWN';
}

export function summarizeFailuresByCode(
  failures: Array<{ error: string; code?: string }>,
): Array<{ code: string; count: number }> {
  const counts: Record<string, number> = {};
  for (const failure of failures) {
    const code = failure.code ?? classifyErrorCode(failure.error);
    counts[code] = (counts[code] ?? 0) + 1;
  }
  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .map(([code, count]) => ({ code, count }));
}

export function formatCodeBreakdown(
  input: Array<{ error: string; code?: string }> | Array<{ code: string; count: number }>,
): string {
  const summary = input.length > 0 && typeof (input[0] as { count?: unknown }).count === 'number'
    ? (input as Array<{ code: string; count: number }>)
    : summarizeFailuresByCode(input as Array<{ error: string; code?: string }>);
  return summary.map(s => `  ${s.code}: ${s.count}`).join('\n');
}

export function syncFailuresPath(): string {
  return gbrainPath('sync-failures.jsonl');
}

function hashError(msg: string): string {
  return createHash('sha256').update(msg).digest('hex').slice(0, 12);
}

function dedupKey(f: { path: string; commit: string; error: string }): string {
  return `${f.path}|${f.commit}|${hashError(f.error)}`;
}

export function loadSyncFailures(): SyncFailure[] {
  const path = syncFailuresPath();
  if (!fsExistsSync(path)) return [];

  const out: SyncFailure[] = [];
  for (const line of fsReadFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as SyncFailure);
    } catch {
      console.warn(`[sync-failures] skipping malformed line: ${trimmed.slice(0, 120)}`);
    }
  }
  return out;
}

export function recordSyncFailures(
  failures: Array<{ path: string; error: string; line?: number }>,
  commit: string,
): void {
  if (failures.length === 0) return;

  const existing = loadSyncFailures();
  const seen = new Set(existing.map(f => dedupKey(f)));
  const now = new Date().toISOString();
  const path = syncFailuresPath();
  fsMkdirSync(dirname(path), { recursive: true });

  for (const failure of failures) {
    const entry: SyncFailure = {
      path: failure.path,
      error: failure.error,
      code: classifyErrorCode(failure.error),
      commit,
      line: failure.line,
      ts: now,
    };
    const key = dedupKey(entry);
    if (seen.has(key)) continue;
    fsAppendFileSync(path, JSON.stringify(entry) + '\n');
    seen.add(key);
  }
}

export interface AcknowledgeResult {
  count: number;
  summary: Array<{ code: string; count: number }>;
}

export function acknowledgeSyncFailures(): AcknowledgeResult {
  const entries = loadSyncFailures();
  if (entries.length === 0) return { count: 0, summary: [] };

  const now = new Date().toISOString();
  let changed = 0;
  const newlyAcked: SyncFailure[] = [];
  const updated = entries.map(entry => {
    if (entry.acknowledged) return entry;
    changed++;
    const acknowledged = {
      ...entry,
      code: entry.code ?? classifyErrorCode(entry.error),
      acknowledged: true,
      acknowledged_at: now,
    };
    newlyAcked.push(acknowledged);
    return acknowledged;
  });

  if (changed === 0) return { count: 0, summary: [] };
  const path = syncFailuresPath();
  fsMkdirSync(dirname(path), { recursive: true });
  fsWriteFileSync(path, updated.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  return { count: changed, summary: summarizeFailuresByCode(newlyAcked) };
}

export function unacknowledgedSyncFailures(): SyncFailure[] {
  return loadSyncFailures().filter(f => !f.acknowledged);
}
