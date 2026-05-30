import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, join, resolve } from 'path';

export interface SessionPacketInput {
  input: string;
  outputRoot: string;
  dryRun?: boolean;
  canonicalRoot?: string;
  sourceAgent?: string;
  sourceProfile?: string;
  sourceOrigin?: string;
  sourceId?: string;
}

export interface SessionPacket {
  title: string;
  source_agent: string;
  source_profile?: string;
  source_origin: string;
  source_id: string;
  source_updated_at: string;
  decisions: string[];
  current_state: string[];
  changed_artifacts: string[];
  verification: string[];
  blockers: string[];
  next_steps: string[];
  exclusions: string[];
}

export interface SessionPacketResult {
  slug: string;
  outputPath: string;
  markdown: string;
  packet: SessionPacket;
  written: boolean;
  sideEffects: {
    llmCalls: 0;
    liveDbWrites: 0;
    canonicalVaultWrites: 0;
    liveSync: 0;
  };
}

const DEFAULT_CANONICAL_ROOT = '/Users/rogergimbel/Knowledge/Winston';

export function assertSafeSessionPacketRoot(outputRoot: string, canonicalRoot = DEFAULT_CANONICAL_ROOT): void {
  const out = resolve(outputRoot);
  const canonical = resolve(canonicalRoot);
  if (out === canonical || out.startsWith(canonical + '/')) {
    throw new Error(`Refusing session packet output under canonical Obsidian root: ${canonical}`);
  }
}

export function planSessionPacket(input: SessionPacketInput): SessionPacketResult {
  assertSafeSessionPacketRoot(input.outputRoot, input.canonicalRoot);
  if (!existsSync(input.input)) throw new Error(`Input transcript not found: ${input.input}`);
  const transcript = readFileSync(input.input, 'utf-8');
  const sourceAgent = input.sourceAgent ?? inferAgent(transcript, input.input) ?? 'unknown';
  const sourceOrigin = input.sourceOrigin ?? 'session-log';
  const hash = createHash('sha256').update(transcript).digest('hex').slice(0, 12);
  const stamp = sourceTimestamp(transcript);
  const slug = `experiments/session-packets/${slugify(sourceAgent)}/${stamp}-${slugify(basename(input.input).replace(/\.[^.]+$/, ''))}-${hash}`;
  const packet = buildPacket(transcript, {
    title: `Session Packet — ${sourceAgent} — ${basename(input.input)}`,
    sourceAgent,
    sourceProfile: input.sourceProfile,
    sourceOrigin,
    sourceId: input.sourceId ?? `${slugify(sourceAgent)}:${sourceOrigin}:${hash}`,
    sourceUpdatedAt: new Date().toISOString(),
  });
  const markdown = renderSessionPacketMarkdown(packet, slug, input.input);
  const outputPath = join(input.outputRoot, `${slug.replace(/\//g, '__')}.md`);
  return {
    slug,
    outputPath,
    markdown,
    packet,
    written: false,
    sideEffects: { llmCalls: 0, liveDbWrites: 0, canonicalVaultWrites: 0, liveSync: 0 },
  };
}

export function runSessionPacketSandbox(input: SessionPacketInput): SessionPacketResult {
  const result = planSessionPacket(input);
  if (!input.dryRun) {
    mkdirSync(input.outputRoot, { recursive: true });
    writeFileSync(result.outputPath, result.markdown, 'utf8');
    return { ...result, written: true };
  }
  return result;
}

function buildPacket(transcript: string, meta: {
  title: string;
  sourceAgent: string;
  sourceProfile?: string;
  sourceOrigin: string;
  sourceId: string;
  sourceUpdatedAt: string;
}): SessionPacket {
  const lines = transcript.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const decisions = pick(lines, /\b(decided|decision|agree(?:d)? to|keep|use)\b/i);
  const current_state = pickValue(lines, /current state\s*:\s*(.+)$/i);
  const changed_artifacts = pickValue(lines, /changed artifacts?\s*:\s*(.+)$/i);
  const verification = pickValue(lines, /verification\s*:\s*(.+)$/i);
  const blockers = pickValue(lines, /blockers?\s*:\s*(.+)$/i);
  const next_steps = pick(lines, /\b(next step|resume|follow up|continue)\b/i);

  return {
    title: meta.title,
    source_agent: meta.sourceAgent,
    source_profile: meta.sourceProfile,
    source_origin: meta.sourceOrigin,
    source_id: meta.sourceId,
    source_updated_at: meta.sourceUpdatedAt,
    decisions: decisions.length ? decisions : ['No explicit decisions detected.'],
    current_state: current_state.length ? current_state : ['No explicit current-state line detected.'],
    changed_artifacts,
    verification,
    blockers,
    next_steps: next_steps.length ? next_steps : ['Review this sandbox packet before promotion.'],
    exclusions: [
      'Raw transcript is not embedded in the packet.',
      'Secrets, tokens, and environment values must not be promoted.',
      'This packet is sandbox-only until a human or supervising agent promotes a summary.',
    ],
  };
}

function renderSessionPacketMarkdown(packet: SessionPacket, slug: string, sourcePath: string): string {
  return [
    '---',
    `title: ${yamlScalar(packet.title)}`,
    'type: session-packet',
    'status: sandbox-only',
    `gbrain_slug: ${slug}`,
    `source_agent: ${packet.source_agent}`,
    packet.source_profile ? `source_profile: ${packet.source_profile}` : undefined,
    `source_origin: ${packet.source_origin}`,
    `source_id: ${packet.source_id}`,
    `source_updated_at: ${packet.source_updated_at}`,
    'confidence: medium',
    '---',
    '',
    `# ${packet.title}`,
    '',
    'Promotion status: sandbox-only',
    '',
    `Source path: \`${sourcePath}\``,
    '',
    '## Decisions',
    list(packet.decisions),
    '',
    '## Current State',
    list(packet.current_state),
    '',
    '## Changed Artifacts',
    list(packet.changed_artifacts),
    '',
    '## Verification',
    list(packet.verification),
    '',
    '## Blockers',
    list(packet.blockers),
    '',
    '## Next Steps',
    list(packet.next_steps),
    '',
    '## Exclusions / Safety',
    list(packet.exclusions),
    '',
  ].filter(v => v !== undefined).join('\n');
}

function pick(lines: string[], pattern: RegExp): string[] {
  return lines.filter(l => pattern.test(l)).map(stripSpeaker).slice(0, 12);
}

function pickValue(lines: string[], pattern: RegExp): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const match = line.match(pattern);
    if (match?.[1]) out.push(match[1].trim());
  }
  return out.slice(0, 12);
}

function stripSpeaker(line: string): string {
  return line.replace(/^[A-Za-z][A-Za-z0-9 _-]{0,24}:\s*/, '');
}

function inferAgent(transcript: string, path: string): string | undefined {
  const hay = `${path}\n${transcript}`.toLowerCase();
  for (const agent of ['Hermes', 'Argos', 'Winston', 'Cato', 'Rogue', 'OOMOps', 'Rodaco']) {
    if (hay.includes(agent.toLowerCase())) return agent;
  }
  return undefined;
}

function sourceTimestamp(transcript: string): string {
  const match = transcript.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  return match?.[1] ?? new Date().toISOString().slice(0, 10);
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function list(items: string[]): string {
  if (items.length === 0) return '- none detected';
  return items.map(i => `- ${i}`).join('\n');
}
