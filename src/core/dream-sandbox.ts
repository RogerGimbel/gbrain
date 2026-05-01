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
  sideEffects: DreamSandboxSideEffects;
}

export interface DreamSandboxSideEffects {
  llmCalls: 0;
  minionJobs: 0;
  liveDbWrites: 0;
  canonicalVaultWrites: 0;
}

export type DreamSandboxCheckStatus = 'pass' | 'deferred' | 'fail';

export interface DreamSandboxGoalCheck {
  id: string;
  upstreamGoal: string;
  status: DreamSandboxCheckStatus;
  finding: string;
}

export interface DreamSandboxEvaluation {
  overallStatus: 'sandbox-pass-needs-human-review' | 'sandbox-fail';
  slug: string;
  outputPath: string;
  input: string;
  contentHash: string;
  sideEffects: DreamSandboxSideEffects;
  upstreamGoalChecks: DreamSandboxGoalCheck[];
  recommendations: string[];
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

export function evaluateDreamSandbox(result: DreamSandboxResult): DreamSandboxEvaluation {
  const checks: DreamSandboxGoalCheck[] = [
    {
      id: 'quote-user-verbatim',
      upstreamGoal: 'Quote the user verbatim; do not paraphrase memorable phrasing.',
      status: result.markdown.includes('```text') ? 'pass' : 'fail',
      finding: result.markdown.includes('```text')
        ? 'The sandbox artifact preserves a verbatim transcript excerpt instead of pretending to synthesize canonical memory.'
        : 'The artifact does not include a verbatim transcript excerpt.',
    },
    {
      id: 'cross-reference-existing-brain',
      upstreamGoal: 'Cross-reference existing brain content after searching before writes.',
      status: 'deferred',
      finding: 'Deferred intentionally: the sandbox evaluator does not connect to live GBrain or run search, so it cannot safely assert existing-page wikilinks yet.',
    },
    {
      id: 'allowed-namespace',
      upstreamGoal: 'Write only to an allowlisted namespace.',
      status: result.slug.startsWith('experiments/dreams/') ? 'pass' : 'fail',
      finding: `Output slug is ${result.slug}; expected experimental namespace experiments/dreams/...`,
    },
    {
      id: 'slug-discipline',
      upstreamGoal: 'Use lowercase alphanumeric/hyphen slash-separated slugs with no extensions.',
      status: /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/.test(result.slug) ? 'pass' : 'fail',
      finding: 'Slug format is checked locally before any promotion path exists.',
    },
    {
      id: 'no-canonical-write',
      upstreamGoal: 'Do not write directly to canonical live pages during first evaluation.',
      status: result.sideEffects.liveDbWrites === 0 && result.sideEffects.canonicalVaultWrites === 0 ? 'pass' : 'fail',
      finding: 'Sandbox command reports zero live DB writes and zero canonical Obsidian writes.',
    },
    {
      id: 'human-review-required',
      upstreamGoal: 'Require human review before synthesized output becomes canonical memory.',
      status: result.markdown.includes('Promotion checklist') && result.markdown.includes('sandbox-only') ? 'pass' : 'fail',
      finding: 'Artifact includes sandbox-only warning plus a promotion checklist.',
    },
  ];
  const failed = checks.some(c => c.status === 'fail');
  return {
    overallStatus: failed ? 'sandbox-fail' : 'sandbox-pass-needs-human-review',
    slug: result.slug,
    outputPath: result.outputPath,
    input: result.input,
    contentHash: result.contentHash,
    sideEffects: result.sideEffects,
    upstreamGoalChecks: checks,
    recommendations: [
      'No live promotion is allowed from this report.',
      'Human-review the sandbox artifact before designing any canonical write path.',
      'Keep the next Step 6 slice sandboxed; do not add Anthropic calls, minions, live DB writes, or canonical vault writes yet.',
      'If the format is useful, next add fixture-based quality cases for real session patterns before any live integration.',
    ],
  };
}

export function renderDreamSandboxEvaluationMarkdown(evaluation: DreamSandboxEvaluation): string {
  const lines: string[] = [];
  lines.push('# Dream Sandbox Evaluation');
  lines.push('');
  lines.push(`- Status: \`${evaluation.overallStatus}\``);
  lines.push(`- Input: \`${evaluation.input}\``);
  lines.push(`- Output: \`${evaluation.outputPath}\``);
  lines.push(`- Slug: \`${evaluation.slug}\``);
  lines.push(`- Content hash: \`${evaluation.contentHash}\``);
  lines.push('');
  lines.push('## Safety side effects');
  lines.push('');
  lines.push(`- LLM calls: ${evaluation.sideEffects.llmCalls}`);
  lines.push(`- Minion/subagent jobs: ${evaluation.sideEffects.minionJobs}`);
  lines.push(`- Live GBrain DB writes: ${evaluation.sideEffects.liveDbWrites}`);
  lines.push(`- Canonical Obsidian writes: ${evaluation.sideEffects.canonicalVaultWrites}`);
  lines.push('');
  lines.push('## Upstream goal comparison');
  lines.push('');
  for (const check of evaluation.upstreamGoalChecks) {
    lines.push(`### ${check.id}`);
    lines.push('');
    lines.push(`- Status: \`${check.status}\``);
    lines.push(`- Upstream goal: ${check.upstreamGoal}`);
    lines.push(`- Finding: ${check.finding}`);
    lines.push('');
  }
  lines.push('## Recommendations');
  lines.push('');
  for (const recommendation of evaluation.recommendations) {
    lines.push(`- ${recommendation}`);
  }
  return lines.join('\n');
}
