import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { auditFrontmatterDirectory } from '../core/frontmatter-inference.ts';

const USAGE = `Usage: gbrain frontmatter-audit <dir> [--json] [--write-report <path>] [--limit N]

Audit markdown files that have no YAML frontmatter and print deterministic inferred metadata proposals.

Safe by design:
  - read-only
  - does not modify source files
  - does not connect to the live database
  - intended for staging/vault-clone evaluation before any write-back decision

Options:
  --json                 Print full JSON report
  --write-report <path>  Write full JSON report to a file
  --limit N              Limit human-readable proposal rows (default 25)
`;

export async function runFrontmatterAudit(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE.trimEnd());
    return;
  }

  const dirArg = args.find(arg => !arg.startsWith('--') && !isValueForPreviousOption(args, arg));
  if (!dirArg) {
    console.error(USAGE.trimEnd());
    process.exit(1);
  }

  const root = resolve(dirArg);
  const report = auditFrontmatterDirectory(root);
  const writeReport = valueAfter(args, '--write-report');
  if (writeReport) {
    const reportPath = resolve(writeReport);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  }

  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const limit = Number(valueAfter(args, '--limit') ?? '25');
  printHumanReport(report, Number.isFinite(limit) ? limit : 25, writeReport ? resolve(writeReport) : undefined);
}

function printHumanReport(report: ReturnType<typeof auditFrontmatterDirectory>, limit: number, reportPath?: string): void {
  console.log('Frontmatter inference audit');
  console.log(`Root: ${report.root}`);
  console.log(`Markdown files: ${report.summary.totalMarkdown}`);
  console.log(`Existing frontmatter: ${report.summary.existingFrontmatter}`);
  console.log(`Missing frontmatter: ${report.summary.missingFrontmatter}`);
  if (reportPath) console.log(`JSON report: ${reportPath}`);

  console.log('\nBy inferred type:');
  for (const [type, count] of Object.entries(report.summary.byType)) {
    console.log(`  ${type}: ${count}`);
  }

  console.log('\nTop proposals:');
  for (const proposal of report.proposals.slice(0, Math.max(0, limit))) {
    const tags = proposal.inferred.tags?.length ? ` tags=${proposal.inferred.tags.join(',')}` : '';
    const date = proposal.inferred.date ? ` date=${proposal.inferred.date}` : '';
    console.log(`  ${proposal.relativePath} -> type=${proposal.inferred.type} title=${JSON.stringify(proposal.inferred.title)}${date}${tags}`);
  }
  if (report.proposals.length > limit) {
    console.log(`  ... ${report.proposals.length - limit} more`);
  }
}

function valueAfter(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function isValueForPreviousOption(args: string[], arg: string): boolean {
  const idx = args.indexOf(arg);
  if (idx <= 0) return false;
  return ['--write-report', '--limit'].includes(args[idx - 1]);
}
