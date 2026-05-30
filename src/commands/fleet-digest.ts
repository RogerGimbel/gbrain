import { buildFleetDigest, renderFleetDigestMarkdown } from '../core/fleet-digest.ts';

interface ParsedArgs {
  output?: string;
  promotionQueue?: string;
  sourceHealth?: string;
  fleetDrift?: string;
  retrievalCanary?: string;
  json: boolean;
  markdown: boolean;
  dryRun: boolean;
}

export async function runFleetDigestCommand(args: string[]) {
  const parsed = parseArgs(args);
  const digest = buildFleetDigest({
    outputRoot: parsed.output,
    dryRun: parsed.dryRun,
    promotionQueuePath: parsed.promotionQueue,
    sourceHealthPath: parsed.sourceHealth,
    fleetDriftPath: parsed.fleetDrift,
    retrievalCanaryPath: parsed.retrievalCanary,
  });
  if (parsed.json) {
    console.log(JSON.stringify(digest, null, 2));
    return;
  }
  if (parsed.markdown) {
    process.stdout.write(renderFleetDigestMarkdown(digest));
    return;
  }
  console.log([
    'Fleet Digest',
    digest.sections.promotion_queue,
    digest.sections.source_health,
    digest.sections.fleet_drift,
    digest.sections.retrieval_canary,
    `Recommendations: ${digest.recommendations.length}`,
    `Output: ${parsed.output ?? '(report only)'}`,
    'Side effects: canonical_vault=0 live_db=0 task_executions=0',
  ].join('\n'));
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { json: false, markdown: false, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      case '--output': parsed.output = args[++i]; break;
      case '--promotion-queue': parsed.promotionQueue = args[++i]; break;
      case '--source-health': parsed.sourceHealth = args[++i]; break;
      case '--fleet-drift': parsed.fleetDrift = args[++i]; break;
      case '--retrieval-canary': parsed.retrievalCanary = args[++i]; break;
      case '--json': parsed.json = true; break;
      case '--markdown': parsed.markdown = true; break;
      case '--dry-run': parsed.dryRun = true; break;
      default: throw new Error(`Unknown fleet-digest option: ${arg}`);
    }
  }
  return parsed;
}

function printHelp(): void {
  console.log(`Usage: gbrain fleet-digest --output <dir> [--promotion-queue json] [--source-health json] [--fleet-drift json] [--retrieval-canary json] [--json]

Build a Telegram-friendly staged fleet digest. No canonical writes or task execution.
`);
}
