/**
 * Regression guard: scripts/check-privacy.sh must be wired into the
 * `bun run test` chain.
 *
 * The private OpenClaw fork name should not leak into public artifacts.
 * The script is intentionally local-adapted for this branch: historical
 * local files may be allow-listed, but new source/docs/tests/scripts are
 * checked by default.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync, statSync } from 'fs';
import { resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const PACKAGE_JSON = resolve(REPO_ROOT, 'package.json');
const PRIVACY_SCRIPT = resolve(REPO_ROOT, 'scripts/check-privacy.sh');

describe('check-privacy.sh CI wiring', () => {
  it('scripts/check-privacy.sh exists and is executable', () => {
    expect(existsSync(PRIVACY_SCRIPT)).toBe(true);
    // Mode has user-exec bit set.
    // eslint-disable-next-line no-bitwise
    expect((statSync(PRIVACY_SCRIPT).mode & 0o100) !== 0).toBe(true);
  });

  it('package.json "test" script includes check-privacy.sh', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8'));
    expect(typeof pkg.scripts?.test).toBe('string');
    expect(pkg.scripts.test).toContain('check-privacy.sh');
  });

  it('package.json exposes a "check:privacy" convenience alias', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8'));
    expect(pkg.scripts?.['check:privacy']).toContain('check-privacy.sh');
  });
});
