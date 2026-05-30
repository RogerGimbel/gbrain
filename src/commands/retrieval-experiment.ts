import { existsSync, readFileSync } from 'fs';
import type { BrainEngine } from '../core/engine.ts';
import { parseQrels, runEval, type EvalConfig, type EvalQrel } from '../core/search/eval.ts';
import { CANONICAL_RETRIEVAL_CASES } from '../core/search/retrieval-baseline.ts';
import { compareRetrievalExperiment, writeRetrievalExperimentArtifacts } from '../core/search/retrieval-experiment.ts';

interface ParsedArgs {
  qrels?: string;
  canonical: boolean;
  baselineConfig?: string;
  candidateConfig?: string;
  output?: string;
  k: number;
  json: boolean;
}

export async function runRetrievalExperimentCommand(engine: BrainEngine, args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const qrels = loadQrels(parsed);
  const baselineConfig = loadConfig(parsed.baselineConfig, { name: 'baseline-default-hybrid', strategy: 'hybrid', expand: false, limit: 10 });
  const candidateConfig = loadConfig(parsed.candidateConfig, { name: 'candidate-default-hybrid', strategy: 'hybrid', expand: false, limit: 10 });

  const [baseline, candidate] = await Promise.all([
    runEval(engine, qrels, baselineConfig, parsed.k),
    runEval(engine, qrels, candidateConfig, parsed.k),
  ]);
  const expectedTop1ByQuery = Object.fromEntries(qrels.map(q => [q.query, q.relevant[0]]).filter(([, slug]) => Boolean(slug))) as Record<string, string>;
  const result = compareRetrievalExperiment({ baseline, candidate, expectedTop1ByQuery });
  const written = parsed.output ? writeRetrievalExperimentArtifacts(parsed.output, result) : undefined;

  if (parsed.json) {
    console.log(JSON.stringify({ ok: result.ok, written, result }, null, 2));
  } else {
    console.log(`Retrieval experiment gate: ${result.ok ? 'PASS' : 'FAIL'}`);
    console.log(`candidate_enabled: false`);
    console.log(`mean_mrr_delta: ${result.metrics.mean_mrr_delta}`);
    console.log(`protected_top1: ${result.metrics.protected_top1_passed}/${result.metrics.protected_top1_total}`);
    if (written) console.log(`Wrote ${written.markdown}\nWrote ${written.json}`);
    for (const failure of result.failures) console.log(`FAIL: ${failure}`);
  }

  if (!result.ok) process.exit(1);
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { canonical: false, k: 3, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      case '--qrels':
        parsed.qrels = args[++i];
        break;
      case '--canonical':
        parsed.canonical = true;
        break;
      case '--baseline-config':
        parsed.baselineConfig = args[++i];
        break;
      case '--candidate-config':
        parsed.candidateConfig = args[++i];
        break;
      case '--output':
        parsed.output = args[++i];
        break;
      case '--k':
        parsed.k = Number(args[++i]);
        break;
      case '--json':
        parsed.json = true;
        break;
      default:
        throw new Error(`Unknown retrieval-experiment option: ${arg}`);
    }
  }
  return parsed;
}

function loadQrels(parsed: ParsedArgs): EvalQrel[] {
  if (parsed.canonical) {
    return CANONICAL_RETRIEVAL_CASES.map(c => ({ id: c.query, query: c.query, relevant: [c.expectedSlug] }));
  }
  if (!parsed.qrels) throw new Error('Missing --qrels <file|json> or --canonical');
  return parseQrels(parsed.qrels);
}

function loadConfig(pathOrJson: string | undefined, fallback: EvalConfig): EvalConfig {
  if (!pathOrJson) return fallback;
  const trimmed = pathOrJson.trimStart();
  if (trimmed.startsWith('{')) return { ...fallback, ...JSON.parse(pathOrJson) };
  if (!existsSync(pathOrJson)) throw new Error(`Config not found: ${pathOrJson}`);
  return { ...fallback, ...JSON.parse(readFileSync(pathOrJson, 'utf8')) };
}

function printHelp(): void {
  console.log(`Usage: gbrain retrieval-experiment (--canonical|--qrels <qrels.json>) [--baseline-config cfg.json] [--candidate-config cfg.json] [--output dir] [--json]

Run a gated baseline-vs-candidate retrieval experiment. Candidate ranking is never enabled by this command.

Options:
  --canonical                 Use built-in canonical/golden retrieval cases as qrels
  --qrels <file|json>         Eval qrels file or inline JSON
  --baseline-config <json>    Baseline EvalConfig file or inline JSON
  --candidate-config <json>   Candidate EvalConfig file or inline JSON
  --output <dir>              Write retrieval-experiment-gate.{md,json}
  --k <n>                     Metric cutoff, default 3
  --json                      Emit machine-readable result
`);
}
