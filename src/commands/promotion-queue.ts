import { scanPromotionQueue, renderPromotionQueueMarkdown } from '../core/promotion-queue.ts';

interface ParsedArgs {
  input?: string;
  output?: string;
  json: boolean;
  markdown: boolean;
  dryRun: boolean;
}

export async function runPromotionQueueCommand(args: string[]) {
  const parsed = parseArgs(args);
  if (!parsed.input) throw new Error('Missing required --input <dir>');

  const report = scanPromotionQueue({ inputRoot: parsed.input, outputRoot: parsed.output, dryRun: parsed.dryRun });
  if (parsed.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (parsed.markdown) {
    process.stdout.write(renderPromotionQueueMarkdown(report));
    return;
  }
  console.log([
    'GBrain Promotion Queue',
    `Input: ${report.input_root}`,
    `Items: ${report.summary.total_items}`,
    `Ready: ${report.summary.ready_items}`,
    `Blocked: ${report.summary.blocked_items}`,
    `Output: ${parsed.output ?? '(dry/report only)'}`,
    'Side effects: live_db=0 canonical_vault=0 live_sync=0',
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
      case '--input':
        parsed.input = args[++i];
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
      case 'scan':
        break;
      default:
        if (!arg.startsWith('--') && !parsed.input) parsed.input = arg;
        else throw new Error(`Unknown promotion-queue option: ${arg}`);
    }
  }
  return parsed;
}

function printHelp(): void {
  console.log(`Usage: gbrain promotion-queue scan --input <dir> [--output <dir>] [--json|--markdown] [--dry-run]

Scan sandbox artifacts into deterministic promotion queue manifests.

Safety guarantees:
  - scan/report mode does not write canonical Obsidian or live GBrain
  - raw transcripts are blocked
  - secret-looking artifacts are blocked
  - reports include checksums, risk, source metadata, and suggested targets
`);
}
