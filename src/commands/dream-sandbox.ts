import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import {
  assertSafeDreamSandboxRoot,
  evaluateDreamSandbox,
  renderDreamSandboxBatchDecisionMarkdown,
  renderDreamSandboxEvaluationMarkdown,
  runDreamSandbox,
  runDreamSandboxBatchDecision,
} from '../core/dream-sandbox.ts';

interface ParsedDreamSandboxArgs {
  inputs: string[];
  outputRoot?: string;
  dryRun: boolean;
  json: boolean;
  canonicalRoot?: string;
  writeEval?: string;
  writeDecision?: string;
}

function printDreamSandboxHelp(): void {
  console.log(`Usage: gbrain dream-sandbox --input <transcript.txt> --output <sandbox-dir> [--dry-run] [--json]

Evaluate a transcript-to-dream artifact in an isolated sandbox.

Safety guarantees:
  - writes only under --output
  - refuses canonical Obsidian output roots
  - does not connect to live GBrain
  - performs 0 LLM calls and 0 minion/subagent jobs
  - uses experimental slugs under experiments/dreams/...

Options:
  --input <file>              Transcript file to evaluate (required)
  --output <dir>              Sandbox output root (required)
  --dry-run                   Render the artifact plan without writing files
  --json                      Emit machine-readable JSON
  --write-eval <file.md>      Write a sandbox-only evaluation report artifact
  --write-decision <file.md>  Write batch promote/park/discard decision report
  --canonical-root <dir>      Canonical vault root to refuse (default: Roger's Winston vault)
`);
}

function parseArgs(args: string[]): ParsedDreamSandboxArgs {
  const parsed: ParsedDreamSandboxArgs = { inputs: [], dryRun: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--help':
      case '-h':
        printDreamSandboxHelp();
        process.exit(0);
      case '--input':
        parsed.inputs.push(args[++i]);
        break;
      case '--output':
        parsed.outputRoot = args[++i];
        break;
      case '--dry-run':
        parsed.dryRun = true;
        break;
      case '--json':
        parsed.json = true;
        break;
      case '--write-eval':
        parsed.writeEval = args[++i];
        break;
      case '--write-decision':
        parsed.writeDecision = args[++i];
        break;
      case '--canonical-root':
        parsed.canonicalRoot = args[++i];
        break;
      default:
        throw new Error(`Unknown dream-sandbox option: ${arg}`);
    }
  }
  return parsed;
}

export async function runDreamSandboxCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.inputs.length === 0) throw new Error('Missing required --input <file>');
  if (!parsed.outputRoot) throw new Error('Missing required --output <dir>');

  const result = runDreamSandbox({
    input: parsed.inputs[0],
    outputRoot: parsed.outputRoot,
    dryRun: parsed.dryRun,
    canonicalRoot: parsed.canonicalRoot,
  });
  const evaluation = evaluateDreamSandbox(result);
  let evaluationPath: string | undefined;
  if (parsed.writeEval) {
    evaluationPath = parsed.writeEval;
    assertSafeDreamSandboxRoot(dirname(evaluationPath), parsed.canonicalRoot);
    mkdirSync(dirname(evaluationPath), { recursive: true });
    writeFileSync(evaluationPath, renderDreamSandboxEvaluationMarkdown(evaluation), 'utf8');
  }

  let decisionReport;
  let decisionReportPath: string | undefined;
  if (parsed.writeDecision || parsed.inputs.length > 1) {
    decisionReport = runDreamSandboxBatchDecision({
      inputs: parsed.inputs,
      outputRoot: parsed.outputRoot,
      dryRun: parsed.dryRun,
      canonicalRoot: parsed.canonicalRoot,
    });
    if (parsed.writeDecision) {
      decisionReportPath = parsed.writeDecision;
      assertSafeDreamSandboxRoot(dirname(decisionReportPath), parsed.canonicalRoot);
      mkdirSync(dirname(decisionReportPath), { recursive: true });
      writeFileSync(decisionReportPath, renderDreamSandboxBatchDecisionMarkdown(decisionReport), 'utf8');
    }
  }

  if (parsed.json) {
    console.log(JSON.stringify({
      ok: result.ok,
      input: result.input,
      outputRoot: result.outputRoot,
      slug: result.slug,
      outputPath: result.outputPath,
      written: result.written,
      contentHash: result.contentHash,
      transcriptBytes: result.transcriptBytes,
      sideEffects: result.sideEffects,
      evaluation,
      evaluationPath,
      decisionReport,
      decisionReportPath,
    }, null, 2));
    return;
  }

  console.log([
    `Dream sandbox ${result.written ? 'wrote' : 'planned'}: ${result.slug}`,
    `Output: ${result.outputPath}`,
    evaluationPath ? `Evaluation: ${evaluationPath}` : undefined,
    decisionReport ? `Decision: ${decisionReport.overallRecommendation}` : undefined,
    decisionReportPath ? `Decision report: ${decisionReportPath}` : undefined,
    `Transcript bytes: ${result.transcriptBytes}`,
    `Evaluation status: ${evaluation.overallStatus}`,
    'Side effects: llm=0 minions=0 live_db=0 canonical_vault=0',
  ].filter(Boolean).join('\n'));
}
