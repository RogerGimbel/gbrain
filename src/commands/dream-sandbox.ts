import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import {
  assertSafeDreamSandboxRoot,
  evaluateDreamSandbox,
  renderDreamSandboxBatchDecisionMarkdown,
  renderDreamSandboxEvaluationMarkdown,
  runDreamSandbox,
  runDreamSandboxBatchDecision,
  runDreamSandboxCrossReferenceEvaluation,
  runDreamSandboxPromotionApplyDryRun,
  runDreamSandboxPromotionCanonicalPromote,
  runDreamSandboxPromotionPacket,
} from '../core/dream-sandbox.ts';
import type { BrainEngine } from '../core/engine.ts';

interface ParsedDreamSandboxArgs {
  inputs: string[];
  outputRoot?: string;
  dryRun: boolean;
  json: boolean;
  canonicalRoot?: string;
  writeEval?: string;
  writeDecision?: string;
  writeXrefEval?: string;
  writePromotionPacket?: string;
  applyPromotionDryRun: boolean;
  promoteReviewedPacket: boolean;
  promotionPacket?: string;
  stagingVault?: string;
  targetPage?: string;
  writeApplyReport?: string;
  writePromotionReport?: string;
  xrefQueries: string[];
  xrefLimit: number;
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
  --write-xref-eval <file.md> Write read-only search/cross-reference evaluation report
  --write-promotion-packet <dir>
                              Write a dry-run human-review promotion packet under <dir>
  --apply-promotion-dry-run   Apply one reviewed packet into a throwaway staging vault only
  --promotion-packet <dir>    Reviewed promotion packet root for apply/promote commands
  --staging-vault <dir>       Throwaway staging vault root for --apply-promotion-dry-run
  --write-apply-report <dir>  Report root for --apply-promotion-dry-run
  --promote-reviewed-packet   Append a reviewed packet summary to an existing canonical target page
  --target-page <slug>        Existing canonical page slug for --promote-reviewed-packet
  --write-promotion-report <dir>
                              Report root for --promote-reviewed-packet
  --xref-query <query>        Query existing brain read-only; repeatable with --write-xref-eval
  --xref-limit <n>            Search results per xref query (default: 3, max: 10)
  --canonical-root <dir>      Canonical vault root to refuse (default: Roger's Winston vault)
`);
}

function parseArgs(args: string[]): ParsedDreamSandboxArgs {
  const parsed: ParsedDreamSandboxArgs = { inputs: [], dryRun: false, json: false, applyPromotionDryRun: false, promoteReviewedPacket: false, xrefQueries: [], xrefLimit: 3 };
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
      case '--write-xref-eval':
        parsed.writeXrefEval = args[++i];
        break;
      case '--write-promotion-packet':
        parsed.writePromotionPacket = args[++i];
        break;
      case '--apply-promotion-dry-run':
        parsed.applyPromotionDryRun = true;
        break;
      case '--promote-reviewed-packet':
        parsed.promoteReviewedPacket = true;
        break;
      case '--promotion-packet':
        parsed.promotionPacket = args[++i];
        break;
      case '--staging-vault':
        parsed.stagingVault = args[++i];
        break;
      case '--target-page':
        parsed.targetPage = args[++i];
        break;
      case '--write-apply-report':
        parsed.writeApplyReport = args[++i];
        break;
      case '--write-promotion-report':
        parsed.writePromotionReport = args[++i];
        break;
      case '--xref-query':
        parsed.xrefQueries.push(args[++i]);
        break;
      case '--xref-limit':
        parsed.xrefLimit = Number(args[++i]);
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

export async function runDreamSandboxCommand(args: string[], engine?: Pick<BrainEngine, 'searchKeyword'>): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.promoteReviewedPacket) {
    if (!parsed.promotionPacket) throw new Error('--promote-reviewed-packet requires --promotion-packet <dir>');
    if (!parsed.canonicalRoot) throw new Error('--promote-reviewed-packet requires --canonical-root <dir>');
    if (!parsed.targetPage) throw new Error('--promote-reviewed-packet requires --target-page <slug>');
    if (!parsed.writePromotionReport) throw new Error('--promote-reviewed-packet requires --write-promotion-report <dir>');
    const canonicalPromotion = runDreamSandboxPromotionCanonicalPromote({
      promotionPacketRoot: parsed.promotionPacket,
      canonicalRoot: parsed.canonicalRoot,
      targetPage: parsed.targetPage,
      reportRoot: parsed.writePromotionReport,
    });
    if (parsed.json) {
      console.log(JSON.stringify({ ok: true, canonicalPromotion }, null, 2));
      return;
    }
    console.log([
      `Dream sandbox canonical promotion: ${canonicalPromotion.status}`,
      `Target page: ${canonicalPromotion.targetPage}`,
      `Target path: ${canonicalPromotion.targetPath}`,
      `Report: ${canonicalPromotion.reportFiles.markdown}`,
      'Side effects: llm=0 minions=0 live_db=0 canonical_vault=1 proposed_links=0 live_sync=0',
    ].join('\n'));
    return;
  }
  if (parsed.applyPromotionDryRun) {
    if (!parsed.promotionPacket) throw new Error('--apply-promotion-dry-run requires --promotion-packet <dir>');
    if (!parsed.stagingVault) throw new Error('--apply-promotion-dry-run requires --staging-vault <dir>');
    if (!parsed.writeApplyReport) throw new Error('--apply-promotion-dry-run requires --write-apply-report <dir>');
    const applyDryRun = runDreamSandboxPromotionApplyDryRun({
      promotionPacketRoot: parsed.promotionPacket,
      stagingVaultRoot: parsed.stagingVault,
      reportRoot: parsed.writeApplyReport,
      canonicalRoot: parsed.canonicalRoot,
    });
    if (parsed.json) {
      console.log(JSON.stringify({ ok: true, applyDryRun }, null, 2));
      return;
    }
    console.log([
      `Dream sandbox promotion apply dry-run: ${applyDryRun.status}`,
      `Staged file: ${applyDryRun.stagedFiles[0]}`,
      `Report: ${applyDryRun.reportFiles.markdown}`,
      'Side effects: llm=0 minions=0 live_db=0 canonical_vault=0 live_sync=0',
    ].join('\n'));
    return;
  }

  if (parsed.inputs.length === 0) throw new Error('Missing required --input <file>');
  if (!parsed.outputRoot) throw new Error('Missing required --output <dir>');
  if (parsed.writeXrefEval && parsed.xrefQueries.length === 0) throw new Error('--write-xref-eval requires at least one --xref-query');
  if ((parsed.writeXrefEval || parsed.xrefQueries.length > 0) && !engine) throw new Error('Read-only xref evaluation requires a connected search engine');

  const result = runDreamSandbox({
    input: parsed.inputs[0],
    outputRoot: parsed.outputRoot,
    dryRun: parsed.dryRun,
    canonicalRoot: parsed.canonicalRoot,
  });
  let evaluation = evaluateDreamSandbox(result);
  let evaluationPath: string | undefined;
  if (parsed.writeEval) {
    evaluationPath = parsed.writeEval;
    assertSafeDreamSandboxRoot(dirname(evaluationPath), parsed.canonicalRoot);
    mkdirSync(dirname(evaluationPath), { recursive: true });
    writeFileSync(evaluationPath, renderDreamSandboxEvaluationMarkdown(evaluation), 'utf8');
  }

  let xrefEvaluationPath: string | undefined;
  if (parsed.writeXrefEval && engine) {
    evaluation = await runDreamSandboxCrossReferenceEvaluation({
      result,
      queries: parsed.xrefQueries,
      limit: parsed.xrefLimit,
      search: async (query, limit) => {
        const results = await engine.searchKeyword(query, { limit });
        return results.map(r => ({
          query,
          slug: r.slug,
          title: r.title,
          type: String(r.type),
          score: r.score,
        }));
      },
    });
    xrefEvaluationPath = parsed.writeXrefEval;
    assertSafeDreamSandboxRoot(dirname(xrefEvaluationPath), parsed.canonicalRoot);
    mkdirSync(dirname(xrefEvaluationPath), { recursive: true });
    writeFileSync(xrefEvaluationPath, renderDreamSandboxEvaluationMarkdown(evaluation), 'utf8');
  } else if (parsed.writePromotionPacket && parsed.xrefQueries.length > 0 && engine) {
    evaluation = await runDreamSandboxCrossReferenceEvaluation({
      result,
      queries: parsed.xrefQueries,
      limit: parsed.xrefLimit,
      search: async (query, limit) => {
        const results = await engine.searchKeyword(query, { limit });
        return results.map(r => ({
          query,
          slug: r.slug,
          title: r.title,
          type: String(r.type),
          score: r.score,
        }));
      },
    });
  }

  let promotionPacket;
  if (parsed.writePromotionPacket) {
    assertSafeDreamSandboxRoot(parsed.writePromotionPacket, parsed.canonicalRoot);
    promotionPacket = runDreamSandboxPromotionPacket({
      result,
      evaluation,
      packetRoot: parsed.writePromotionPacket,
      canonicalRoot: parsed.canonicalRoot,
    });
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
      xrefEvaluationPath,
      promotionPacket,
      decisionReport,
      decisionReportPath,
    }, null, 2));
    return;
  }

  console.log([
    `Dream sandbox ${result.written ? 'wrote' : 'planned'}: ${result.slug}`,
    `Output: ${result.outputPath}`,
    evaluationPath ? `Evaluation: ${evaluationPath}` : undefined,
    xrefEvaluationPath ? `Read-only xref evaluation: ${xrefEvaluationPath}` : undefined,
    promotionPacket ? `Promotion packet: ${promotionPacket.packetRoot}` : undefined,
    decisionReport ? `Decision: ${decisionReport.overallRecommendation}` : undefined,
    decisionReportPath ? `Decision report: ${decisionReportPath}` : undefined,
    `Transcript bytes: ${result.transcriptBytes}`,
    `Evaluation status: ${evaluation.overallStatus}`,
    'Side effects: llm=0 minions=0 live_db=0 canonical_vault=0',
  ].filter(Boolean).join('\n'));
}
