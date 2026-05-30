import { existsSync, readFileSync } from 'fs';
import type { BrainEngine } from '../core/engine.ts';
import { parseQrels, runEval, type EvalConfig, type EvalQrel } from '../core/search/eval.ts';
import { CANONICAL_RETRIEVAL_CASES } from '../core/search/retrieval-baseline.ts';
import { compareRetrievalExperiment, type RetrievalExperimentResult } from '../core/search/retrieval-experiment.ts';
import { planRetrievalCanary, renderRetrievalCanaryMarkdown, type RetrievalCanaryMode } from '../core/search/retrieval-canary.ts';

interface ParsedArgs {
  qrels?: string;
  canonical: boolean;
  gate?: string;
  baselineConfig?: string;
  candidateConfig?: string;
  output?: string;
  mode: RetrievalCanaryMode;
  profile?: string;
  allowProfile: string[];
  k: number;
  json: boolean;
  markdown: boolean;
}

export async function runRetrievalCanaryCommand(engine: BrainEngine | null, args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const gate = parsed.gate ? loadGate(parsed.gate) : await runGate(engine, parsed);
  const report = planRetrievalCanary({
    mode: parsed.mode,
    profile: parsed.profile,
    allowedProfiles: parsed.allowProfile,
    gate,
    outputRoot: parsed.output,
  });
  if (parsed.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (parsed.markdown) {
    process.stdout.write(renderRetrievalCanaryMarkdown(report));
    return;
  }
  console.log([
    `Retrieval canary: ${report.canary_enabled || report.mode === 'shadow' ? 'PASS' : 'BLOCKED'}`,
    `mode: ${report.mode}`,
    `scope: ${report.scope}`,
    `canary_enabled: ${report.canary_enabled}`,
    `candidate_served: ${report.candidate_served}`,
    `live_global_ranking_changed: false`,
    `rollback_required: ${report.rollback_required}`,
  ].join('\n'));
  if (parsed.mode === 'canary' && !report.canary_enabled) process.exit(1);
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { canonical: false, mode: 'shadow', allowProfile: [], k: 3, json: false, markdown: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      case '--qrels': parsed.qrels = args[++i]; break;
      case '--canonical': parsed.canonical = true; break;
      case '--gate': parsed.gate = args[++i]; break;
      case '--baseline-config': parsed.baselineConfig = args[++i]; break;
      case '--candidate-config': parsed.candidateConfig = args[++i]; break;
      case '--output': parsed.output = args[++i]; break;
      case '--mode': parsed.mode = args[++i] as RetrievalCanaryMode; break;
      case '--profile': parsed.profile = args[++i]; break;
      case '--allow-profile': parsed.allowProfile.push(args[++i]); break;
      case '--k': parsed.k = Number(args[++i]); break;
      case '--json': parsed.json = true; break;
      case '--markdown': parsed.markdown = true; break;
      default: throw new Error(`Unknown retrieval-canary option: ${arg}`);
    }
  }
  if (!['shadow', 'canary'].includes(parsed.mode)) throw new Error('--mode must be shadow or canary');
  return parsed;
}

function loadGate(path: string): RetrievalExperimentResult {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return raw.result ?? raw;
}

async function runGate(engine: BrainEngine | null, parsed: ParsedArgs): Promise<RetrievalExperimentResult> {
  if (!engine) throw new Error('Canonical/qrels retrieval canary requires a GBrain engine connection; use --gate <retrieval-experiment-gate.json> for offline mode.');
  const qrels = loadQrels(parsed);
  const baselineConfig = loadConfig(parsed.baselineConfig, { name: 'baseline-default-hybrid', strategy: 'hybrid', expand: false, limit: 10 });
  const candidateConfig = loadConfig(parsed.candidateConfig, { name: 'candidate-default-hybrid', strategy: 'hybrid', expand: false, limit: 10 });
  const [baseline, candidate] = await Promise.all([
    runEval(engine, qrels, baselineConfig, parsed.k),
    runEval(engine, qrels, candidateConfig, parsed.k),
  ]);
  const expectedTop1ByQuery = Object.fromEntries(qrels.map(q => [q.query, q.relevant[0]]).filter(([, slug]) => Boolean(slug))) as Record<string, string>;
  return compareRetrievalExperiment({ baseline, candidate, expectedTop1ByQuery });
}

function loadQrels(parsed: ParsedArgs): EvalQrel[] {
  if (parsed.canonical) return CANONICAL_RETRIEVAL_CASES.map(c => ({ id: c.query, query: c.query, relevant: [c.expectedSlug] }));
  if (!parsed.qrels) throw new Error('Missing --gate, --qrels <file|json>, or --canonical');
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
  console.log(`Usage: gbrain retrieval-canary (--gate gate.json|--canonical|--qrels qrels.json) [--mode shadow|canary] [--profile Agent] [--allow-profile Agent] [--output dir] [--json]

Run retrieval candidate in shadow/canary planning mode. Shadow returns baseline; canary requires allowlisted profile and passing gate.
`);
}
