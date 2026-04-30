import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { tmpdir } from 'os';
import { configDir, configPath, gbrainPath, saveConfig, loadConfig } from '../src/core/config.ts';

const ORIGINAL_ENV = {
  GBRAIN_HOME: process.env.GBRAIN_HOME,
  GBRAIN_DATABASE_URL: process.env.GBRAIN_DATABASE_URL,
  DATABASE_URL: process.env.DATABASE_URL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};

describe('GBRAIN_HOME isolation', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'gbrain-home-'));
    process.env.GBRAIN_HOME = tempHome;
    delete process.env.GBRAIN_DATABASE_URL;
    delete process.env.DATABASE_URL;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (existsSync(tempHome)) rmSync(tempHome, { recursive: true, force: true });
    restoreEnv();
  });

  test('configDir and configPath resolve under GBRAIN_HOME parent', () => {
    expect(configDir()).toBe(join(tempHome, '.gbrain'));
    expect(configPath()).toBe(join(tempHome, '.gbrain', 'config.json'));
  });

  test('gbrainPath resolves paths under the isolated .gbrain directory', () => {
    expect(gbrainPath()).toBe(join(tempHome, '.gbrain'));
    expect(gbrainPath('brain.pglite')).toBe(join(tempHome, '.gbrain', 'brain.pglite'));
    expect(gbrainPath('integrations', 'x-to-brain')).toBe(join(tempHome, '.gbrain', 'integrations', 'x-to-brain'));
  });

  test('loadConfig and saveConfig round-trip inside GBRAIN_HOME', () => {
    saveConfig({ engine: 'pglite', database_path: gbrainPath('brain.pglite') });

    expect(existsSync(join(tempHome, '.gbrain', 'config.json'))).toBe(true);

    const loaded = loadConfig();
    expect(loaded?.engine).toBe('pglite');
    expect(loaded?.database_path).toBe(join(tempHome, '.gbrain', 'brain.pglite'));
  });

  test('relative GBRAIN_HOME fails closed', () => {
    process.env.GBRAIN_HOME = 'relative/path';
    expect(() => configDir()).toThrow('GBRAIN_HOME must be an absolute path');
  });

  test('GBRAIN_HOME containing parent traversal fails closed', () => {
    process.env.GBRAIN_HOME = `${tmpdir()}/safe/../unsafe`;
    expect(() => configDir()).toThrow('GBRAIN_HOME must not contain parent traversal');
  });

  test('source modules route .gbrain paths through config helpers', () => {
    const srcRoot = join(import.meta.dir, '..', 'src');
    const offenders: string[] = [];

    for (const file of walkTsFiles(srcRoot)) {
      const rel = relative(srcRoot, file);
      if (rel === join('core', 'config.ts')) continue;
      const content = readFileSync(file, 'utf-8');
      if (content.includes("join(homedir(), '.gbrain'") || content.includes('join(homedir(), ".gbrain"')) {
        offenders.push(rel);
      }
    }

    expect(offenders).toEqual([]);
  });
});

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      out.push(...walkTsFiles(path));
    } else if (entry.endsWith('.ts')) {
      out.push(path);
    }
  }
  return out;
}

function restoreEnv() {
  setOrDelete('GBRAIN_HOME', ORIGINAL_ENV.GBRAIN_HOME);
  setOrDelete('GBRAIN_DATABASE_URL', ORIGINAL_ENV.GBRAIN_DATABASE_URL);
  setOrDelete('DATABASE_URL', ORIGINAL_ENV.DATABASE_URL);
  setOrDelete('OPENAI_API_KEY', ORIGINAL_ENV.OPENAI_API_KEY);
}

function setOrDelete(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
