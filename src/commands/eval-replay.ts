import type { BrainEngine } from '../core/engine.ts';
import { loadEvalCaptureFile, replayEvalCapture } from '../core/eval-capture.ts';

export async function runEvalReplayCommand(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  const capturePath = args.find((arg, idx) => !arg.startsWith('--') && args[idx - 1] !== '--limit');
  if (!capturePath) {
    console.error('Error: capture file is required.');
    printHelp();
    process.exit(1);
  }

  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1] ?? '10', 10) : 10;
  const gate = args.includes('--gate');
  const json = args.includes('--json');

  const capture = loadEvalCaptureFile(capturePath);
  const summary = await replayEvalCapture(engine, capture, { limit });

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`gbrain eval replay: ${summary.passed}/${summary.total} passed (${summary.failed} failed)`);
    for (const result of summary.cases) {
      const mark = result.passed ? 'PASS' : 'FAIL';
      console.log(`  [${mark}] ${result.query}: expected ${result.expectedSlug ?? 'n/a'}, got ${result.actualTopSlug ?? 'none'}`);
    }
  }

  if (gate && summary.failed > 0) process.exit(1);
}

function printHelp() {
  console.log(`gbrain eval replay <capture.json> [--limit N] [--gate] [--json]\n\nReplay a privacy-scrubbed eval capture against the current search stack. Read-only.`);
}
