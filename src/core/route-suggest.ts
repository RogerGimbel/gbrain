import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { CapabilityCatalog, CatalogRoute, CatalogSkill } from './capability-catalog.ts';

export interface RouteSuggestInput {
  catalog: CapabilityCatalog;
  request: string;
  outputRoot?: string;
  dryRun?: boolean;
}

export interface RouteSuggestion {
  generated_at: string;
  request: string;
  suggested_agent: string;
  route_group: string;
  confidence: number;
  skills: string[];
  relevant_pages: string[];
  safety_notes: string[];
  evidence: string[];
  sideEffects: {
    taskExecutions: 0;
    liveDbWrites: 0;
  };
}

const ROUTE_KEYWORDS: Record<string, string[]> = {
  gbrain: ['gbrain', 'obsidian', 'qmd', 'checkpoint', 'source health', 'knowledge'],
  'browser-smoke': ['browser', 'playwright', 'smoke', 'webapp', 'vercel'],
  'resource-boundary': ['email', 'calendar', 'gmail', 'drive', 'google', 'personal resource'],
  checkpoint: ['checkpoint', 'resume', 'receipt'],
};

export function suggestRoute(input: RouteSuggestInput): RouteSuggestion {
  const request = input.request.trim();
  if (!request) throw new Error('Route suggestion request cannot be empty');
  const scoredRoutes = input.catalog.routes.map(route => scoreRoute(route, request)).sort((a, b) => b.score - a.score);
  const best = scoredRoutes[0] ?? { route: undefined, score: 0, evidence: [] };
  const route = best.route;
  const agent = pickAgent(input.catalog, route, request);
  const skills = pickSkills(input.catalog, agent, route, request);
  const result: RouteSuggestion = {
    generated_at: new Date().toISOString(),
    request,
    suggested_agent: agent,
    route_group: route?.id ?? 'general',
    confidence: confidence(best.score, skills.length),
    skills: skills.map(s => s.name),
    relevant_pages: relevantPages(route?.id ?? 'general'),
    safety_notes: safetyNotes(route?.id ?? 'general', request),
    evidence: [
      ...best.evidence,
      ...(route ? [`matched route ${route.id}`] : ['no catalog route matched; used general fallback']),
      `selected agent ${agent}`,
      ...skills.map(s => `skill ${s.name}: ${s.description ?? 'no description'}`),
    ],
    sideEffects: { taskExecutions: 0, liveDbWrites: 0 },
  };
  if (input.outputRoot && !input.dryRun) {
    mkdirSync(input.outputRoot, { recursive: true });
    writeFileSync(join(input.outputRoot, 'route-suggestion.json'), JSON.stringify(result, null, 2), 'utf8');
    writeFileSync(join(input.outputRoot, 'route-suggestion.md'), renderRouteSuggestionMarkdown(result), 'utf8');
  }
  return result;
}

export function renderRouteSuggestionMarkdown(result: RouteSuggestion): string {
  return [
    '# Route Suggestion',
    '',
    `Request: ${result.request}`,
    '',
    `- suggested agent: ${result.suggested_agent}`,
    `- route group: ${result.route_group}`,
    `- confidence: ${result.confidence}`,
    `- task executions: ${result.sideEffects.taskExecutions}`,
    `- live DB writes: ${result.sideEffects.liveDbWrites}`,
    '',
    '## Skills',
    '',
    ...(result.skills.length ? result.skills.map(s => `- ${s}`) : ['- none']),
    '',
    '## Relevant pages',
    '',
    ...(result.relevant_pages.length ? result.relevant_pages.map(p => `- ${p}`) : ['- none']),
    '',
    '## Safety notes',
    '',
    ...(result.safety_notes.length ? result.safety_notes.map(n => `- ${n}`) : ['- none']),
    '',
    '## Evidence',
    '',
    ...result.evidence.map(e => `- ${e}`),
    '',
  ].join('\n');
}

function scoreRoute(route: CatalogRoute, request: string): { route: CatalogRoute; score: number; evidence: string[] } {
  const hay = request.toLowerCase();
  const terms = ROUTE_KEYWORDS[route.id] ?? route.id.split(/[-_]/g);
  let score = 0;
  const evidence: string[] = [];
  for (const term of terms) {
    if (hay.includes(term)) {
      score += term.includes(' ') ? 3 : 1;
      evidence.push(`request matched term ${term}`);
    }
  }
  for (const skill of route.matched_skills) {
    const name = skill.split('/').pop()!.toLowerCase();
    if (hay.includes(name)) {
      score += 2;
      evidence.push(`request matched skill ${name}`);
    }
  }
  return { route, score, evidence };
}

function pickAgent(catalog: CapabilityCatalog, route: CatalogRoute | undefined, request: string): string {
  if (route?.agents.length) return route.agents[0];
  const lower = request.toLowerCase();
  for (const agent of catalog.agents) if (lower.includes(agent.name.toLowerCase())) return agent.name;
  return catalog.agents[0]?.name ?? 'unknown';
}

function pickSkills(catalog: CapabilityCatalog, agentName: string, route: CatalogRoute | undefined, request: string): CatalogSkill[] {
  const agent = catalog.agents.find(a => a.name === agentName);
  if (!agent) return [];
  const routeSkillNames = new Set((route?.matched_skills ?? []).map(s => s.split('/').pop()));
  const lower = request.toLowerCase();
  const selected = agent.skills.filter(skill => routeSkillNames.has(skill.name) || lower.includes(skill.name.toLowerCase()));
  return (selected.length ? selected : agent.skills).slice(0, 5);
}

function confidence(score: number, skillCount: number): number {
  return Math.min(0.95, Number((0.35 + score * 0.15 + Math.min(skillCount, 3) * 0.05).toFixed(2)));
}

function relevantPages(routeId: string): string[] {
  const base = ['knowledge/agent-fleet/gbrain-fleet-usefulness-v2-controlled-promotion-canary-intelligence-2026-05-30'];
  if (routeId === 'gbrain') base.push('knowledge/agent-fleet/gbrain-agent-fleet-feature-roadmap-2026-05-30');
  if (routeId === 'resource-boundary') base.push('knowledge/agents/hermes');
  return base;
}

function safetyNotes(routeId: string, request: string): string[] {
  const notes = ['Suggestion only; this command does not execute tasks.'];
  if (routeId === 'resource-boundary' || /\b(email|calendar|drive|gmail)\b/i.test(request)) {
    notes.push('Personal-resource requests require the requester/owner-owned connector; do not fall back to Roger credentials for non-Roger users.');
  }
  if (routeId === 'gbrain') notes.push('Keep normal GBrain MCP access read-only; use constrained checkpoint/promotion lanes for writes.');
  return notes;
}
