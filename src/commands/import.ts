import { readdirSync, lstatSync, existsSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, relative } from 'path';
import { cpus, totalmem } from 'os';
import type { BrainEngine } from '../core/engine.ts';
import { importFile } from '../core/import-file.ts';
import { gbrainPath, loadConfig } from '../core/config.ts';
import {
  clearCheckpoint,
  loadCheckpoint,
  markCompletedPath,
  resumeFilter,
  saveCheckpoint,
} from '../core/import-checkpoint.ts';
import { sortNewestFirst } from '../core/sort-newest-first.ts';

function defaultWorkers(): number {
  const cpuCount = cpus().length;
  const memGB = totalmem() / (1024 ** 3);
  // Network-bound, so we can go higher than CPU count.
  // Cap by: DB pool (leave 2 for other queries), CPU, memory.
  const byPool = 8;
  const byCpu = Math.max(2, cpuCount);
  const byMem = Math.floor(memGB * 2);
  return Math.min(byPool, byCpu, byMem);
}

export async function runImport(engine: BrainEngine, args: string[]) {
  const noEmbed = args.includes('--no-embed');
  const fresh = args.includes('--fresh');
  const jsonOutput = args.includes('--json');
  const workersIdx = args.indexOf('--workers');
  const workersArg = workersIdx !== -1 ? args[workersIdx + 1] : null;
  const workerCount = workersArg ? parseInt(workersArg, 10) : 1;
  const excludeDirs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--exclude-dir' && args[i + 1]) excludeDirs.push(args[i + 1]!);
  }
  const skipGbrainSlugged = args.includes('--skip-gbrain-slugged');
  // Find dir: first non-flag arg that isn't a value for a named flag.
  const flagValues = new Set<number>();
  if (workersIdx !== -1) flagValues.add(workersIdx + 1);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--exclude-dir') flagValues.add(i + 1);
  }
  const dir = args.find((a, i) => !a.startsWith('--') && !flagValues.has(i));

  if (!dir) {
    console.error('Usage: gbrain import <dir> [--no-embed] [--workers N] [--fresh] [--json] [--exclude-dir DIR] [--skip-gbrain-slugged]');
    process.exit(1);
  }
  const importDir = dir!;

  // Collect all .md files
  const allFiles = sortNewestFirst(collectMarkdownFiles(importDir, { excludeDirs, skipGbrainSlugged }));
  console.log(`Found ${allFiles.length} markdown files`);

  // Resume from checkpoint if available
  const checkpointPath = gbrainPath('import-checkpoint.json');
  const loadedCheckpoint = fresh ? null : loadCheckpoint(checkpointPath, importDir);
  const completedPaths = new Set<string>(loadedCheckpoint?.completedPaths ?? []);
  const files = resumeFilter(allFiles, importDir, completedPaths);

  if (loadedCheckpoint) {
    console.log(`Resuming from checkpoint: skipping ${completedPaths.size} completed files`);
  }

  // Determine actual worker count
  const actualWorkers = workerCount > 1 ? workerCount : 1;
  if (actualWorkers > 1) {
    console.log(`Using ${actualWorkers} parallel workers`);
  }

  let imported = 0;
  let skipped = 0;
  let errors = 0;
  let processed = 0;
  let chunksCreated = 0;
  const importedSlugs: string[] = [];
  const errorCounts: Record<string, number> = {};
  const startTime = Date.now();

  function logProgress() {
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = elapsed > 0 ? Math.round(processed / elapsed) : 0;
    const remaining = rate > 0 ? Math.round((files.length - processed) / rate) : 0;
    const pct = Math.round((processed / files.length) * 100);
    console.log(`[gbrain import] ${processed}/${files.length} (${pct}%) | ${rate} files/sec | imported: ${imported} | skipped: ${skipped} | errors: ${errors} | ETA: ${remaining}s`);
  }

  async function processFile(eng: BrainEngine, filePath: string) {
    const relativePath = relative(importDir, filePath);
    try {
      const result = await importFile(eng, filePath, relativePath, { noEmbed });
      if (result.status === 'imported') {
        imported++;
        chunksCreated += result.chunks;
        importedSlugs.push(result.slug);
      } else {
        skipped++;
        if (result.error && result.error !== 'unchanged') {
          const errorKey = result.error.replace(/"[^"]*"/g, '""');
          errorCounts[errorKey] = (errorCounts[errorKey] || 0) + 1;
          errors++;
          console.error(`  Skipped ${relativePath}: ${result.error}`);
        }
      }
      markCompletedPath(completedPaths, relativePath, result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const errorKey = msg.replace(/"[^"]*"/g, '""');
      errorCounts[errorKey] = (errorCounts[errorKey] || 0) + 1;
      if (errorCounts[errorKey] <= 5) {
        console.error(`  Warning: skipped ${relativePath}: ${msg}`);
      } else if (errorCounts[errorKey] === 6) {
        console.error(`  (suppressing further "${errorKey.slice(0, 60)}..." errors)`);
      }
      errors++;
      skipped++;
    }
    processed++;
    if (processed % 100 === 0 || processed === files.length) {
      logProgress();
      // Save checkpoint every 100 files — track completed file set, not just a counter
      if (processed % 100 === 0) {
        saveCheckpoint(checkpointPath, {
          dir: importDir,
          completedPaths: [...completedPaths],
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  if (actualWorkers > 1) {
    // Parallel: create per-worker engine instances with small pool
    // PGLite is single-connection, so parallel workers are only for Postgres
    const config = loadConfig();
    if (config?.engine === 'pglite') {
      // PGLite: sequential import through single engine
      for (const file of files) {
        await processFile(engine, file);
      }
    } else {
    const { PostgresEngine } = await import('../core/postgres-engine.ts');
    const workerEngines = await Promise.all(
      Array.from({ length: actualWorkers }, async () => {
        const eng = new PostgresEngine();
        await eng.connect({ database_url: config!.database_url!, poolSize: 2 });
        return eng;
      })
    );

    // Thread-safe queue: use an atomic index counter instead of array.shift()
    let queueIndex = 0;
    await Promise.all(workerEngines.map(async (eng) => {
      while (true) {
        const idx = queueIndex++;
        if (idx >= files.length) break;
        await processFile(eng, files[idx]!);
      }
    }));

    await Promise.all(workerEngines.map(e => e.disconnect()));
    } // end else (postgres parallel)
  } else {
    // Sequential: use the provided engine
    for (const filePath of files) {
      await processFile(engine, filePath);
    }
  }

  // Error summary
  for (const [err, count] of Object.entries(errorCounts)) {
    if (count > 5) {
      console.error(`  ${count} files failed: ${err.slice(0, 100)}`);
    }
  }

  // Clear checkpoint only on successful completion (no errors)
  if (errors === 0) {
    clearCheckpoint(checkpointPath);
  } else if (errors > 0) {
    saveCheckpoint(checkpointPath, {
      dir: importDir,
      completedPaths: [...completedPaths],
      timestamp: new Date().toISOString(),
    });
    console.log(`  Checkpoint preserved (${errors} errors). Run again to retry failed files.`);
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  if (jsonOutput) {
    console.log(JSON.stringify({
      status: 'success', duration_s: parseFloat(totalTime),
      imported, skipped, errors, chunks: chunksCreated,
      total_files: allFiles.length,
    }));
  } else {
    console.log(`\nImport complete (${totalTime}s):`);
    console.log(`  ${imported} pages imported`);
    console.log(`  ${skipped} pages skipped (${skipped - errors} unchanged, ${errors} errors)`);
    console.log(`  ${chunksCreated} chunks created`);
  }

  // Log the ingest
  await engine.logIngest({
    source_type: 'directory',
    source_ref: dir,
    pages_updated: importedSlugs,
    summary: `Imported ${imported} pages, ${skipped} skipped, ${chunksCreated} chunks`,
  });

  // Import → sync continuity: write sync checkpoint if this is a git repo
  try {
    if (errors === 0 && existsSync(join(importDir, '.git'))) {
      const head = execFileSync('git', ['-C', importDir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
      await engine.setConfig('sync.last_commit', head);
      await engine.setConfig('sync.last_run', new Date().toISOString());
      await engine.setConfig('sync.repo_path', importDir);
    } else if (errors > 0 && existsSync(join(importDir, '.git'))) {
      console.log(`  Git sync checkpoint not advanced because ${errors} import error(s) must be fixed or re-imported first.`);
    }
  } catch {
    // Not a git repo or git not available, skip checkpoint
  }
}

export interface CollectMarkdownOptions {
  excludeDirs?: string[];
  skipGbrainSlugged?: boolean;
}

function hasGbrainSlugFrontmatter(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, 'utf-8');
    if (!content.startsWith('---')) return false;
    const end = content.indexOf('\n---', 3);
    if (end < 0) return false;
    return /^gbrain_slug\s*:/m.test(content.slice(3, end));
  } catch {
    return false;
  }
}

export function collectMarkdownFiles(dir: string, opts: CollectMarkdownOptions = {}): string[] {
  const files: string[] = [];
  const root = dir;
  const excluded = new Set(
    (opts.excludeDirs || []).map(value => value.replace(/^\.\//, '').replace(/\/$/, '')),
  );

  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      // Skip hidden dirs and .raw dirs
      if (entry.startsWith('.')) continue;
      // Skip node_modules
      if (entry === 'node_modules') continue;

      const full = join(d, entry);
      let stat;
      try {
        // lstatSync, not statSync: we must NOT follow symlinks. A symlink
        // inside the brain directory can point to any file the importing
        // user can read, so a contributor to a shared brain could plant
        // notes/innocent.md as a symlink to ~/.gbrain/config.json, /etc/passwd,
        // or another sensitive file outside the brain root — and on the
        // next `gbrain import` it would be read, chunked, embedded, and
        // indexed, at which point a bearer-token holder could exfiltrate
        // it via search/get_page. See L002 in report/findings.md.
        stat = lstatSync(full);
      } catch {
        // Broken symlink or permission error — skip
        console.warn(`[gbrain import] Skipping unreadable path: ${full}`);
        continue;
      }

      // Skip symlinks (both file and directory targets). This also blocks
      // circular symlink DoS since we refuse to descend into linked dirs.
      if (stat.isSymbolicLink()) {
        console.warn(`[gbrain import] Skipping symlink: ${full}`);
        continue;
      }

      if (stat.isDirectory()) {
        const relDir = relative(root, full).replace(/\\/g, '/');
        if ([...excluded].some(prefix => relDir === prefix || relDir.startsWith(`${prefix}/`))) continue;
        walk(full);
      } else if (entry.endsWith('.md') || entry.endsWith('.mdx')) {
        if (opts.skipGbrainSlugged && hasGbrainSlugFrontmatter(full)) continue;
        files.push(full);
      }
    }
  }

  walk(dir);
  return files.sort();
}
