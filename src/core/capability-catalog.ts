import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface AgentSkillSource {
  name: string;
  skillsDir: string;
}

export interface CapabilityCatalogInput {
  agents: AgentSkillSource[];
  skillpackManifests?: string[];
}

export interface CatalogSkill {
  name: string;
  description?: string;
  path: string;
}

export interface CatalogAgent {
  name: string;
  skills_dir: string;
  skill_count: number;
  skills: CatalogSkill[];
}

export interface CatalogSkillpack {
  name: string;
  path: string;
  skill_count: number;
  skills: string[];
}

export interface CatalogRoute {
  id: string;
  description: string;
  agents: string[];
  matched_skills: string[];
}

export interface CapabilityCatalog {
  schema_version: 1;
  generated_at: string;
  agents: CatalogAgent[];
  skillpacks: CatalogSkillpack[];
  routes: CatalogRoute[];
}

const ROUTE_RULES = [
  { id: 'webapp-dev', description: 'Vercel/Next/React/Supabase/Impeccable webapp development', terms: ['webapp', 'vercel', 'next', 'react', 'supabase', 'impeccable'] },
  { id: 'browser-smoke', description: 'Browser and Playwright smoke testing', terms: ['browser', 'playwright', 'smoke'] },
  { id: 'checkpoint', description: 'Durable fleet checkpoint/resume lane', terms: ['checkpoint', 'fleet-checkpoint'] },
  { id: 'resource-boundary', description: 'Personal resource ownership and safety boundary', terms: ['resource-boundary', 'google-workspace', 'email', 'calendar'] },
  { id: 'gbrain', description: 'GBrain/Obsidian/QMD knowledge sidecar operations', terms: ['gbrain', 'obsidian', 'qmd'] },
];

export function buildCapabilityCatalog(input: CapabilityCatalogInput): CapabilityCatalog {
  const agents = input.agents.map(agent => {
    const skills = readSkills(agent.skillsDir);
    return {
      name: agent.name,
      skills_dir: agent.skillsDir,
      skill_count: skills.length,
      skills,
    };
  });
  const skillpacks = (input.skillpackManifests ?? []).map(readSkillpackManifest);
  const routes = buildRoutes(agents, skillpacks);
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    agents,
    skillpacks,
    routes,
  };
}

export function renderCapabilityCatalogMarkdown(catalog: CapabilityCatalog): string {
  const lines = [
    '---',
    'title: Fleet Capability Catalog',
    'type: capability-catalog',
    'source_agent: GBrain',
    'source_origin: capability-catalog',
    `source_updated_at: ${catalog.generated_at}`,
    'confidence: high',
    '---',
    '',
    '# Fleet Capability Catalog',
    '',
    `Generated: ${catalog.generated_at}`,
    '',
    '## Agents',
    '',
  ];
  for (const agent of catalog.agents) {
    lines.push(`- ${agent.name}: ${agent.skill_count} skill(s) from \`${agent.skills_dir}\``);
  }
  lines.push('', '## Skillpacks', '');
  if (catalog.skillpacks.length === 0) lines.push('- none configured');
  for (const pack of catalog.skillpacks) {
    lines.push(`- ${pack.name}: ${pack.skill_count} skill(s) from \`${pack.path}\``);
  }
  lines.push('', '## Routes', '');
  for (const route of catalog.routes) {
    lines.push(`- ${route.id}: ${route.description}`);
    lines.push(`  - agents: ${route.agents.length ? route.agents.join(', ') : 'none'}`);
    lines.push(`  - matched skills: ${route.matched_skills.length ? route.matched_skills.join(', ') : 'none'}`);
  }
  return lines.join('\n') + '\n';
}

export function writeCapabilityCatalog(catalog: CapabilityCatalog, outputDir: string): { json: string; markdown: string } {
  mkdirSync(outputDir, { recursive: true });
  const jsonPath = join(outputDir, 'fleet-capability-catalog.json');
  const mdPath = join(outputDir, 'fleet-capability-catalog.md');
  writeFileSync(jsonPath, JSON.stringify(catalog, null, 2), 'utf8');
  writeFileSync(mdPath, renderCapabilityCatalogMarkdown(catalog), 'utf8');
  return { json: jsonPath, markdown: mdPath };
}

function readSkills(skillsDir: string): CatalogSkill[] {
  if (!existsSync(skillsDir)) return [];
  const out: CatalogSkill[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.git') continue;
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (entry === 'SKILL.md') {
        const content = readFileSync(full, 'utf8');
        const fm = parseFrontmatter(content);
        out.push({
          name: fm.name ?? inferSkillName(full, skillsDir),
          description: fm.description,
          path: full,
        });
      }
    }
  };
  walk(skillsDir);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function readSkillpackManifest(path: string): CatalogSkillpack {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const skills = Array.isArray(raw.skills)
    ? raw.skills.map((s: any) => typeof s === 'string' ? s : s.name).filter(Boolean)
    : [];
  return {
    name: raw.name ?? raw.id ?? 'unknown-skillpack',
    path,
    skill_count: skills.length,
    skills,
  };
}

function buildRoutes(agents: CatalogAgent[], skillpacks: CatalogSkillpack[]): CatalogRoute[] {
  const allPackSkills = skillpacks.flatMap(p => p.skills.map(s => ({ agent: `skillpack:${p.name}`, name: s, description: '' })));
  return ROUTE_RULES.map(rule => {
    const matched: string[] = [];
    const routeAgents = new Set<string>();
    for (const agent of agents) {
      for (const skill of agent.skills) {
        if (matchesRule(skill, rule.terms)) {
          matched.push(`${agent.name}/${skill.name}`);
          routeAgents.add(agent.name);
        }
      }
    }
    for (const skill of allPackSkills) {
      if (rule.terms.some(term => skill.name.toLowerCase().includes(term))) {
        matched.push(`${skill.agent}/${skill.name}`);
      }
    }
    return { id: rule.id, description: rule.description, agents: Array.from(routeAgents).sort(), matched_skills: matched.sort() };
  });
}

function matchesRule(skill: CatalogSkill, terms: string[]): boolean {
  const hay = `${skill.name} ${skill.description ?? ''}`.toLowerCase();
  return terms.some(term => hay.includes(term));
}

function parseFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith('---\n')) return {};
  const end = content.indexOf('\n---', 4);
  if (end === -1) return {};
  const result: Record<string, string> = {};
  for (const line of content.slice(4, end).split('\n')) {
    const match = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!match) continue;
    result[match[1]!] = match[2]!.trim().replace(/^['"]|['"]$/g, '');
  }
  return result;
}

function inferSkillName(skillPath: string, root: string): string {
  return skillPath.replace(root, '').split('/').filter(Boolean).slice(-2, -1)[0] ?? 'unknown';
}
