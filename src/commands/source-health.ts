import { analyzeFleetSources, renderSourceHealthMarkdown } from '../core/fleet-source.ts';

export async function runSourceHealth(args: string[]) {
  const jsonOutput = args.includes('--json');
  const markdownOutput = args.includes('--markdown');
  const includeAllMarkdown = args.includes('--all');
  const staleAfterDays = numberArg(args, '--stale-after-days') ?? 14;
  const dir = positionalDir(args) ?? process.env.GBRAIN_SOURCE_HEALTH_DIR ?? process.cwd();

  const report = analyzeFleetSources(dir, { staleAfterDays, includeAllMarkdown });

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (markdownOutput) {
    process.stdout.write(renderSourceHealthMarkdown(report));
    return;
  }

  const s = report.summary;
  console.log('GBrain Source Health');
  console.log('====================');
  console.log(`Root: ${s.root}`);
  console.log(`Files scanned: ${s.total_files}`);
  console.log(`Source covered: ${s.source_covered}/${s.total_files}`);
  console.log(`Missing source metadata: ${s.missing_source_metadata}`);
  console.log(`Stale sources: ${s.stale_sources} (>${s.stale_after_days} days)`);
  console.log(`Agents: ${s.agents}`);

  if (Object.keys(report.by_agent).length > 0) {
    console.log('\nBy agent:');
    for (const [agent, rollup] of Object.entries(report.by_agent).sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`  ${agent}: ${rollup.files} file(s), stale ${rollup.stale}, missing ${rollup.missing_metadata}`);
    }
  }

  if (report.missing.length > 0) {
    console.log('\nMissing metadata examples:');
    for (const item of report.missing.slice(0, 10)) {
      console.log(`  ${item.path}: missing ${item.missing_fields.join(', ')}`);
    }
  }
}

function positionalDir(args: string[]): string | undefined {
  for (const arg of args) {
    if (!arg.startsWith('--')) return arg;
  }
  return undefined;
}

function numberArg(args: string[], name: string): number | undefined {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  const n = Number(args[idx + 1]);
  return Number.isFinite(n) ? n : undefined;
}
