import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  assertSafeSynthesisRoot,
  buildProactiveSynthesis,
  renderProactiveSynthesisMarkdown,
  writeProactiveSynthesisSandbox,
} from '../src/core/proactive-synthesis.ts';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'gbrain-synthesis-')); }
function json(path: string, value: unknown) { writeFileSync(path, JSON.stringify(value, null, 2), 'utf8'); return path; }

describe('proactive synthesis sandbox', () => {
  test('builds a deterministic fleet brief from source/capability/orphan/retrieval artifacts', () => {
    const root = tmp();
    const source = json(join(root, 'source.json'), { summary: { total_files: 10, source_covered: 6, missing_source_metadata: 4, stale_sources: 1 } });
    const capability = json(join(root, 'capability.json'), { catalog: { agents: [{ name: 'Hermes' }, { name: 'Argos' }], routes: [{ id: 'webapp-dev', agents: ['Hermes', 'Argos'] }] } });
    const orphan = json(join(root, 'orphan.json'), { report: { summary: { orphan_pages: 34, total_pages: 1035, groups: 8 } } });
    const retrieval = json(join(root, 'retrieval.json'), { result: { ok: true, metrics: { protected_top1_passed: 13, protected_top1_total: 13, mean_mrr_delta: 0 } } });

    const synthesis = buildProactiveSynthesis({ sourceHealth: source, capabilityCatalog: capability, orphanReport: orphan, retrievalExperiment: retrieval });

    expect(synthesis.status).toBe('sandbox-only');
    expect(synthesis.highlights).toContain('Retrieval gate passed: protected top1 13/13, MRR delta 0.');
    expect(synthesis.follow_ups.some(f => f.includes('4 file(s) missing source metadata'))).toBe(true);
    expect(synthesis.side_effects).toEqual({ llmCalls: 0, liveDbWrites: 0, canonicalVaultWrites: 0, liveSync: 0 });
  });

  test('writes staged markdown/json only under sandbox root', () => {
    const root = tmp();
    const retrieval = json(join(root, 'retrieval.json'), { result: { ok: true, metrics: { protected_top1_passed: 1, protected_top1_total: 1, mean_mrr_delta: 0 } } });
    const synthesis = buildProactiveSynthesis({ retrievalExperiment: retrieval });
    const markdown = renderProactiveSynthesisMarkdown(synthesis);
    expect(markdown).toContain('Promotion checklist');
    const files = writeProactiveSynthesisSandbox(synthesis, join(root, 'out'));
    expect(existsSync(files.json)).toBe(true);
    expect(existsSync(files.markdown)).toBe(true);
    expect(readFileSync(files.markdown, 'utf8')).toContain('sandbox-only');
  });

  test('refuses canonical Obsidian output roots', () => {
    const canonical = '/Users/rogergimbel/Knowledge/Winston';
    expect(() => assertSafeSynthesisRoot(canonical, canonical)).toThrow(/canonical Obsidian/i);
    expect(() => assertSafeSynthesisRoot(join(canonical, 'reports'), canonical)).toThrow(/canonical Obsidian/i);
  });
});
