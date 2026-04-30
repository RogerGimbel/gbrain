import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';

const DEFAULT_CANONICAL_OBSIDIAN_ROOT = '/Users/rogergimbel/Knowledge/Winston';
const DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})/;

export interface DreamSandboxOptions {
  input: string;
  outputRoot: string;
  dryRun?: boolean;
  canonicalRoot?: string;
}

export interface DreamSandboxResult {
  ok: true;
  input: string;
  outputRoot: string;
  slug: string;
  outputPath: string;
  markdown: string;
  written: boolean;
  contentHash: string;
  transcriptBytes: number;
  sideEffects: {
    llmCalls: 0;
    minionJobs: 0;
    liveDbWrites: 0;
    canonicalVaultWrites: 0;
  };
}

export function assertSafeDreamSandboxRoot(
  outputRoot: string,
  canonicalRoot = DEFAULT_CANONICAL_OBSIDIAN_ROOT,
): void {
  const out = resolve(outputRoot);
  const canonical = resolve(canonicalRoot);
  if (out === canonical || out.startsWith(canonical + '/')) {
    throw new Error(`Refusing dream sandbox output under canonical Obsidian vault: ${out}`);
  }
}

function slugifySegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-') || 'transcript';
}

function yamlString(value: string): string {
  return JSON.stringify(value ?? '');
}

function inferDateFromName(fileName: string): string {
  const match = fileName.match(DATE_PREFIX_RE);
  if (match) return match[1];
  return new Date().toISOString().slice(0, 10);
}

function excerpt(content: string, max = 900): string {
  const cleaned = content.replace(/\r\n/g, '\n').trim();
  return cleaned.length <= max ? cleaned : cleaned.slice(0, max).trimEnd() + '\n…';
}

export function planDreamSandbox(opts: DreamSandboxOptions): DreamSandboxResult {
  if (!opts.input) throw new Error('--input is required');
  if (!opts.outputRoot) throw new Error('--output is required');
  const input = resolve(opts.input);
  const outputRoot = resolve(opts.outputRoot);
  assertSafeDreamSandboxRoot(outputRoot, opts.canonicalRoot);
  if (!existsSync(input)) throw new Error(`Input transcript does not exist: ${input}`);

  const content = readFileSync(input, 'utf8');
  const contentHash = createHash('sha256').update(content).digest('hex');
  const fileName = basename(input);
  const date = inferDateFromName(fileName);
  const baseSlug = slugifySegment(fileName);
  const slug = `experiments/dreams/${date}/${baseSlug}-${contentHash.slice(0, 8)}`;
  const outputPath = join(outputRoot, `${slug}.md`);
  const title = `Dream Sandbox — ${baseSlug}`;
  const markdown = [
    '---',
    `title: ${yamlString(title)}`,
    'type: source',
    'tags:',
    '  - dream-sandbox',
    '  - experimental',
    'status: sandbox-only',
    `source_path: ${yamlString(input)}`,
    `content_hash: ${yamlString(contentHash)}`,
    `generated_at: ${yamlString(new Date().toISOString())}`,
    '---',
    '',
    `# ${title}`,
    '',
    'Promotion status: sandbox-only. This is an experimental dream-synthesis artifact and must not be treated as canonical memory without human review.',
    '',
    '## Safety envelope',
    '',
    '- LLM calls: 0',
    '- Minion/subagent jobs: 0',
    '- Live GBrain DB writes: 0',
    '- Canonical Obsidian writes: 0',
    '- Allowed namespace: `experiments/dreams/...`',
    '',
    '## Source transcript excerpt',
    '',
    '```text',
    excerpt(content),
    '```',
    '',
    '## Promotion checklist',
    '',
    '- [ ] Human reviewed the source transcript.',
    '- [ ] Human reviewed this generated artifact.',
    '- [ ] Canonical target namespace selected explicitly.',
    '- [ ] Live retrieval baseline checked before promotion.',
  ].join('\n');

  return {
    ok: true,
    input,
    outputRoot,
    slug,
    outputPath,
    markdown,
    written: false,
    contentHash,
    transcriptBytes: Buffer.byteLength(content, 'utf8'),
    sideEffects: {
      llmCalls: 0,
      minionJobs: 0,
      liveDbWrites: 0,
      canonicalVaultWrites: 0,
    },
  };
}

export function runDreamSandbox(opts: DreamSandboxOptions): DreamSandboxResult {
  const result = planDreamSandbox(opts);
  if (!opts.dryRun) {
    mkdirSync(dirname(result.outputPath), { recursive: true });
    writeFileSync(result.outputPath, result.markdown, 'utf8');
    return { ...result, written: true };
  }
  return result;
}
