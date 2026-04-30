import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import {
  createFrontmatterPatchPlan,
  renderFrontmatterPatch,
  type FrontmatterAuditReport,
  type FrontmatterPatchPlan,
} from '../core/frontmatter-inference.ts';

const USAGE = `Usage: gbrain frontmatter-apply <audit-report.json> --root <vault-root> --allow-prefix <prefix> --dry-run [--write-patch <path>] [--write-plan <path>] [--json]

Generate a human-reviewable frontmatter patch from a previous frontmatter-audit report.

Safe by design:
  - requires --dry-run
  - only accepts hardcoded safe allow-prefix values
  - writes patch/plan artifacts only
  - does not modify source markdown files
  - skips files that now have frontmatter or are missing

Options:
  --root <path>          Vault root to verify current files against
  --allow-prefix <path>  Allowlisted family to include, e.g. briefs/ or knowledge/projects/
  --dry-run              Required. Generate patch only; never write markdown files
  --write-patch <path>   Write unified patch artifact
  --write-plan <path>    Write JSON plan summary artifact
  --json                 Print JSON plan summary
`;

export async function runFrontmatterApply(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE.trimEnd());
    return;
  }

  if (!args.includes('--dry-run')) {
    console.error('Error: frontmatter-apply requires --dry-run. This command does not perform write-back.');
    console.error(USAGE.trimEnd());
    process.exit(1);
  }

  const reportArg = args.find(arg => !arg.startsWith('--') && !isValueForPreviousOption(args, arg));
  const rootArg = valueAfter(args, '--root');
  const allowPrefix = valueAfter(args, '--allow-prefix');
  if (!reportArg || !rootArg || !allowPrefix) {
    console.error(USAGE.trimEnd());
    process.exit(1);
  }

  const reportPath = resolve(reportArg);
  const root = resolve(rootArg);
  const report = JSON.parse(readFileSync(reportPath, 'utf-8')) as FrontmatterAuditReport;
  const plan = createFrontmatterPatchPlan(report, { root, allowPrefix });
  const patch = renderFrontmatterPatch(plan);

  const writePatch = valueAfter(args, '--write-patch');
  if (writePatch) {
    const patchPath = resolve(writePatch);
    mkdirSync(dirname(patchPath), { recursive: true });
    writeFileSync(patchPath, patch);
  }

  const writePlan = valueAfter(args, '--write-plan');
  if (writePlan) {
    const planPath = resolve(writePlan);
    mkdirSync(dirname(planPath), { recursive: true });
    writeFileSync(planPath, JSON.stringify(summarizePlan(plan), null, 2) + '\n');
  }

  if (args.includes('--json')) {
    console.log(JSON.stringify(summarizePlan(plan), null, 2));
    return;
  }

  printHumanPlan(plan, writePatch ? resolve(writePatch) : undefined, writePlan ? resolve(writePlan) : undefined);
}

function printHumanPlan(plan: FrontmatterPatchPlan, patchPath?: string, planPath?: string): void {
  console.log('Frontmatter apply dry-run');
  console.log(`Root: ${plan.root}`);
  console.log(`Allow prefix: ${plan.allowPrefix}`);
  console.log(`Proposals in report: ${plan.summary.proposalsInReport}`);
  console.log(`Selected for patch: ${plan.summary.selected}`);
  console.log(`Skipped outside prefix: ${plan.summary.skippedDisallowedPrefix}`);
  console.log(`Skipped existing frontmatter: ${plan.summary.skippedExistingFrontmatter}`);
  console.log(`Skipped missing files: ${plan.summary.skippedMissingFile}`);
  console.log(`Skipped unsafe paths: ${plan.summary.skippedUnsafePath}`);
  if (patchPath) console.log(`Patch artifact: ${patchPath}`);
  if (planPath) console.log(`Plan artifact: ${planPath}`);
  if (plan.warnings.length) {
    console.log('\nWarnings:');
    for (const warning of plan.warnings.slice(0, 20)) console.log(`  ${warning}`);
    if (plan.warnings.length > 20) console.log(`  ... ${plan.warnings.length - 20} more`);
  }
}

function summarizePlan(plan: FrontmatterPatchPlan): object {
  return {
    root: plan.root,
    allowPrefix: plan.allowPrefix,
    generatedAt: plan.generatedAt,
    summary: plan.summary,
    warnings: plan.warnings,
    patches: plan.patches.map(entry => ({
      relativePath: entry.relativePath,
      generatedFrontmatter: entry.generatedFrontmatter,
    })),
  };
}

function valueAfter(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function isValueForPreviousOption(args: string[], arg: string): boolean {
  const idx = args.indexOf(arg);
  if (idx <= 0) return false;
  return ['--root', '--allow-prefix', '--write-patch', '--write-plan'].includes(args[idx - 1]);
}
