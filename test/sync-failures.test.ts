import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { performSync } from '../src/commands/sync.ts';

function git(repo: string, ...args: string[]) {
  const proc = Bun.spawnSync({ cmd: ['git', '-C', repo, ...args], stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString().trim();
}

class FakeEngine {
  kind = 'postgres' as const;
  config = new Map<string, string>();
  pages = new Map<string, any>();
  deletedSlugs: string[] = [];
  async getConfig(key: string) { return this.config.get(key) ?? null; }
  async setConfig(key: string, value: string) { this.config.set(key, value); }
  async getPage(slug: string) { return this.pages.get(slug) ?? null; }
  async deletePage(slug: string) {
    this.deletedSlugs.push(slug);
    this.pages.delete(slug);
  }
  async updateSlug(_oldSlug: string, _newSlug: string) {}
  async logIngest(_entry: any) {}
  async transaction<T>(fn: (tx: this) => Promise<T>) { return fn(this); }
  async createVersion(_slug: string) {}
  async putPage(slug: string, page: any) { this.pages.set(slug, { slug, ...page }); }
  async getTags(_slug: string) { return []; }
  async removeTag(_slug: string, _tag: string) {}
  async addTag(_slug: string, _tag: string) {}
  async upsertChunks(_slug: string, _chunks: any[]) {}
  async deleteChunks(_slug: string) {}
}

let tmpRoot: string;
let originalGbrainHome: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'gbrain-sync-failures-'));
  originalGbrainHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = tmpRoot;
});

afterEach(() => {
  if (originalGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = originalGbrainHome;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('sync failure tracking helpers', () => {
  test('classifies common sync failure errors into stable codes', async () => {
    const { classifyErrorCode } = await import('../src/core/sync.ts');
    expect(classifyErrorCode('Frontmatter slug "wrong" does not match path-derived slug "notes/bad"')).toBe('SLUG_MISMATCH');
    expect(classifyErrorCode('YAML parse failed: unexpected colon')).toBe('YAML_PARSE');
    expect(classifyErrorCode('YAMLException: duplicated mapping key')).toBe('YAML_DUPLICATE_KEY');
    expect(classifyErrorCode('canceling statement due to statement timeout')).toBe('STATEMENT_TIMEOUT');
    expect(classifyErrorCode('Content contains null bytes')).toBe('NULL_BYTES');
    expect(classifyErrorCode('File too large (9999999 bytes)')).toBe('FILE_TOO_LARGE');
    expect(classifyErrorCode('Skipping symlink: /tmp/link.md')).toBe('SYMLINK_NOT_ALLOWED');
    expect(classifyErrorCode('unrecognized weirdness')).toBe('UNKNOWN');
  });

  test('records failures under GBRAIN_HOME with dedup and acknowledgement', async () => {
    const {
      recordSyncFailures,
      loadSyncFailures,
      unacknowledgedSyncFailures,
      acknowledgeSyncFailures,
      syncFailuresPath,
    } = await import('../src/core/sync.ts');

    recordSyncFailures([
      { path: 'notes/bad.md', error: 'Frontmatter slug "wrong" does not match path-derived slug "notes/bad"' },
      { path: 'notes/also-bad.md', error: 'YAML parse failed: unexpected colon' },
    ], 'abc123');
    recordSyncFailures([
      { path: 'notes/bad.md', error: 'Frontmatter slug "wrong" does not match path-derived slug "notes/bad"' },
    ], 'abc123');

    expect(syncFailuresPath()).toBe(join(tmpRoot, '.gbrain', 'sync-failures.jsonl'));
    expect(existsSync(syncFailuresPath())).toBe(true);
    expect(loadSyncFailures()).toHaveLength(2);
    expect(unacknowledgedSyncFailures()).toHaveLength(2);

    const ack = acknowledgeSyncFailures();
    expect(ack.count).toBe(2);
    expect(unacknowledgedSyncFailures()).toHaveLength(0);
    expect(readFileSync(syncFailuresPath(), 'utf-8')).toContain('"acknowledged":true');
  });
});

describe('performSync failure gate', () => {
  test('does not advance sync.last_commit when a changed file is skipped with an import error', async () => {
    const repo = join(tmpRoot, 'repo');
    mkdirSync(join(repo, 'notes'), { recursive: true });
    git(tmpRoot, 'init', 'repo');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'GBrain Test');
    writeFileSync(join(repo, 'notes', 'good.md'), '---\ntitle: Good\n---\n# Good\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'initial');
    const firstCommit = git(repo, 'rev-parse', 'HEAD');

    writeFileSync(join(repo, 'notes', 'bad.md'), '---\nslug: totally/wrong\ntitle: Bad\n---\n# Bad\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'add bad frontmatter slug');
    const secondCommit = git(repo, 'rev-parse', 'HEAD');

    const engine = new FakeEngine();
    engine.config.set('sync.last_commit', firstCommit);
    engine.config.set('sync.repo_path', repo);

    const result = await performSync(engine as any, {
      repoPath: repo,
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });

    expect(result.status).toBe('blocked_by_failures');
    expect(result.failedFiles).toBe(1);
    expect(engine.config.get('sync.last_commit')).toBe(firstCommit);
    expect(engine.config.get('sync.repo_path')).toBe(repo);
    expect(engine.config.get('sync.last_run')).toBeTruthy();

    const { unacknowledgedSyncFailures, loadSyncFailures } = await import('../src/core/sync.ts');
    const unacked = unacknowledgedSyncFailures();
    expect(unacked).toHaveLength(1);
    expect(unacked[0].path).toBe('notes/bad.md');
    expect(unacked[0].commit).toBe(secondCommit);
    expect(unacked[0].code).toBe('SLUG_MISMATCH');

    const acknowledged = await performSync(engine as any, {
      repoPath: repo,
      noPull: true,
      noEmbed: true,
      noExtract: true,
      skipFailed: true,
    });
    expect(acknowledged.status).toBe('synced');
    expect(engine.config.get('sync.last_commit')).toBe(secondCommit);
    expect(unacknowledgedSyncFailures()).toHaveLength(0);
    expect(loadSyncFailures()[0].acknowledged).toBe(true);
  });

  test('dry run preserves modified pages that are no longer syncable', async () => {
    const repo = join(tmpRoot, 'repo');
    mkdirSync(repo, { recursive: true });
    git(tmpRoot, 'init', 'repo');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'GBrain Test');
    writeFileSync(join(repo, 'index.md'), '---\ntype: index\ntitle: Original Index\n---\n# Original Index\n');
    writeFileSync(join(repo, '.gitignore'), 'initial\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'initial index');
    const firstCommit = git(repo, 'rev-parse', 'HEAD');

    writeFileSync(join(repo, 'index.md'), '---\ntype: index\ntitle: Updated Index\n---\n# Updated Index\n');
    writeFileSync(join(repo, '.gitignore'), 'updated\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'update index');
    const secondCommit = git(repo, 'rev-parse', 'HEAD');

    const engine = new FakeEngine();
    engine.config.set('sync.last_commit', firstCommit);
    engine.config.set('sync.repo_path', repo);
    engine.pages.set('index', { slug: 'index', title: 'Original Index', content_hash: 'original' });

    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    const dryRun = await performSync(engine as any, {
      repoPath: repo,
      noPull: true,
      noEmbed: true,
      noExtract: true,
      dryRun: true,
    });
    const dryRunLogs = logSpy.mock.calls.map(args => args.join(' ')).join('\n');
    logSpy.mockRestore();

    expect(dryRun.status).toBe('dry_run');
    expect(dryRunLogs).toContain('Would delete un-syncable pages on apply: index');
    expect(dryRunLogs).not.toContain('.gitignore');
    expect(dryRunLogs).not.toContain('Deleted un-syncable page:');
    expect(engine.deletedSlugs).toEqual([]);
    expect(engine.pages.has('index')).toBe(true);
    expect(engine.config.get('sync.last_commit')).toBe(firstCommit);

    const applied = await performSync(engine as any, {
      repoPath: repo,
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });

    expect(applied.status).toBe('up_to_date');
    expect(engine.deletedSlugs).toEqual(['index']);
    expect(engine.pages.has('index')).toBe(false);
    expect(engine.config.get('sync.last_commit')).toBe(secondCommit);
  });
});
