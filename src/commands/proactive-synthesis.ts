import { buildProactiveSynthesis, writeProactiveSynthesisSandbox } from '../core/proactive-synthesis.ts';

interface ParsedArgs {
  sourceHealth?: string;
  capabilityCatalog?: string;
  orphanReport?: string;
  retrievalExperiment?: string;
  output?: string;
  title?: string;
  json: boolean;
  canonicalRoot?: string;
}

export async function runProactiveSynthesisCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (!parsed.output) throw new Error('Missing required --output <dir>');
  const synthesis = buildProactiveSynthesis({
    sourceHealth: parsed.sourceHealth,
    capabilityCatalog: parsed.capabilityCatalog,
    orphanReport: parsed.orphanReport,
    retrievalExperiment: parsed.retrievalExperiment,
    title: parsed.title,
  });
  const written = writeProactiveSynthesisSandbox(synthesis, parsed.output, parsed.canonicalRoot);
  if (parsed.json) {
    console.log(JSON.stringify({ ok: true, written, synthesis }, null, 2));
    return;
  }
  console.log(`Proactive synthesis sandbox: ${written.markdown}`);
  console.log('Side effects: llm=0 live_db=0 canonical_vault=0 live_sync=0');
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      case '--source-health':
        parsed.sourceHealth = args[++i];
        break;
      case '--capability-catalog':
        parsed.capabilityCatalog = args[++i];
        break;
      case '--orphan-report':
        parsed.orphanReport = args[++i];
        break;
      case '--retrieval-experiment':
        parsed.retrievalExperiment = args[++i];
        break;
      case '--output':
        parsed.output = args[++i];
        break;
      case '--title':
        parsed.title = args[++i];
        break;
      case '--canonical-root':
        parsed.canonicalRoot = args[++i];
        break;
      case '--json':
        parsed.json = true;
        break;
      default:
        throw new Error(`Unknown proactive-synthesis option: ${arg}`);
    }
  }
  return parsed;
}

function printHelp(): void {
  console.log(`Usage: gbrain proactive-synthesis --output <sandbox-dir> [artifact inputs] [--json]

Create a sandbox-only fleet synthesis brief from source-health, capability,
orphan, and retrieval experiment artifacts. This command never writes canonical
vault notes or live GBrain pages.

Options:
  --source-health <json>          Source health JSON artifact
  --capability-catalog <json>     Capability catalog JSON artifact/result
  --orphan-report <json>          Graph orphan report JSON/result
  --retrieval-experiment <json>   Retrieval experiment gate JSON/result
  --output <dir>                  Sandbox output root (required)
  --title <text>                  Custom brief title
  --canonical-root <dir>          Canonical root to refuse
  --json                          Emit machine-readable result
`);
}
