import { generateSourceFixProposals, renderSourceFixProposalMarkdown } from '../core/source-fix-proposals.ts';

interface ParsedArgs {
  dir?: string;
  output?: string;
  json: boolean;
  markdown: boolean;
  dryRun: boolean;
}

export async function runSourceFixProposalsCommand(args: string[]) {
  const parsed = parseArgs(args);
  if (!parsed.dir) throw new Error('Missing required --dir <vault-subdir>');
  const report = generateSourceFixProposals({ root: parsed.dir, outputRoot: parsed.output, dryRun: parsed.dryRun });
  if (parsed.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (parsed.markdown) {
    process.stdout.write(renderSourceFixProposalMarkdown(report));
    return;
  }
  console.log([
    'Source Metadata Fix Proposals',
    `Root: ${report.root}`,
    `Files scanned: ${report.summary.files_scanned}`,
    `Proposals: ${report.summary.total_proposals}`,
    `Output: ${parsed.output ?? '(dry/report only)'}`,
    'Side effects: canonical_vault=0 live_db=0 live_sync=0',
  ].join('\n'));
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { json: false, markdown: false, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      case '--dir':
        parsed.dir = args[++i];
        break;
      case '--output':
        parsed.output = args[++i];
        break;
      case '--json':
        parsed.json = true;
        break;
      case '--markdown':
        parsed.markdown = true;
        break;
      case '--dry-run':
        parsed.dryRun = true;
        break;
      default:
        if (!arg.startsWith('--') && !parsed.dir) parsed.dir = arg;
        else throw new Error(`Unknown source-fix-proposals option: ${arg}`);
    }
  }
  return parsed;
}

function printHelp(): void {
  console.log(`Usage: gbrain source-fix-proposals --dir <vault-subdir> --output <staging-dir> [--json|--markdown] [--dry-run]

Generate review-only source metadata patch proposals for fleet-relevant markdown.

Safety guarantees:
  - no canonical writes
  - no live GBrain writes
  - output is proposal JSON/markdown only
`);
}
