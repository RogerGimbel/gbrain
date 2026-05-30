import { analyzeFleetDrift, renderFleetDriftMarkdown } from '../core/fleet-drift.ts';

interface ParsedArgs {
  dir?: string;
  output?: string;
  json: boolean;
  markdown: boolean;
  dryRun: boolean;
  staleAfterDays?: number;
}

export async function runFleetDriftCommand(args: string[]) {
  const parsed = parseArgs(args);
  if (!parsed.dir) throw new Error('Missing required --dir <fleet-knowledge-dir>');
  const report = analyzeFleetDrift({ root: parsed.dir, outputRoot: parsed.output, dryRun: parsed.dryRun, staleAfterDays: parsed.staleAfterDays });
  if (parsed.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (parsed.markdown) {
    process.stdout.write(renderFleetDriftMarkdown(report));
    return;
  }
  console.log([
    'Fleet Drift Report',
    `Root: ${report.root}`,
    `Files scanned: ${report.summary.files_scanned}`,
    `Findings: ${report.summary.total_findings}`,
    `Conflicts: ${report.summary.conflicts}`,
    `Dead refs: ${report.summary.dead_references}`,
    `Output: ${parsed.output ?? '(dry/report only)'}`,
    'Side effects: canonical_vault=0 live_db=0 deletes=0',
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
      case '--stale-after-days':
        parsed.staleAfterDays = Number(args[++i]);
        break;
      default:
        if (!arg.startsWith('--') && !parsed.dir) parsed.dir = arg;
        else throw new Error(`Unknown fleet-drift option: ${arg}`);
    }
  }
  return parsed;
}

function printHelp(): void {
  console.log(`Usage: gbrain fleet-drift --dir <fleet-knowledge-dir> [--output <reports-dir>] [--json|--markdown]

Detect stale, conflicting, superseded, or dead-reference fleet knowledge.

Safety guarantees:
  - report-only; no rewrites or deletes
  - evidence attached to every finding
`);
}
