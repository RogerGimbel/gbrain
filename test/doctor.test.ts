import { describe, test, expect } from 'bun:test';

describe('doctor command', () => {
  test('doctor module exports runDoctor', async () => {
    const { runDoctor } = await import('../src/commands/doctor.ts');
    expect(typeof runDoctor).toBe('function');
  });

  test('LATEST_VERSION is importable from migrate', async () => {
    const { LATEST_VERSION } = await import('../src/core/migrate.ts');
    expect(typeof LATEST_VERSION).toBe('number');
  });

  test('CLI registers doctor command', async () => {
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/cli.ts', '--help'],
      cwd: import.meta.dir + '/..',
    });
    const stdout = new TextDecoder().decode(result.stdout);
    expect(stdout).toContain('doctor');
    expect(stdout).toContain('--fast');
  });

  test('Check interface supports issues array', async () => {
    const check: import('../src/commands/doctor.ts').Check = {
      name: 'resolver_health',
      status: 'warn',
      message: '2 issues',
      issues: [{ type: 'unreachable', skill: 'test-skill', action: 'Add trigger row' }],
    };
    expect(check.issues).toHaveLength(1);
    expect(check.issues![0].action).toContain('trigger');
  });

  test('runDoctor accepts null engine for filesystem-only mode', async () => {
    const { runDoctor } = await import('../src/commands/doctor.ts');
    expect(runDoctor.length).toBe(2);
  });

  test('doctor --fast reports DB checks skipped instead of no database configured', () => {
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/cli.ts', 'doctor', '--fast', '--json'],
      cwd: import.meta.dir + '/..',
    });
    const stdout = new TextDecoder().decode(result.stdout);
    const payload = JSON.parse(stdout);
    const connection = payload.checks.find((check: { name: string }) => check.name === 'connection');
    expect(connection?.status).toBe('ok');
    expect(connection?.message).toContain('DB checks skipped');
    expect(connection?.message).not.toContain('No database configured');
  });
});

describe('checkSyncFreshness', () => {
  test('returns ok when no sync repo is configured', async () => {
    const { checkSyncFreshness } = await import('../src/commands/doctor.ts');
    const engine = makeConfigEngine({});
    const check = await checkSyncFreshness(engine as any);
    expect(check.status).toBe('ok');
    expect(check.name).toBe('sync_freshness');
    expect(check.message).toContain('No sync repo configured');
  });

  test('returns ok when local git HEAD still matches sync.last_commit and tree is clean', async () => {
    const { checkSyncFreshness } = await import('../src/commands/doctor.ts');
    const { _setGitHeadProbeForTests, _setGitCleanProbeForTests } = await import('../src/core/git-head.ts');
    _setGitHeadProbeForTests(() => 'abc123');
    _setGitCleanProbeForTests(() => true);
    try {
      const engine = makeConfigEngine({ 'sync.repo_path': '/tmp/repo', 'sync.last_commit': 'abc123' });
      const check = await checkSyncFreshness(engine as any);
      expect(check.status).toBe('ok');
      expect(check.message).toContain('unchanged');
    } finally {
      _setGitHeadProbeForTests(null);
      _setGitCleanProbeForTests(null);
    }
  });

  test('warns when configured repo has moved or cannot be verified', async () => {
    const { checkSyncFreshness } = await import('../src/commands/doctor.ts');
    const { _setGitHeadProbeForTests } = await import('../src/core/git-head.ts');
    _setGitHeadProbeForTests(() => 'newhead');
    try {
      const engine = makeConfigEngine({ 'sync.repo_path': '/tmp/repo', 'sync.last_commit': 'oldhead' });
      const check = await checkSyncFreshness(engine as any);
      expect(check.status).toBe('warn');
      expect(check.message).toContain('not at last synced commit');
    } finally {
      _setGitHeadProbeForTests(null);
    }
  });
});

function makeConfigEngine(values: Record<string, string>) {
  return {
    getConfig: async (key: string) => values[key] ?? null,
  };
}
