import { execFileSync } from 'node:child_process';

export type GitHeadProbe = (localPath: string) => string | null;
export type GitCleanProbe = (localPath: string) => boolean | null;

const DEFAULT_HEAD_PROBE: GitHeadProbe = (localPath) => {
  try {
    const out = execFileSync('git', ['-C', localPath, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
};

const DEFAULT_CLEAN_PROBE: GitCleanProbe = (localPath) => {
  try {
    const out = execFileSync('git', ['-C', localPath, 'status', '--porcelain'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length === 0;
  } catch {
    return null;
  }
};

let headProbe: GitHeadProbe = DEFAULT_HEAD_PROBE;
let cleanProbe: GitCleanProbe = DEFAULT_CLEAN_PROBE;

export function _setGitHeadProbeForTests(fn: GitHeadProbe | null): void {
  headProbe = fn ?? DEFAULT_HEAD_PROBE;
}

export function _setGitCleanProbeForTests(fn: GitCleanProbe | null): void {
  cleanProbe = fn ?? DEFAULT_CLEAN_PROBE;
}

export interface GitFreshnessOpts {
  requireCleanWorkingTree?: boolean;
}

export function isSourceUnchangedSinceSync(
  localPath: string | null | undefined,
  lastCommit: string | null | undefined,
  opts: GitFreshnessOpts = {},
): boolean {
  if (!localPath || !lastCommit) return false;

  let head: string | null;
  try {
    head = headProbe(localPath);
  } catch {
    return false;
  }

  if (!head || head !== lastCommit) return false;

  if (opts.requireCleanWorkingTree) {
    let isClean: boolean | null;
    try {
      isClean = cleanProbe(localPath);
    } catch {
      return false;
    }
    if (isClean !== true) return false;
  }

  return true;
}
