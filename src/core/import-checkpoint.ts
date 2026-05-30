import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'fs';
import { dirname, relative, isAbsolute } from 'path';

export interface ImportCheckpoint {
  /** Absolute brain directory the checkpoint was created against. Mismatch on resume means discard. */
  dir: string;
  /** Paths relative to dir that completed successfully or were unchanged. */
  completedPaths: string[];
  /** ISO 8601 diagnostic timestamp. */
  timestamp: string;
}

const OLD_FORMAT_LOG = 'Older checkpoint format detected — re-walking (cheap via content_hash)';

export function loadCheckpoint(path: string, currentDir: string): ImportCheckpoint | null {
  if (!existsSync(path)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj.completedPaths)) {
    if (typeof obj.processedIndex === 'number') {
      console.error(OLD_FORMAT_LOG);
    }
    return null;
  }

  if (typeof obj.dir !== 'string') return null;
  if (obj.dir !== currentDir) return null;
  if (typeof obj.timestamp !== 'string') return null;
  if (!obj.completedPaths.every((p): p is string => typeof p === 'string')) return null;

  return {
    dir: obj.dir,
    completedPaths: obj.completedPaths,
    timestamp: obj.timestamp,
  };
}

export function saveCheckpoint(path: string, cp: ImportCheckpoint): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    const payload: ImportCheckpoint = {
      dir: cp.dir,
      completedPaths: [...cp.completedPaths].sort(),
      timestamp: cp.timestamp,
    };
    writeFileSync(tmp, JSON.stringify(payload));
    renameSync(tmp, path);
  } catch {
    // Non-fatal: a lost checkpoint only means the next import re-walks.
  }
}

export function resumeFilter(allFiles: string[], dir: string, completed: Set<string>): string[] {
  if (completed.size === 0) return allFiles;
  return allFiles.filter((p) => {
    const rel = isAbsolute(p) ? relative(dir, p) : p;
    return !completed.has(rel);
  });
}

export function clearCheckpoint(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Non-fatal.
  }
}

export function markCompletedPath(
  completed: Set<string>,
  relativePath: string,
  result: { status: string; error?: string },
): void {
  if (result.status === 'imported') {
    completed.add(relativePath);
    return;
  }
  if (result.status === 'skipped' && (!result.error || result.error === 'unchanged')) {
    completed.add(relativePath);
  }
}
