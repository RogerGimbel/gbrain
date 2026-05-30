import { existsSync, readFileSync } from 'fs';
import type { EvalCaptureFile } from '../eval-capture.ts';

export interface QrelsEntry {
  query: string;
  expectedSlugs: string[];
}

export interface QrelsFile {
  schema_version: 1;
  qrels: QrelsEntry[];
}

export function buildQrelsFromCapture(capture: EvalCaptureFile): QrelsFile {
  return {
    schema_version: 1,
    qrels: capture.cases.map((testCase) => ({
      query: testCase.query,
      expectedSlugs: [testCase.expectedSlug ?? testCase.topResults[0]?.slug].filter((slug): slug is string => Boolean(slug)),
    })),
  };
}

export function loadQrelsFile(path: string): QrelsFile {
  if (!existsSync(path)) throw new Error(`Qrels file not found: ${path}`);
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<QrelsFile>;
  if (parsed.schema_version !== 1 || !Array.isArray(parsed.qrels)) {
    throw new Error(`Invalid qrels file: ${path}`);
  }
  return {
    schema_version: 1,
    qrels: parsed.qrels.map((entry) => ({
      query: String(entry.query),
      expectedSlugs: Array.isArray(entry.expectedSlugs) ? entry.expectedSlugs.map(String) : [],
    })),
  };
}
