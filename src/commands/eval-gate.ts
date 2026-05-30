import type { BrainEngine } from '../core/engine.ts';
import {
  buildEvalCaptureFile,
  replayEvalCapture,
  type EvalCaptureFile,
  type EvalCaptureMode,
} from '../core/eval-capture.ts';
import { loadBaselineFile } from '../core/bench/baseline-file.ts';
import { loadQrelsFile, type QrelsFile } from '../core/bench/qrels-file.ts';
import { evaluateCorrectnessGate } from '../core/bench/correctness-gate.ts';

interface ParsedGateArgs {
  help: boolean;
  baselinePath?: string;
  qrelsPath?: string;
  limit: number;
  mode: EvalCaptureMode;
  json: boolean;
}

export async function runEvalGateCommand(engine: BrainEngine, args: string[]): Promise<void> {
  const opts = parseArgs(args);
  if (opts.help) {
    printHelp();
    return;
  }

  if (!opts.baselinePath && !opts.qrelsPath) {
    console.error('Error: baseline capture path or --qrels <path> is required.');
    printHelp();
    process.exit(1);
  }

  const capture = opts.qrelsPath
    ? captureFromQrels(loadQrelsFile(opts.qrelsPath), opts.mode)
    : withDefaultMode(loadBaselineFile(opts.baselinePath!), opts.mode);

  const summary = await replayEvalCapture(engine, capture, { limit: opts.limit });
  const gate = evaluateCorrectnessGate(summary);

  if (opts.json) {
    console.log(JSON.stringify({ ok: gate.ok, summary, failures: gate.failures }, null, 2));
  } else if (gate.ok) {
    console.log(`PASS gbrain eval gate: ${summary.passed}/${summary.total} top1 expectations passed`);
  } else {
    console.log(`FAIL gbrain eval gate: ${summary.passed}/${summary.total} top1 expectations passed`);
    for (const failure of gate.failures) console.log(`  - ${failure}`);
  }

  if (!gate.ok) process.exit(1);
}

function parseArgs(args: string[]): ParsedGateArgs {
  const opts: ParsedGateArgs = {
    help: false,
    limit: 10,
    mode: 'keyword',
    json: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case '--help': case '-h': opts.help = true; break;
      case '--qrels': opts.qrelsPath = next; i++; break;
      case '--limit': opts.limit = parseInt(next, 10); i++; break;
      case '--mode': opts.mode = parseMode(next); i++; break;
      case '--json': opts.json = true; break;
      default:
        if (!arg.startsWith('--') && !opts.baselinePath) opts.baselinePath = arg;
        break;
    }
  }
  return opts;
}

function parseMode(value: string | undefined): EvalCaptureMode {
  if (value === 'hybridNoExpand' || value === 'hybridExpand' || value === 'keyword') return value;
  throw new Error(`Invalid eval gate mode: ${value ?? ''}`);
}

function captureFromQrels(qrelsFile: QrelsFile, mode: EvalCaptureMode): EvalCaptureFile {
  return buildEvalCaptureFile({
    cases: qrelsFile.qrels.map((qrel) => ({
      query: qrel.query,
      expectedSlug: qrel.expectedSlugs[0],
      mode,
      topResults: [],
    })),
  });
}

function withDefaultMode(capture: EvalCaptureFile, mode: EvalCaptureMode): EvalCaptureFile {
  return {
    ...capture,
    cases: capture.cases.map((testCase) => ({
      ...testCase,
      mode: testCase.mode ?? mode,
    })),
  };
}

function printHelp(): void {
  console.log(`gbrain eval gate <capture.json> [--limit N] [--mode keyword|hybridNoExpand|hybridExpand] [--json]\ngbrain eval gate --qrels <qrels.json> [--limit N] [--mode keyword|hybridNoExpand|hybridExpand] [--json]\n\nRun a top-1 correctness gate from a replay capture or qrels file. Exits non-zero on failure.`);
}
