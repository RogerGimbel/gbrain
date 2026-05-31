import { describe, expect, test } from 'bun:test';
import { runSync } from '../src/commands/sync.ts';

describe('sync CLI help', () => {
  test('gbrain sync --help prints usage without touching the engine', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };

    let engineTouched = false;
    const engine = new Proxy({}, {
      get() {
        engineTouched = true;
        throw new Error('engine should not be touched for sync --help');
      },
    });

    try {
      await runSync(engine as any, ['--help']);
    } finally {
      console.log = originalLog;
    }

    expect(engineTouched).toBe(false);
    expect(logs.join('\n')).toContain('Usage: gbrain sync');
    expect(logs.join('\n')).toContain('--watch');
    expect(logs.join('\n')).toContain('--dry-run');
  });
});
