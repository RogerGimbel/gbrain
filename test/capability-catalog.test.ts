import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildCapabilityCatalog, renderCapabilityCatalogMarkdown, writeCapabilityCatalog } from '../src/core/capability-catalog.ts';

function root(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-cap-catalog-'));
}

function skill(dir: string, name: string, description: string) {
  const p = join(dir, name);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`);
}

describe('capability catalog', () => {
  test('builds a catalog from agent skill directories and skillpack manifests', () => {
    const r = root();
    const hermes = join(r, 'hermes-skills');
    const winston = join(r, 'winston-skills');
    skill(hermes, 'browser-and-webapp-smoke-testing', 'Browser and Playwright smoke tests');
    skill(hermes, 'google-workspace', 'Google Workspace operations');
    skill(winston, 'webapp-dev-stack', 'Vercel, Next.js, Supabase, Impeccable');
    const manifest = join(r, 'manifest.json');
    writeFileSync(manifest, JSON.stringify({ name: 'webapp-dev', skills: [{ name: 'supabase' }, { name: 'next-best-practices' }] }));

    const catalog = buildCapabilityCatalog({
      agents: [
        { name: 'Hermes', skillsDir: hermes },
        { name: 'Winston', skillsDir: winston },
      ],
      skillpackManifests: [manifest],
    });

    expect(catalog.agents).toHaveLength(2);
    expect(catalog.agents[0].skill_count).toBe(2);
    expect(catalog.skillpacks[0].name).toBe('webapp-dev');
    expect(catalog.routes.find(r => r.id === 'webapp-dev')?.agents).toContain('Winston');
    expect(catalog.routes.find(r => r.id === 'browser-smoke')?.agents).toContain('Hermes');
  });

  test('renders and writes markdown/json catalog artifacts', () => {
    const r = root();
    const skills = join(r, 'skills');
    skill(skills, 'fleet-checkpoint', 'Durable checkpoint lane');
    const catalog = buildCapabilityCatalog({ agents: [{ name: 'Hermes', skillsDir: skills }] });
    const markdown = renderCapabilityCatalogMarkdown(catalog);
    expect(markdown).toContain('Fleet Capability Catalog');
    expect(markdown).toContain('checkpoint');

    const out = writeCapabilityCatalog(catalog, join(r, 'out'));
    expect(existsSync(out.json)).toBe(true);
    expect(existsSync(out.markdown)).toBe(true);
    expect(JSON.parse(readFileSync(out.json, 'utf8')).schema_version).toBe(1);
  });
});
