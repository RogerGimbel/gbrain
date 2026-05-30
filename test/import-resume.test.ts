import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, mkdtempSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { gbrainPath } from '../src/core/config.ts';
import { runImport } from '../src/commands/import.ts';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_GBRAIN_HOME = process.env.GBRAIN_HOME;

function restoreEnv() {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_GBRAIN_HOME === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = ORIGINAL_GBRAIN_HOME;
}

describe('import resume checkpoint', () => {
  let fakeHome: string;
  let isolatedHome: string;
  let brainDir: string;

  beforeEach(() => {
    fakeHome = mkdirTemp('gbrain-import-fake-home-');
    isolatedHome = mkdirTemp('gbrain-import-isolated-home-');
    brainDir = mkdirTemp('gbrain-import-brain-');
    process.env.HOME = fakeHome;
    process.env.GBRAIN_HOME = isolatedHome;
  });

  afterEach(() => {
    restoreEnv();
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(isolatedHome, { recursive: true, force: true });
    rmSync(brainDir, { recursive: true, force: true });
  });

  test('checkpoint file format is valid JSON under GBRAIN_HOME', () => {
    const checkpoint = {
      dir: '/data/brain',
      totalFiles: 13768,
      processedIndex: 5000,
      timestamp: new Date().toISOString(),
    };

    const checkpointPath = gbrainPath('import-checkpoint.json');
    mkdirSync(gbrainPath(), { recursive: true });
    writeFileSync(checkpointPath, JSON.stringify(checkpoint));

    const loaded = JSON.parse(readFileSync(checkpointPath, 'utf-8'));
    expect(loaded.dir).toBe('/data/brain');
    expect(loaded.totalFiles).toBe(13768);
    expect(loaded.processedIndex).toBe(5000);
    expect(typeof loaded.timestamp).toBe('string');
  });

  test('path-based checkpoint with matching dir enables resume', () => {
    const checkpoint = {
      dir: '/data/brain',
      completedPaths: ['a.md', 'b.md'],
      timestamp: new Date().toISOString(),
    };

    const checkpointPath = gbrainPath('import-checkpoint.json');
    mkdirSync(gbrainPath(), { recursive: true });
    writeFileSync(checkpointPath, JSON.stringify(checkpoint));

    const cp = JSON.parse(readFileSync(checkpointPath, 'utf-8'));
    const dir = '/data/brain';

    expect(cp.dir).toBe(dir);
    expect(cp.completedPaths).toEqual(['a.md', 'b.md']);
  });

  test('path-based checkpoint with different dir does not resume', () => {
    const checkpointPath = gbrainPath('import-checkpoint.json');
    mkdirSync(gbrainPath(), { recursive: true });
    writeFileSync(checkpointPath, JSON.stringify({
      dir: '/data/other-brain',
      completedPaths: ['a.md'],
      timestamp: new Date().toISOString(),
    }));

    const cp = JSON.parse(readFileSync(checkpointPath, 'utf-8'));
    const dir = '/data/brain';

    expect(cp.dir === dir && Array.isArray(cp.completedPaths)).toBe(false);
  });

  test('old positional checkpoint is not path-based resumable', () => {
    const checkpointPath = gbrainPath('import-checkpoint.json');
    mkdirSync(gbrainPath(), { recursive: true });
    writeFileSync(checkpointPath, JSON.stringify({
      dir: '/data/brain',
      totalFiles: 200,
      processedIndex: 50,
      timestamp: new Date().toISOString(),
    }));

    const cp = JSON.parse(readFileSync(checkpointPath, 'utf-8'));
    expect(Array.isArray(cp.completedPaths)).toBe(false);
  });

  test('invalid checkpoint JSON starts fresh', () => {
    const checkpointPath = gbrainPath('import-checkpoint.json');
    mkdirSync(gbrainPath(), { recursive: true });
    writeFileSync(checkpointPath, 'not json');

    let resumeIndex = 0;
    try {
      JSON.parse(readFileSync(checkpointPath, 'utf-8'));
    } catch {
      resumeIndex = 0;
    }

    expect(resumeIndex).toBe(0);
  });

  test('missing checkpoint file starts fresh', () => {
    expect(existsSync(gbrainPath('import-checkpoint.json'))).toBe(false);
  });

  test('runImport writes preserved checkpoints under GBRAIN_HOME, not HOME', async () => {
    for (let i = 0; i < 100; i++) {
      writeFileSync(join(brainDir, `note-${String(i).padStart(3, '0')}.md`), `# Note ${i}\n\nBody`);
    }

    const engine = makeFailingEngine();
    await runImport(engine as any, [brainDir, '--no-embed']);

    const isolatedCheckpoint = gbrainPath('import-checkpoint.json');
    const homeCheckpoint = join(fakeHome, '.gbrain', 'import-checkpoint.json');
    expect(existsSync(isolatedCheckpoint)).toBe(true);
    expect(existsSync(homeCheckpoint)).toBe(false);

    const loaded = JSON.parse(readFileSync(isolatedCheckpoint, 'utf-8'));
    expect(loaded.dir).toBe(brainDir);
    expect(loaded.completedPaths).toEqual([]);
    expect(typeof loaded.timestamp).toBe('string');
  });
  test('runImport does not advance git sync checkpoint when any file is skipped with an error', async () => {
    writeFileSync(join(brainDir, 'good.md'), `---
type: concept
title: Good
---

Good content.
`);
    writeFileSync(join(brainDir, 'bad.md'), `---
type: concept
title: Bad
slug: hijacked/slug
---

This file must be skipped because its slug disagrees with its path.
`);
    execFileSync('git', ['-C', brainDir, 'init'], { stdio: 'ignore' });
    execFileSync('git', ['-C', brainDir, 'add', '.'], { stdio: 'ignore' });
    execFileSync(
      'git',
      ['-C', brainDir, '-c', 'user.email=test@example.com', '-c', 'user.name=GBrain Test', 'commit', '-m', 'fixture'],
      { stdio: 'ignore' },
    );

    const engine = makeRecordingEngine();
    await runImport(engine as any, [brainDir, '--no-embed', '--fresh']);

    expect(engine.setConfigCalls.filter(([key]) => key.startsWith('sync.'))).toEqual([]);
  });
});

function mkdirTemp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeFailingEngine() {
  return {
    getPage: async () => null,
    transaction: async () => {
      throw new Error('forced checkpoint preservation failure');
    },
    logIngest: async () => {},
  };
}

function makeRecordingEngine() {
  const calls: { method: string; args: any[] }[] = [];
  const setConfigCalls: [string, string][] = [];
  const engine: any = new Proxy({}, {
    get(_, prop: string) {
      if (prop === 'calls') return calls;
      if (prop === 'setConfigCalls') return setConfigCalls;
      if (prop === 'getPage') return async () => null;
      if (prop === 'getTags') return async () => [];
      if (prop === 'transaction') return async (fn: (tx: any) => Promise<any>) => fn(engine);
      if (prop === 'logIngest') return async () => {};
      if (prop === 'setConfig') {
        return async (key: string, value: string) => {
          setConfigCalls.push([key, value]);
        };
      }
      return async (...args: any[]) => {
        calls.push({ method: prop, args });
        return null;
      };
    },
  });
  return engine as typeof engine & { setConfigCalls: [string, string][] };
}
