#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createEngine } from '../src/core/engine-factory.ts';
import { loadConfig, toEngineConfig, gbrainPath } from '../src/core/config.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import { expandQuery } from '../src/core/search/expansion.ts';
import {
  CANONICAL_RETRIEVAL_CASES,
  summarizeRetrievalCase,
} from '../src/core/search/retrieval-baseline.ts';
import {
  evaluateGoldenMemoryGate,
  formatGoldenMemoryFailures,
} from '../src/core/search/golden-memory-gate.ts';

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx >= 0) return process.argv[idx + 1];
  const prefix = `${name}=`;
  const hit = process.argv.find(arg => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function mdEscape(value: string) {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function modeMarkdown(label: string, mode: any) {
  const lines = [
    `- ${label}:`,
    `  - top slug: ${mode.topSlug ?? '(none)'}`,
    `  - expected rank: ${mode.expectedRank ?? 'not in top 10'}`,
    `  - expected top 1/3/10: ${mode.expectedTop1 ? 'yes' : 'no'} / ${mode.expectedTop3 ? 'yes' : 'no'} / ${mode.expectedTop10 ? 'yes' : 'no'}`,
    `  - top 10:`,
  ];
  for (const result of mode.results) {
    lines.push(`    - ${result.rank}. ${mdEscape(result.slug)} (${result.score ?? '?'}) — ${mdEscape(result.title || '')}`);
  }
  return lines.join('\n');
}

async function main() {
  const limit = Number(argValue('--limit') ?? 10);
  const outDir = argValue('--out-dir') ?? join(gbrainPath('reports'), 'golden-memory-gate');
  const noFail = hasFlag('--no-fail');
  const stamp = isoStamp();

  const config = loadConfig();
  if (!config) throw new Error('No GBrain config found. Run from an environment with ~/.gbrain/config.json or GBRAIN_DATABASE_URL.');

  const engineConfig = toEngineConfig(config);
  const engine = await createEngine(engineConfig);
  await engine.connect(engineConfig);

  try {
    const [stats, health, ingestLog] = await Promise.all([
      engine.getStats(),
      engine.getHealth(),
      engine.getIngestLog({ limit: 10 }),
    ]);

    const cases = [];
    const expectedPageChecks = [];

    for (const retrievalCase of CANONICAL_RETRIEVAL_CASES) {
      const expectedPage = await engine.getPage(retrievalCase.expectedSlug);
      expectedPageChecks.push({
        query: retrievalCase.query,
        expectedSlug: retrievalCase.expectedSlug,
        exists: Boolean(expectedPage),
        title: expectedPage?.title ?? null,
        type: expectedPage?.type ?? null,
      });

      const [hybridNoExpand, hybridExpand, keywordRaw] = await Promise.all([
        hybridSearch(engine, retrievalCase.query, { limit, expansion: false, detail: 'medium' }),
        hybridSearch(engine, retrievalCase.query, { limit, expansion: true, expandFn: expandQuery, detail: 'medium' }),
        engine.searchKeyword(retrievalCase.query, { limit, detail: 'medium' }),
      ]);

      cases.push(summarizeRetrievalCase(
        retrievalCase,
        { hybridNoExpand, hybridExpand, keyword: keywordRaw },
        limit,
      ));
    }

    const gate = evaluateGoldenMemoryGate({ cases, expectedPageChecks, health });
    const payload = {
      generatedAt: new Date().toISOString(),
      git: {
        head: process.env.GBRAIN_BASELINE_GIT_HEAD ?? null,
        branch: process.env.GBRAIN_BASELINE_GIT_BRANCH ?? null,
      },
      limit,
      ok: gate.ok,
      failures: gate.failures,
      thresholds: gate.thresholds,
      stats,
      health,
      expectedPageChecks,
      summary: gate.summary,
      cases,
      ingestLog: ingestLog.map(entry => ({
        id: entry.id,
        source_type: entry.source_type,
        source_ref: entry.source_ref,
        pages_updated: entry.pages_updated,
        summary: entry.summary,
        created_at: entry.created_at,
      })),
    };

    mkdirSync(outDir, { recursive: true });
    const jsonPath = join(outDir, `golden-memory-gate-${stamp}.json`);
    const mdPath = join(outDir, `golden-memory-gate-${stamp}.md`);

    writeFileSync(jsonPath, JSON.stringify(payload, null, 2) + '\n');

    const md = [
      `# GBrain golden memory upgrade gate — ${payload.generatedAt}`,
      '',
      `- Gate: ${gate.ok ? 'PASS' : 'FAIL'}`,
      `- Git branch: ${payload.git.branch ?? '(not supplied)'}`,
      `- Git head: ${payload.git.head ?? '(not supplied)'}`,
      `- Limit per mode: ${limit}`,
      `- Pages: ${stats.page_count}`,
      `- Chunks: ${stats.chunk_count}`,
      `- Embedded: ${stats.embedded_count}`,
      `- Links: ${stats.link_count}`,
      `- Brain score: ${health.brain_score}`,
      `- Orphans: ${health.orphan_pages}`,
      `- Dead links: ${health.dead_links}`,
      `- Missing embeddings: ${health.missing_embeddings}`,
      '',
      '## Gate thresholds',
      '',
      `- Hybrid no-expand expected slug must be top1: ${gate.thresholds.requireHybridNoExpandTop1 ? 'yes' : 'no'}`,
      `- Hybrid expand expected slug must be top1: ${gate.thresholds.requireHybridExpandTop1 ? 'yes' : 'no'}`,
      `- Max missing embeddings: ${gate.thresholds.maxMissingEmbeddings}`,
      `- Max dead links: ${gate.thresholds.maxDeadLinks}`,
      `- Max stale pages: ${gate.thresholds.maxStalePages}`,
      `- Min embedding coverage: ${gate.thresholds.minEmbedCoverage}`,
      `- Min brain score: ${gate.thresholds.minBrainScore}`,
      '',
      '## Failures',
      '',
      gate.failures.length ? gate.failures.map(failure => `- ${failure}`).join('\n') : '- none',
      '',
      '## Summary',
      '',
      `- Hybrid no-expand: top1 ${gate.summary.hybridNoExpand.top1}/${gate.summary.hybridNoExpand.total}; top3 ${gate.summary.hybridNoExpand.top3}/${gate.summary.hybridNoExpand.total}; top10 ${gate.summary.hybridNoExpand.top10}/${gate.summary.hybridNoExpand.total}; missing ${gate.summary.hybridNoExpand.missing}`,
      `- Hybrid expand: top1 ${gate.summary.hybridExpand.top1}/${gate.summary.hybridExpand.total}; top3 ${gate.summary.hybridExpand.top3}/${gate.summary.hybridExpand.total}; top10 ${gate.summary.hybridExpand.top10}/${gate.summary.hybridExpand.total}; missing ${gate.summary.hybridExpand.missing}`,
      `- Keyword: top1 ${gate.summary.keyword.top1}/${gate.summary.keyword.total}; top3 ${gate.summary.keyword.top3}/${gate.summary.keyword.total}; top10 ${gate.summary.keyword.top10}/${gate.summary.keyword.total}; missing ${gate.summary.keyword.missing}`,
      '',
      '## Expected page checks',
      '',
      ...expectedPageChecks.map(check => `- ${check.exists ? 'OK' : 'MISSING'}: ${check.query} -> ${check.expectedSlug}${check.title ? ` (${check.title})` : ''}`),
      '',
      '## Cases',
      '',
      ...cases.flatMap(testCase => [
        `### ${testCase.query}`,
        '',
        `- Expected slug: ${testCase.expectedSlug}`,
        testCase.notes ? `- Notes: ${testCase.notes}` : '',
        modeMarkdown('Hybrid no-expand', testCase.hybridNoExpand),
        modeMarkdown('Hybrid expand', testCase.hybridExpand),
        modeMarkdown('Keyword', testCase.keyword),
        '',
      ].filter(Boolean)),
    ].join('\n');

    writeFileSync(mdPath, md + '\n');

    console.log(JSON.stringify({
      ok: gate.ok,
      jsonPath,
      mdPath,
      summary: gate.summary,
      health,
      expectedMissing: expectedPageChecks.filter(check => !check.exists),
      failures: gate.failures,
    }, null, 2));

    if (!gate.ok && !noFail) {
      console.error(formatGoldenMemoryFailures(gate.failures));
      process.exit(1);
    }
  } finally {
    await engine.disconnect();
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
