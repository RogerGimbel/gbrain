import type { BrainEngine } from '../core/engine.ts';
import * as db from '../core/db.ts';
import { LATEST_VERSION } from '../core/migrate.ts';
import { checkResolvable } from '../core/check-resolvable.ts';
import { join } from 'path';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { isSourceUnchangedSinceSync } from '../core/git-head.ts';
import { analyzeFleetSources } from '../core/fleet-source.ts';

export interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
  issues?: Array<{ type: string; skill: string; action: string; fix?: any }>;
}

/**
 * Run doctor with filesystem-first, DB-second architecture.
 * Filesystem checks (resolver, conformance) run without engine.
 * DB checks run only if engine is provided.
 */
export async function runDoctor(engine: BrainEngine | null, args: string[]) {
  const jsonOutput = args.includes('--json');
  const fastMode = args.includes('--fast');
  const checks: Check[] = [];

  // --- Filesystem checks (always run, no DB needed) ---

  // 1. Resolver health
  const repoRoot = findRepoRoot();
  if (repoRoot) {
    const skillsDir = join(repoRoot, 'skills');
    const report = checkResolvable(skillsDir);
    if (report.ok && report.issues.length === 0) {
      checks.push({
        name: 'resolver_health',
        status: 'ok',
        message: `${report.summary.total_skills} skills, all reachable`,
      });
    } else {
      const errors = report.issues.filter(i => i.severity === 'error');
      const warnings = report.issues.filter(i => i.severity === 'warning');
      const status = errors.length > 0 ? 'fail' as const : 'warn' as const;
      const check: Check = {
        name: 'resolver_health',
        status,
        message: `${report.issues.length} issue(s): ${errors.length} error(s), ${warnings.length} warning(s)`,
        issues: report.issues.map(i => ({
          type: i.type,
          skill: i.skill,
          action: i.action,
          fix: i.fix,
        })),
      };
      checks.push(check);
    }
  } else {
    checks.push({ name: 'resolver_health', status: 'warn', message: 'Could not find skills directory' });
  }

  // 2. Skill conformance
  if (repoRoot) {
    const skillsDir = join(repoRoot, 'skills');
    const conformanceResult = checkSkillConformance(skillsDir);
    checks.push(conformanceResult);
  }

  // 2b. Optional source-aware fleet health. Opt-in via env so doctor remains portable.
  const sourceHealthDir = process.env.GBRAIN_SOURCE_HEALTH_DIR;
  if (sourceHealthDir) {
    if (!existsSync(sourceHealthDir)) {
      checks.push({ name: 'source_health', status: 'warn', message: `GBRAIN_SOURCE_HEALTH_DIR not found: ${sourceHealthDir}` });
    } else {
      const report = analyzeFleetSources(sourceHealthDir);
      const issues = report.summary.missing_source_metadata + report.summary.stale_sources;
      checks.push({
        name: 'source_health',
        status: issues === 0 ? 'ok' : 'warn',
        message: `${report.summary.source_covered}/${report.summary.total_files} source-covered, ${report.summary.stale_sources} stale`,
      });
    }
  }

  // --- DB checks (skip if --fast or no engine) ---

  if (fastMode) {
    checks.push({ name: 'connection', status: 'ok', message: 'DB checks skipped by --fast' });
    const earlyFail1 = outputResults(checks, jsonOutput);
    process.exit(earlyFail1 ? 1 : 0);
    return;
  }

  if (!engine) {
    checks.push({ name: 'connection', status: 'warn', message: 'No database configured (filesystem checks only)' });
    const earlyFail1 = outputResults(checks, jsonOutput);
    process.exit(earlyFail1 ? 1 : 0);
    return;
  }

  // 3. Connection
  try {
    const stats = await engine.getStats();
    checks.push({ name: 'connection', status: 'ok', message: `Connected, ${stats.page_count} pages` });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    checks.push({ name: 'connection', status: 'fail', message: msg });
    const earlyFail2 = outputResults(checks, jsonOutput);
    process.exit(earlyFail2 ? 1 : 0);
    return;
  }

  checks.push(await checkSyncFreshness(engine));

  // 4. pgvector extension
  try {
    const sql = db.getConnection();
    const ext = await sql`SELECT extname FROM pg_extension WHERE extname = 'vector'`;
    if (ext.length > 0) {
      checks.push({ name: 'pgvector', status: 'ok', message: 'Extension installed' });
    } else {
      checks.push({ name: 'pgvector', status: 'fail', message: 'Extension not found. Run: CREATE EXTENSION vector;' });
    }
  } catch {
    checks.push({ name: 'pgvector', status: 'warn', message: 'Could not check pgvector extension' });
  }

  // 5. RLS
  try {
    const sql = db.getConnection();
    const tables = await sql`
      SELECT tablename, rowsecurity FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN ('pages','content_chunks','links','tags','raw_data',
                           'page_versions','timeline_entries','ingest_log','config','files')
    `;
    const noRls = tables.filter((t: any) => !t.rowsecurity);
    if (noRls.length === 0) {
      checks.push({ name: 'rls', status: 'ok', message: 'RLS enabled on all tables' });
    } else {
      const names = noRls.map((t: any) => t.tablename).join(', ');
      checks.push({ name: 'rls', status: 'warn', message: `RLS not enabled on: ${names}` });
    }
  } catch {
    checks.push({ name: 'rls', status: 'warn', message: 'Could not check RLS status' });
  }

  // 6. Schema version
  try {
    const version = await engine.getConfig('version');
    const v = parseInt(version || '0', 10);
    if (v >= LATEST_VERSION) {
      checks.push({ name: 'schema_version', status: 'ok', message: `Version ${v} (latest: ${LATEST_VERSION})` });
    } else {
      checks.push({ name: 'schema_version', status: 'warn', message: `Version ${v}, latest is ${LATEST_VERSION}. Run gbrain init to migrate.` });
    }
  } catch {
    checks.push({ name: 'schema_version', status: 'warn', message: 'Could not check schema version' });
  }

  // 7. Embedding health
  try {
    const health = await engine.getHealth();
    const pct = (health.embed_coverage * 100).toFixed(0);
    if (health.embed_coverage >= 0.9) {
      checks.push({ name: 'embeddings', status: 'ok', message: `${pct}% coverage, ${health.missing_embeddings} missing` });
    } else if (health.embed_coverage > 0) {
      checks.push({ name: 'embeddings', status: 'warn', message: `${pct}% coverage, ${health.missing_embeddings} missing. Run: gbrain embed --stale` });
    } else {
      checks.push({ name: 'embeddings', status: 'warn', message: 'No embeddings yet. Run: gbrain embed --stale' });
    }
  } catch {
    checks.push({ name: 'embeddings', status: 'warn', message: 'Could not check embedding health' });
  }

  // 8. Link integrity
  try {
    const health = await engine.getHealth();
    if (health.dead_links === 0) {
      checks.push({ name: 'link_integrity', status: 'ok', message: 'No dead links' });
    } else {
      checks.push({ name: 'link_integrity', status: 'warn', message: `${health.dead_links} dead link(s). Run: gbrain check-backlinks --fix` });
    }
  } catch {
    checks.push({ name: 'link_integrity', status: 'warn', message: 'Could not check link integrity' });
  }

  const hasFail = outputResults(checks, jsonOutput);

  // Features teaser (non-JSON, non-failing only)
  if (!jsonOutput && !hasFail && engine) {
    try {
      const { featuresTeaserForDoctor } = await import('./features.ts');
      const teaser = await featuresTeaserForDoctor(engine);
      if (teaser) console.log(`\n${teaser}`);
    } catch { /* best-effort */ }
  }

  process.exit(hasFail ? 1 : 0);
}

export async function checkSyncFreshness(engine: BrainEngine): Promise<Check> {
  try {
    const repoPath = await engine.getConfig('sync.repo_path');
    const lastCommit = await engine.getConfig('sync.last_commit');

    if (!repoPath || !lastCommit) {
      return {
        name: 'sync_freshness',
        status: 'ok',
        message: 'No sync repo configured',
      };
    }

    if (isSourceUnchangedSinceSync(repoPath, lastCommit, { requireCleanWorkingTree: true })) {
      return {
        name: 'sync_freshness',
        status: 'ok',
        message: `Sync source unchanged at ${lastCommit.slice(0, 8)}`,
      };
    }

    return {
      name: 'sync_freshness',
      status: 'warn',
      message: `Configured sync repo is not at last synced commit ${lastCommit.slice(0, 8)} or has uncommitted changes. Run gbrain sync.`,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name: 'sync_freshness',
      status: 'warn',
      message: `Could not check sync freshness: ${msg}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find the GBrain repo root by walking up from cwd looking for skills/RESOLVER.md */
function findRepoRoot(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'skills', 'RESOLVER.md'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Quick skill conformance check — frontmatter + required sections */
function checkSkillConformance(skillsDir: string): Check {
  const manifestPath = join(skillsDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { name: 'skill_conformance', status: 'warn', message: 'manifest.json not found' };
  }

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const skills = manifest.skills || [];
    let passing = 0;
    const failing: string[] = [];

    for (const skill of skills) {
      const skillPath = join(skillsDir, skill.path);
      if (!existsSync(skillPath)) {
        failing.push(`${skill.name}: file missing`);
        continue;
      }
      const content = readFileSync(skillPath, 'utf-8');
      // Check frontmatter exists
      if (!content.startsWith('---')) {
        failing.push(`${skill.name}: no frontmatter`);
        continue;
      }
      passing++;
    }

    if (failing.length === 0) {
      return { name: 'skill_conformance', status: 'ok', message: `${passing}/${skills.length} skills pass` };
    }
    return {
      name: 'skill_conformance',
      status: 'warn',
      message: `${passing}/${skills.length} pass. Failing: ${failing.join(', ')}`,
    };
  } catch {
    return { name: 'skill_conformance', status: 'warn', message: 'Could not parse manifest.json' };
  }
}

function outputResults(checks: Check[], json: boolean): boolean {
  const hasFail = checks.some(c => c.status === 'fail');
  const hasWarn = checks.some(c => c.status === 'warn');

  // Compute composite health score (0-100)
  let score = 100;
  for (const c of checks) {
    if (c.status === 'fail') score -= 20;
    else if (c.status === 'warn') score -= 5;
  }
  score = Math.max(0, score);

  if (json) {
    const status = hasFail ? 'unhealthy' : hasWarn ? 'warnings' : 'healthy';
    console.log(JSON.stringify({ schema_version: 2, status, health_score: score, checks }));
    return hasFail;
  }

  console.log('\nGBrain Health Check');
  console.log('===================');
  for (const c of checks) {
    const icon = c.status === 'ok' ? 'OK' : c.status === 'warn' ? 'WARN' : 'FAIL';
    console.log(`  [${icon}] ${c.name}: ${c.message}`);
    if (c.issues) {
      for (const issue of c.issues) {
        console.log(`    → ${issue.type.toUpperCase()}: ${issue.skill}`);
        console.log(`      ACTION: ${issue.action}`);
      }
    }
  }

  if (hasFail) {
    console.log(`\nHealth score: ${score}/100. Failed checks found.`);
  } else if (hasWarn) {
    console.log(`\nHealth score: ${score}/100. All checks OK (some warnings).`);
  } else {
    console.log(`\nHealth score: ${score}/100. All checks passed.`);
  }
  return hasFail;
}
