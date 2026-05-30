import { planControlledPromotion, runControlledPromotion } from '../core/controlled-promote.ts';

interface ParsedArgs {
  item?: string;
  targetRoot?: string;
  namespace?: string;
  apply: boolean;
  json: boolean;
}

export async function runControlledPromoteCommand(args: string[]) {
  const parsed = parseArgs(args);
  if (!parsed.item) throw new Error('Missing required --item <manifest.json>');
  if (!parsed.targetRoot) throw new Error('Missing required --target-root <dir>');
  if (!parsed.namespace) throw new Error('Missing required --namespace <slug>');
  const receipt = parsed.apply
    ? runControlledPromotion({ itemPath: parsed.item, targetRoot: parsed.targetRoot, namespace: parsed.namespace, apply: true })
    : planControlledPromotion({ itemPath: parsed.item, targetRoot: parsed.targetRoot, namespace: parsed.namespace });
  if (parsed.json) {
    console.log(JSON.stringify(receipt, null, 2));
    return;
  }
  console.log([
    `Controlled promotion: ${receipt.ok ? 'OK' : 'BLOCKED'}`,
    `applied: ${receipt.applied}`,
    `target: ${receipt.target_path}`,
    `canonical_vault_writes: ${receipt.sideEffects.canonicalVaultWrites}`,
    `live_db_writes: ${receipt.sideEffects.liveDbWrites}`,
    ...(receipt.blockers.length ? receipt.blockers.map(b => `BLOCKER: ${b}`) : []),
  ].join('\n'));
  if (!receipt.ok) process.exit(1);
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { apply: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      case '--item': parsed.item = args[++i]; break;
      case '--target-root': parsed.targetRoot = args[++i]; break;
      case '--namespace': parsed.namespace = args[++i]; break;
      case '--apply': parsed.apply = true; break;
      case '--json': parsed.json = true; break;
      default: throw new Error(`Unknown controlled-promote option: ${arg}`);
    }
  }
  return parsed;
}

function printHelp(): void {
  console.log(`Usage: gbrain controlled-promote --item <manifest.json> --target-root <dir> --namespace <slug> [--apply] [--json]

Dry-run by default. Applies only allowlisted low-risk generated reports with explicit --apply.
`);
}
