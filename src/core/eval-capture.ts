import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type { BrainEngine } from './engine.ts';
import type { SearchResult } from './types.ts';
import { hybridSearch } from './search/hybrid.ts';
import { scrubEvalCaptureValue } from './eval-capture-scrub.ts';

export type EvalCaptureMode = 'hybridNoExpand' | 'hybridExpand' | 'keyword';

export interface EvalCaptureResultSnapshot {
  rank: number;
  slug: string;
  title: string;
  type: string;
  score: number | null;
  excerpt: string;
}

export interface EvalCaptureCase {
  query: string;
  expectedSlug?: string;
  mode?: EvalCaptureMode;
  intent?: string;
  topResults: EvalCaptureResultSnapshot[];
}

export interface EvalCaptureFile {
  schema_version: 1;
  generated_at: string;
  git?: { branch?: string; head?: string };
  cases: EvalCaptureCase[];
}

export interface BuildEvalCaptureInput {
  generatedAt?: string;
  git?: { branch?: string; head?: string };
  cases: Array<{
    query: string;
    expectedSlug?: string;
    mode?: EvalCaptureMode;
    intent?: string;
    topResults: SearchResult[] | EvalCaptureResultSnapshot[];
  }>;
}

export interface EvalReplayCaseResult {
  query: string;
  expectedSlug: string | null;
  actualTopSlug: string | null;
  passed: boolean;
}

export interface EvalReplaySummary {
  total: number;
  passed: number;
  failed: number;
  cases: EvalReplayCaseResult[];
}

export function buildEvalCaptureFile(input: BuildEvalCaptureInput): EvalCaptureFile {
  const capture: EvalCaptureFile = {
    schema_version: 1,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    ...(input.git ? { git: input.git } : {}),
    cases: input.cases.map((testCase) => ({
      query: testCase.query,
      ...(testCase.expectedSlug ? { expectedSlug: testCase.expectedSlug } : {}),
      ...(testCase.mode ? { mode: testCase.mode } : {}),
      ...(testCase.intent ? { intent: testCase.intent } : {}),
      topResults: testCase.topResults.map((result, idx) => normalizeResultSnapshot(result, idx)),
    })),
  };
  return scrubEvalCaptureValue(capture) as EvalCaptureFile;
}

export function writeEvalCaptureFile(path: string, capture: EvalCaptureFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(capture, null, 2));
}

export function loadEvalCaptureFile(path: string): EvalCaptureFile {
  if (!existsSync(path)) throw new Error(`Eval capture file not found: ${path}`);
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as EvalCaptureFile;
  if (parsed.schema_version !== 1 || !Array.isArray(parsed.cases)) {
    throw new Error(`Invalid eval capture file: ${path}`);
  }
  return parsed;
}

export async function replayEvalCapture(
  engine: BrainEngine,
  capture: EvalCaptureFile,
  opts: { limit?: number } = {},
): Promise<EvalReplaySummary> {
  const limit = opts.limit ?? 10;
  const cases: EvalReplayCaseResult[] = [];

  for (const testCase of capture.cases) {
    const expectedSlug = testCase.expectedSlug ?? testCase.topResults[0]?.slug ?? null;
    const results = await searchForMode(engine, testCase.query, testCase.mode ?? 'hybridNoExpand', limit);
    const actualTopSlug = results[0]?.slug ?? null;
    cases.push({
      query: testCase.query,
      expectedSlug,
      actualTopSlug,
      passed: expectedSlug !== null && actualTopSlug === expectedSlug,
    });
  }

  const passed = cases.filter(c => c.passed).length;
  return { total: cases.length, passed, failed: cases.length - passed, cases };
}

async function searchForMode(
  engine: BrainEngine,
  query: string,
  mode: EvalCaptureMode,
  limit: number,
): Promise<SearchResult[]> {
  if (mode === 'keyword') return engine.searchKeyword(query, { limit });
  return hybridSearch(engine, query, { limit, expansion: mode === 'hybridExpand' });
}

function normalizeResultSnapshot(result: SearchResult | EvalCaptureResultSnapshot, idx: number): EvalCaptureResultSnapshot {
  const maybe = result as Partial<EvalCaptureResultSnapshot & SearchResult>;
  return {
    rank: maybe.rank ?? idx + 1,
    slug: maybe.slug ?? '',
    title: maybe.title ?? maybe.slug ?? '',
    type: maybe.type ?? 'unknown',
    score: typeof maybe.score === 'number' && Number.isFinite(maybe.score) ? Number(maybe.score.toFixed(6)) : null,
    excerpt: (maybe.excerpt ?? maybe.chunk_text ?? '').replace(/\s+/g, ' ').slice(0, 240),
  };
}
