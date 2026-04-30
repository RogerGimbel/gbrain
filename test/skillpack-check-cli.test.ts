import { describe, expect, test } from 'bun:test';
import { join } from 'path';

const REPO = join(import.meta.dir, '..');
const CLI = join(REPO, 'src', 'cli.ts');

describe('skillpack check CLI wiring', () => {
  test.each([
    ['nested command', ['skillpack', 'check', '--help']],
    ['top-level command', ['skillpack-check', '--help']],
  ])('%s resolves and prints help', (_label, args) => {
    const proc = Bun.spawnSync({
      cmd: ['bun', CLI, ...args],
      cwd: REPO,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stdout = proc.stdout.toString();
    const stderr = proc.stderr.toString();

    expect(proc.exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('gbrain skillpack-check');
    expect(stdout).toContain('agent-readable health report');
  });
});
