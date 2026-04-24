import { existsSync } from 'fs';
import { isAbsolute, join, resolve as resolvePath } from 'path';
import { RESOLVER_FILENAMES, hasResolverFile } from './resolver-filenames.ts';

/**
 * Walk up from `startDir` looking for a `skills/` directory that
 * contains a recognized resolver file (`RESOLVER.md` or `AGENTS.md`).
 * Returns the absolute directory containing `skills/` or null if no
 * such directory is found within 10 levels.
 *
 * `startDir` is parameterized so tests can run hermetically against
 * fixtures. Default matches the prior `doctor.ts`-private implementation.
 */
export function findRepoRoot(startDir: string = process.cwd()): string | null {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (hasResolverFile(join(dir, 'skills'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Where auto-detect found the skills directory.
 *   - `explicit`                    — user passed --skills-dir / equivalent
 *   - `openclaw_workspace_env`       — $OPENCLAW_WORKSPACE/skills
 *   - `openclaw_workspace_env_root`  — $OPENCLAW_WORKSPACE/ (AGENTS.md at
 *                                      workspace root; skills in subdir)
 *   - `openclaw_workspace_home`      — ~/.openclaw/workspace/skills
 *   - `openclaw_workspace_home_root` — ~/.openclaw/workspace (root AGENTS.md)
 *   - `repo_root`                    — walked up from cwd, found gbrain repo
 *   - `cwd_skills`                   — ./skills fallback
 */
export type SkillsDirSource =
  | 'openclaw_workspace_env'
  | 'openclaw_workspace_env_root'
  | 'openclaw_workspace_home'
  | 'openclaw_workspace_home_root'
  | 'repo_root'
  | 'cwd_skills';

export interface SkillsDirDetection {
  dir: string | null;
  source: SkillsDirSource | null;
}

/**
 * Given a workspace root, resolve where the skills directory should
 * live. Returns the skills dir + the specific source variant. Returns
 * null if neither `workspace/skills/<RESOLVER|AGENTS>` nor
 * `workspace/<AGENTS|RESOLVER>` exists.
 *
 * `sourceSubdir` / `sourceRoot` let callers distinguish "skills-dir
 * variant" from "workspace-root variant" for --verbose logging.
 */
function resolveWorkspaceSkillsDir(
  workspace: string,
  sourceSubdir: SkillsDirSource,
  sourceRoot: SkillsDirSource,
): SkillsDirDetection | null {
  // Preferred: workspace/skills with a resolver file inside it (gbrain-native).
  const subdir = join(workspace, 'skills');
  if (hasResolverFile(subdir)) {
    return { dir: subdir, source: sourceSubdir };
  }
  // Fallback: resolver file at workspace root (OpenClaw-native layout).
  // The skills/ subtree still governs file layout even when routing lives
  // at workspace root. Return the skills subdir so downstream file lookups
  // work; the resolver parser knows how to look one level up.
  if (hasResolverFile(workspace) && existsSync(subdir)) {
    return { dir: subdir, source: sourceRoot };
  }
  return null;
}

/**
 * Auto-detect the skills directory. Priority (D-CX-4, post-codex-review):
 *   1. $OPENCLAW_WORKSPACE when explicitly set (env > repo-root walk)
 *   2. findRepoRoot() walk from cwd (gbrain's own repo)
 *   3. ./skills fallback (dev scratch, fixtures)
 *   4. ~/.openclaw/workspace/ when cwd is under HOME
 *
 * The prior order put `findRepoRoot` first, which meant
 * `export OPENCLAW_WORKSPACE=...; gbrain check-resolvable` run from
 * inside the gbrain repo silently shadowed the env var by walking up
 * to gbrain's own skills/. Explicit env should win. Unset env → behavior
 * is unchanged from before.
 *
 * `startDir` + `env` params keep tests hermetic.
 */
export function autoDetectSkillsDir(
  startDir: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): SkillsDirDetection {
  // 1. $OPENCLAW_WORKSPACE wins when explicitly set.
  if (env.OPENCLAW_WORKSPACE) {
    const workspace = isAbsolute(env.OPENCLAW_WORKSPACE)
      ? env.OPENCLAW_WORKSPACE
      : resolvePath(startDir, env.OPENCLAW_WORKSPACE);
    const resolved = resolveWorkspaceSkillsDir(
      workspace,
      'openclaw_workspace_env',
      'openclaw_workspace_env_root',
    );
    if (resolved) return resolved;
  }

  // 2. gbrain repo walk from cwd. This must beat the HOME-level OpenClaw
  // fallback so development and tests inside the gbrain repo validate this
  // repo's skills/, not the user's live ~/.openclaw/workspace.
  const repoRoot = findRepoRoot(startDir);
  if (repoRoot && isGbrainRepoRoot(repoRoot)) {
    return { dir: join(repoRoot, 'skills'), source: 'repo_root' };
  }

  // 3. ./skills fallback.
  const cwdSkills = join(startDir, 'skills');
  if (hasResolverFile(cwdSkills)) {
    return { dir: cwdSkills, source: 'cwd_skills' };
  }

  // 4. ~/.openclaw/workspace as the default user-level OpenClaw deployment.
  // Gate this to cwd under HOME so unrelated scratch directories (e.g. /tmp
  // test fixtures) stay hermetic and return no_skills_dir instead of leaking
  // the operator's real OpenClaw workspace into unit tests.
  if (env.HOME && isWithinHome(startDir, env.HOME)) {
    const workspace = join(env.HOME, '.openclaw', 'workspace');
    const resolved = resolveWorkspaceSkillsDir(
      workspace,
      'openclaw_workspace_home',
      'openclaw_workspace_home_root',
    );
    if (resolved) return resolved;
  }

  return { dir: null, source: null };
}

function isWithinHome(startDir: string, homeDir: string): boolean {
  const start = resolvePath(startDir);
  const home = resolvePath(homeDir);
  return start === home || start.startsWith(home + '/');
}

function isGbrainRepoRoot(dir: string): boolean {
  return (
    existsSync(join(dir, 'src', 'cli.ts')) &&
    hasResolverFile(join(dir, 'skills'))
  );
}

/**
 * Human-readable summary of the resolver-file search paths, for error
 * messages when auto-detect fails. Mirrors the priority order used by
 * `autoDetectSkillsDir`.
 */
export const AUTO_DETECT_HINT = [
  `  1. --skills-dir flag`,
  `  2. $OPENCLAW_WORKSPACE/{skills/,}{${RESOLVER_FILENAMES.join(',')}}`,
  `  3. repo root with skills/${RESOLVER_FILENAMES.join(' or skills/')}`,
  `  4. ./skills/${RESOLVER_FILENAMES.join(' or ./skills/')}`,
  `  5. ~/.openclaw/workspace/{skills/,}{${RESOLVER_FILENAMES.join(',')}}`,
].join('\n');
