import { buildOrphanReport, writeOrphanReport } from '../core/orphan-report.ts';
import type { BrainEngine } from '../core/engine.ts';

interface ParsedArgs {
  output?: string;
  json: boolean;
  writeIndex: boolean;
}

export async function runOrphanReport(engine: BrainEngine, args: string[]) {
  const parsed = parseArgs(args);
  const report = await buildOrphanReport(engine);
  const written = parsed.output ? writeOrphanReport(report, parsed.output, { writeIndex: parsed.writeIndex }) : undefined;
  if (parsed.json) {
    console.log(JSON.stringify({ ok: true, written, report }, null, 2));
    return;
  }
  console.log(`Graph orphan report: ${report.summary.orphan_pages}/${report.summary.total_pages} orphan page(s), ${report.summary.groups} group(s)`);
  if (written) {
    console.log(`Wrote ${written.markdown}`);
    console.log(`Wrote ${written.json}`);
    if (written.index) console.log(`Wrote ${written.index}`);
  }
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { json: false, writeIndex: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      case '--output':
        parsed.output = args[++i];
        break;
      case '--json':
        parsed.json = true;
        break;
      case '--write-index':
        parsed.writeIndex = true;
        break;
      default:
        throw new Error(`Unknown orphan-report option: ${arg}`);
    }
  }
  return parsed;
}

function printHelp(): void {
  console.log(`Usage: gbrain orphan-report [--output dir] [--write-index] [--json]

Report pages with no incoming or outgoing graph links. With --write-index,
produce a reviewable index page that links orphan slugs without rewriting the
orphan pages themselves.

Options:
  --output <dir>      Write graph-orphan-report.{md,json}
  --write-index       Also write graph-orphan-index.md
  --json              Emit machine-readable result
`);
}
