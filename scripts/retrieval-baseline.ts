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
  summarizeRetrievalSuite,
  buildReplayableRetrievalBaselineCapture,
} from '../src/core/search/retrieval-baseline.ts';
import { writeEvalCaptureFile } from '../src/core/eval-capture.ts';

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx >= 0) return process.argv[idx + 1];
  const prefix = `${name}=`;
  const hit = process.argv.find(arg => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
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
  const outDir = argValue('--out-dir') ?? join(gbrainPath('reports'), 'retrieval-baseline');
  const stamp = isoStamp();

  const config = loadConfig();
  if (!config) throw new Error('No GBrain config found. Run from an environment with ~/.gbrain/config.json or GBRAIN_DATABASE_URL.');

  const engine = await createEngine(toEngineConfig(config));
  await engine.connect(toEngineConfig(config));

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

    const summary = summarizeRetrievalSuite(cases);
    const generatedAt = new Date().toISOString();
    const git = {
      head: process.env.GBRAIN_BASELINE_GIT_HEAD ?? null,
      branch: process.env.GBRAIN_BASELINE_GIT_BRANCH ?? null,
    };
    const payload = {
      generatedAt,
      git,
      limit,
      stats,
      health,
      expectedPageChecks,
      summary,
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
    const jsonPath = join(outDir, `retrieval-baseline-${stamp}.json`);
    const mdPath = join(outDir, `retrieval-baseline-${stamp}.md`);
    const replayPath = join(outDir, `retrieval-baseline-replay-${stamp}.json`);

    writeFileSync(jsonPath, JSON.stringify(payload, null, 2) + '\n');
    writeEvalCaptureFile(replayPath, buildReplayableRetrievalBaselineCapture(cases, {
      generatedAt,
      git: {
        head: git.head ?? undefined,
        branch: git.branch ?? undefined,
      },
    }));

    const md = [
      `# GBrain retrieval baseline — ${payload.generatedAt}`,
      '',
      `- Git branch: ${payload.git.branch ?? '(not supplied)'}`,
      `- Git head: ${payload.git.head ?? '(not supplied)'}`,
      `- Limit per mode: ${limit}`,
      `- Replay capture: ${replayPath}`,
      `- Pages: ${stats.page_count}`,
      `- Chunks: ${stats.chunk_count}`,
      `- Embedded: ${stats.embedded_count}`,
      `- Links: ${stats.link_count}`,
      `- Brain score: ${health.brain_score}`,
      `- Orphans: ${health.orphan_pages}`,
      `- Dead links: ${health.dead_links}`,
      '',
      '## Summary',
      '',
      `- Hybrid no-expand: top1 ${summary.hybridNoExpand.top1}/${summary.hybridNoExpand.total}; top3 ${summary.hybridNoExpand.top3}/${summary.hybridNoExpand.total}; top10 ${summary.hybridNoExpand.top10}/${summary.hybridNoExpand.total}; missing ${summary.hybridNoExpand.missing}`,
      `- Hybrid expand: top1 ${summary.hybridExpand.top1}/${summary.hybridExpand.total}; top3 ${summary.hybridExpand.top3}/${summary.hybridExpand.total}; top10 ${summary.hybridExpand.top10}/${summary.hybridExpand.total}; missing ${summary.hybridExpand.missing}`,
      `- Keyword: top1 ${summary.keyword.top1}/${summary.keyword.total}; top3 ${summary.keyword.top3}/${summary.keyword.total}; top10 ${summary.keyword.top10}/${summary.keyword.total}; missing ${summary.keyword.missing}`,
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
      ok: true,
      jsonPath,
      mdPath,
      replayPath,
      summary,
      health,
      expectedMissing: expectedPageChecks.filter(check => !check.exists),
    }, null, 2));
  } finally {
    await engine.disconnect();
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
