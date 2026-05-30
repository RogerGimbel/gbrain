import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { suggestRoute, renderRouteSuggestionMarkdown } from '../src/core/route-suggest.ts';
import type { CapabilityCatalog } from '../src/core/capability-catalog.ts';

function catalog(): CapabilityCatalog {
  return {
    schema_version: 1,
    generated_at: '2026-05-30T12:00:00Z',
    agents: [
      { name: 'Hermes', skills_dir: '/skills/hermes', skill_count: 2, skills: [
        { name: 'gbrain-operations', description: 'Operate GBrain Obsidian QMD knowledge sidecar safely', path: '/skills/hermes/gbrain/SKILL.md' },
        { name: 'google-workspace', description: 'Gmail Calendar Drive account operations', path: '/skills/hermes/google/SKILL.md' },
      ] },
      { name: 'Argos', skills_dir: '/skills/argos', skill_count: 1, skills: [
        { name: 'browser-smoke', description: 'Playwright browser smoke testing', path: '/skills/argos/browser/SKILL.md' },
      ] },
    ],
    skillpacks: [],
    routes: [
      { id: 'gbrain', description: 'GBrain/Obsidian/QMD knowledge sidecar operations', agents: ['Hermes'], matched_skills: ['Hermes/gbrain-operations'] },
      { id: 'browser-smoke', description: 'Browser and Playwright smoke testing', agents: ['Argos'], matched_skills: ['Argos/browser-smoke'] },
      { id: 'resource-boundary', description: 'Personal resource ownership and safety boundary', agents: ['Hermes'], matched_skills: ['Hermes/google-workspace'] },
    ],
  };
}

describe('route suggestions', () => {
  test('suggests agent, route group, skills, pages, and safety notes from capability catalog', () => {
    const result = suggestRoute({ catalog: catalog(), request: 'Audit GBrain source health and Obsidian checkpoints' });

    expect(result.suggested_agent).toBe('Hermes');
    expect(result.route_group).toBe('gbrain');
    expect(result.skills).toContain('gbrain-operations');
    expect(result.relevant_pages).toContain('knowledge/agent-fleet/gbrain-fleet-usefulness-v2-controlled-promotion-canary-intelligence-2026-05-30');
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.sideEffects).toEqual({ taskExecutions: 0, liveDbWrites: 0 });
  });

  test('adds resource-boundary safety note for personal Google/email/calendar requests', () => {
    const result = suggestRoute({ catalog: catalog(), request: 'Check Dale email and calendar' });

    expect(result.route_group).toBe('resource-boundary');
    expect(result.safety_notes.join('\n')).toMatch(/owner-owned connector/i);
  });

  test('renders markdown and optionally writes output', () => {
    const output = mkdtempSync(join(tmpdir(), 'gbrain-route-suggest-'));
    const result = suggestRoute({ catalog: catalog(), request: 'Run Playwright browser smoke tests', outputRoot: output });
    const markdown = renderRouteSuggestionMarkdown(result);

    expect(result.suggested_agent).toBe('Argos');
    expect(markdown).toContain('# Route Suggestion');
    expect(readFileSync(join(output, 'route-suggestion.md'), 'utf8')).toContain('Argos');
  });
});
