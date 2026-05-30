import { applySourceFixProposals, renderSourceFixApplyReceiptMarkdown, type SourceFixConfidence } from '../core/source-fix-proposals.ts';

interface ParsedArgs {
  report?: string;
  root?: string;
  output?: string;
  apply: boolean;
  dryRun: boolean;
  json: boolean;
  markdown: boolean;
  minConfidence: SourceFixConfidence;
  excludeUnknown: boolean;
  limit?: number;
}

export async function runSourceFixApplyCommand(args: string[]) {
  const parsed = parseArgs(args);
  if (!parsed.report) throw new Error('Missing required --report <source-fix-proposals.json>');
  if (!parsed.root) throw new Error('Missing required --root <vault-root>');
  const receipt = applySourceFixProposals({
    reportPath: parsed.report,
    root: parsed.root,
    outputRoot: parsed.output,
    apply: parsed.apply,
    dryRun: parsed.dryRun,
    minConfidence: parsed.minConfidence,
    excludeUnknown: parsed.excludeUnknown,
    limit: parsed.limit,
  });
  if (parsed.json) {
    console.log(JSON.stringify(receipt, null, 2));
    return;
  }
  if (parsed.markdown) {
    process.stdout.write(renderSourceFixApplyReceiptMarkdown(receipt));
    return;
  }
  console.log([
    'Source Metadata Apply Receipt',
    `Mode: ${receipt.apply ? 'apply' : 'dry-run'}`,
    `Root: ${receipt.root}`,
    `Report: ${receipt.report_path}`,
    `Eligible: ${receipt.summary.eligible}`,
    `Applied: ${receipt.summary.applied}`,
    `Skipped: ${receipt.summary.skipped}`,
    `Blocked: ${receipt.summary.blocked}`,
    `Side effects: canonical_vault=${receipt.sideEffects.canonicalVaultWrites} live_db=0 live_sync=0`,
  ].join('\n'));
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { apply: false, dryRun: false, json: false, markdown: false, minConfidence: 'medium', excludeUnknown: true };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      case '--report': parsed.report = args[++i]; break;
      case '--root': parsed.root = args[++i]; break;
      case '--output': parsed.output = args[++i]; break;
      case '--apply': parsed.apply = true; break;
      case '--dry-run': parsed.dryRun = true; break;
      case '--json': parsed.json = true; break;
      case '--markdown': parsed.markdown = true; break;
      case '--min-confidence': parsed.minConfidence = parseConfidence(args[++i]); break;
      case '--exclude-unknown': parsed.excludeUnknown = true; break;
      case '--include-unknown': parsed.excludeUnknown = false; break;
      case '--limit': parsed.limit = Number(args[++i]); break;
      default: throw new Error(`Unknown source-fix-apply option: ${arg}`);
    }
  }
  if (parsed.limit !== undefined && (!Number.isFinite(parsed.limit) || parsed.limit < 0)) throw new Error('--limit must be a non-negative number');
  return parsed;
}

function parseConfidence(value: string): SourceFixConfidence {
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  throw new Error('--min-confidence must be low, medium, or high');
}

function printHelp(): void {
  console.log(`Usage: gbrain source-fix-apply --report source-fix-proposals.json --root <vault-root> [--output dir] [--apply] [--min-confidence low|medium|high] [--limit N] [--json|--markdown]

Reviewed source metadata apply lane. Dry-run by default; writes canonical markdown only with explicit --apply.

Safety defaults:
  - min confidence: medium
  - exclude source_agent: unknown
  - no live GBrain writes or sync
  - writes receipt JSON/markdown when --output is provided
`);
}
