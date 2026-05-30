import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'path';

export interface ControlledPromoteInput {
  itemPath: string;
  targetRoot: string;
  namespace: string;
  apply?: boolean;
  allowedNamespaces?: string[];
}

export interface ControlledPromotionReceipt {
  ok: boolean;
  applied: boolean;
  generated_at: string;
  item_id: string;
  artifact_class: string;
  risk: string;
  namespace: string;
  target_path: string;
  receipt_path?: string;
  blockers: string[];
  diff: string;
  sideEffects: {
    canonicalVaultWrites: 0 | 1;
    liveDbWrites: 0;
    liveSync: 0;
  };
}

type PromotionItem = {
  id?: string;
  title?: string;
  path: string;
  artifact_class?: string;
  risk?: string;
  status?: string;
  checksum?: string;
  blockers?: string[];
};

const DEFAULT_ALLOWED_NAMESPACES = [
  'knowledge/reports',
  'knowledge/checkpoints',
  'knowledge/agent-fleet/status',
  'knowledge/agent-fleet/briefs',
];

const SECRET_PATTERNS = [
  /\b(api[_-]?key|secret|token|password|connection[_-]?string)\b\s*[:=]/i,
  /\bsk-[A-Za-z0-9._-]{8,}\b/,
  /postgres(?:ql)?:\/\//i,
];

export function planControlledPromotion(input: ControlledPromoteInput): ControlledPromotionReceipt {
  const item = loadItem(input.itemPath);
  const artifactContent = existsSync(item.path) ? readFileSync(item.path, 'utf8') : '';
  const targetPath = targetPathFor(input.targetRoot, input.namespace, item, artifactContent);
  const promotedContent = renderPromotedArtifact(item, artifactContent, input.namespace);
  const blockers = blockersFor(item, artifactContent, input.namespace, input.allowedNamespaces ?? DEFAULT_ALLOWED_NAMESPACES, input.targetRoot, targetPath);
  return {
    ok: blockers.length === 0,
    applied: false,
    generated_at: new Date().toISOString(),
    item_id: item.id ?? 'unknown',
    artifact_class: item.artifact_class ?? 'unknown',
    risk: item.risk ?? 'unknown',
    namespace: input.namespace,
    target_path: targetPath,
    blockers,
    diff: renderDiff(targetPath, promotedContent),
    sideEffects: { canonicalVaultWrites: 0, liveDbWrites: 0, liveSync: 0 },
  };
}

export function runControlledPromotion(input: ControlledPromoteInput): ControlledPromotionReceipt {
  const planned = planControlledPromotion(input);
  if (!input.apply || !planned.ok) return planned;
  const item = loadItem(input.itemPath);
  const content = renderPromotedArtifact(item, readFileSync(item.path, 'utf8'), input.namespace);
  mkdirSync(resolve(planned.target_path, '..'), { recursive: true });
  writeFileSync(planned.target_path, content, 'utf8');
  const receipt = { ...planned, applied: true, sideEffects: { canonicalVaultWrites: 1 as const, liveDbWrites: 0 as const, liveSync: 0 as const } };
  const receiptPath = planned.target_path.replace(/(\.[^.]+)?$/, '.promotion-receipt.json');
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), 'utf8');
  return { ...receipt, receipt_path: receiptPath };
}

function loadItem(path: string): PromotionItem {
  if (!existsSync(path)) throw new Error(`Promotion item not found: ${path}`);
  const item = JSON.parse(readFileSync(path, 'utf8')) as PromotionItem;
  if (!item.path) throw new Error('Promotion item missing path');
  return item;
}

function blockersFor(item: PromotionItem, content: string, namespace: string, allowedNamespaces: string[], targetRoot: string, targetPath: string): string[] {
  const blockers = [...(item.blockers ?? [])];
  if (!isSafeNamespacePath(namespace)) blockers.push(`namespace ${namespace} contains path traversal or absolute path segments`);
  if (!allowedNamespaces.some(ns => namespace === ns || namespace.startsWith(ns + '/'))) blockers.push(`namespace ${namespace} is not allowlisted`);
  if (targetEscapesRoot(targetRoot, targetPath)) blockers.push(`target path escapes target root: ${targetPath}`);
  if (existsSync(targetPath)) blockers.push('target artifact already exists; duplicate/replay promotion requires manual handling');
  if (item.status && item.status !== 'ready') blockers.push(`item status is ${item.status}, not ready`);
  if (item.risk === 'high') blockers.push('high-risk item requires manual handling');
  if (item.artifact_class === 'raw-transcript') blockers.push('raw transcript promotion is blocked');
  if (!existsSync(item.path)) blockers.push(`artifact not found: ${item.path}`);
  if (SECRET_PATTERNS.some(pattern => pattern.test(content))) blockers.push('secret-looking value detected; redact before promotion');
  return blockers;
}

function targetPathFor(targetRoot: string, namespace: string, item: PromotionItem, content: string): string {
  const checksum = createHash('sha256').update(content || JSON.stringify(item)).digest('hex').slice(0, 12);
  const ext = extname(item.path) || '.md';
  const title = slugify(item.title ?? basename(item.path, ext));
  const date = new Date().toISOString().slice(0, 10);
  return join(targetRoot, safeNamespaceForTarget(namespace), `${date}-${title}-${checksum}${ext}`);
}

function renderPromotedArtifact(item: PromotionItem, content: string, namespace: string): string {
  const header = [
    '---',
    `title: ${JSON.stringify(item.title ?? basename(item.path))}`,
    'type: controlled-promotion',
    `controlled_promotion_id: ${item.id ?? 'unknown'}`,
    `artifact_class: ${item.artifact_class ?? 'unknown'}`,
    `source_path: ${JSON.stringify(item.path)}`,
    `target_namespace: ${namespace}`,
    `source_updated_at: ${new Date().toISOString()}`,
    'status: promoted',
    '---',
    '',
  ].join('\n');
  if (content.startsWith('---\n')) return `${header}${content.replace(/^---[\s\S]*?\n---\n?/, '')}`;
  return `${header}${content}`;
}

function renderDiff(targetPath: string, content: string): string {
  return [`--- /dev/null`, `+++ ${targetPath}`, '@@ controlled promotion @@', ...content.split('\n').map(line => `+${line}`)].join('\n');
}

function safeNamespaceForTarget(namespace: string): string {
  return isSafeNamespacePath(namespace) ? namespace : 'blocked/invalid-namespace';
}

function isSafeNamespacePath(namespace: string): boolean {
  if (!namespace || isAbsolute(namespace) || namespace.includes('\\')) return false;
  return !namespace.split('/').some(part => part === '..' || part === '.');
}

function targetEscapesRoot(targetRoot: string, targetPath: string): boolean {
  const root = resolve(targetRoot);
  const target = resolve(targetPath);
  const rel = relative(root, target);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'artifact';
}
