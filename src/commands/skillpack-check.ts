/**
 * `gbrain skillpack-check` — local-safe agent-readable health report.
 *
 * This branch intentionally has the v0.19 skill/governance surface without
 * importing upstream migration/minion machinery. Keep this command buildable
 * and useful without depending on `apply-migrations` or global CLI option
 * modules that are not present on this local branch.
 */

import { execFileSync } from 'child_process';
import { VERSION } from '../version.ts';

interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
  issues?: unknown[];
}

interface SkillpackReport {
  version: string;
  ts: string;
  healthy: boolean;
  summary: string;
  actions: string[];
  doctor: {
    exit_code: number;
    checks: DoctorCheck[];
  } | { error: string };
  migrations: {
    pending_count: number;
    partial_count: number;
    applied_count: number;
    stdout: string;
    skipped?: boolean;
    reason?: string;
  };
}

function gbrainSpawn(): { cmd: string; prefix: string[] } {
  const arg1 = process.argv[1] ?? '';
  if (arg1.endsWith('/gbrain') || arg1.endsWith('\\gbrain.exe')) {
    return { cmd: arg1, prefix: [] };
  }
  if (arg1.endsWith('.ts') || arg1.endsWith('.mjs') || arg1.endsWith('.js')) {
    return { cmd: 'bun', prefix: [arg1] };
  }
  const execPath = process.execPath ?? '';
  if (execPath.endsWith('/gbrain') || execPath.endsWith('\\gbrain.exe')) {
    return { cmd: execPath, prefix: [] };
  }
  return { cmd: 'gbrain', prefix: [] };
}

function runDoctor(): SkillpackReport['doctor'] {
  const { cmd, prefix } = gbrainSpawn();
  try {
    const stdout = execFileSync(cmd, [...prefix, 'doctor', '--fast', '--json'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    const parsed = JSON.parse(stdout) as { checks: DoctorCheck[] };
    return { exit_code: 0, checks: parsed.checks ?? [] };
  } catch (err: any) {
    const stdout = err.stdout?.toString?.() ?? '';
    try {
      const parsed = JSON.parse(stdout) as { checks: DoctorCheck[] };
      return { exit_code: err.status ?? 1, checks: parsed.checks ?? [] };
    } catch {
      return { error: `doctor failed: ${err.message ?? String(err)}` };
    }
  }
}

function runMigrationsList(): SkillpackReport['migrations'] {
  return {
    applied_count: 0,
    pending_count: 0,
    partial_count: 0,
    stdout: 'apply-migrations is not part of this local staged GBrain branch; migration check skipped.',
    skipped: true,
    reason: 'apply-migrations command intentionally unported in local v0.19 skill/governance slice',
  };
}

function buildReport(): SkillpackReport {
  const doctor = runDoctor();
  const migrations = runMigrationsList();
  const actions: string[] = [];
  let healthy = true;

  if ('checks' in doctor) {
    for (const check of doctor.checks) {
      if (check.status === 'fail') {
        healthy = false;
        const runMatch = check.message.match(/Run:\s*(.+)$/);
        actions.push(runMatch ? runMatch[1].trim() : `[${check.name}] ${check.message}`);
      } else if (check.status === 'warn') {
        const runMatch = check.message.match(/Run:\s*(.+)$/);
        if (runMatch && !actions.includes(runMatch[1].trim())) actions.push(runMatch[1].trim());
      }
    }
  } else {
    healthy = false;
    actions.push('Investigate doctor failure: ' + doctor.error);
  }

  const summary = healthy
    ? 'gbrain skillpack healthy'
    : `gbrain skillpack needs attention: ${actions.length} action(s) — ${actions[0]}`;

  return {
    version: VERSION,
    ts: new Date().toISOString(),
    healthy,
    summary,
    actions,
    doctor,
    migrations,
  };
}

export async function runSkillpackCheck(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`gbrain skillpack-check — agent-readable health report.

Wraps doctor --fast --json into one JSON blob. On this local staged branch,
migration checks are reported as skipped because upstream apply-migrations
machinery is intentionally not ported.

Usage:
  gbrain skillpack-check            Pretty JSON to stdout, exit 0/1/2.
  gbrain skillpack check            Same report through the skillpack namespace.
  gbrain skillpack-check --quiet    Exit code only, no output.

Exit codes:
  0  healthy (no required action)
  1  action needed (see JSON.actions[])
  2  could not determine (binary or subcommand crash)
`);
    return;
  }

  const quiet = args.includes('--quiet');
  const report = buildReport();

  if (!quiet) {
    console.log(JSON.stringify(report, null, 2));
  }

  if ('error' in report.doctor) {
    process.exit(2);
  }
  process.exit(report.healthy ? 0 : 1);
}

export const __testing = { buildReport, runDoctor, runMigrationsList, gbrainSpawn };
