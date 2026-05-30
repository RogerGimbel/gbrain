import { runSessionPacketSandbox } from '../core/session-packet.ts';

interface ParsedArgs {
  input?: string;
  output?: string;
  dryRun: boolean;
  json: boolean;
  sourceAgent?: string;
  sourceProfile?: string;
  sourceOrigin?: string;
  sourceId?: string;
  canonicalRoot?: string;
}

export async function runSessionPacketCommand(args: string[]) {
  const parsed = parseArgs(args);
  if (!parsed.input) throw new Error('Missing required --input <file>');
  if (!parsed.output) throw new Error('Missing required --output <dir>');

  const result = runSessionPacketSandbox({
    input: parsed.input,
    outputRoot: parsed.output,
    dryRun: parsed.dryRun,
    canonicalRoot: parsed.canonicalRoot,
    sourceAgent: parsed.sourceAgent,
    sourceProfile: parsed.sourceProfile,
    sourceOrigin: parsed.sourceOrigin,
    sourceId: parsed.sourceId,
  });

  if (parsed.json) {
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return;
  }

  console.log([
    `Session packet: ${result.slug}`,
    `Output: ${result.outputPath}`,
    `Written: ${result.written}`,
    'Side effects: llm=0 live_db=0 canonical_vault=0 live_sync=0',
  ].join('\n'));
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { dryRun: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      case '--input':
        parsed.input = args[++i];
        break;
      case '--output':
        parsed.output = args[++i];
        break;
      case '--dry-run':
        parsed.dryRun = true;
        break;
      case '--json':
        parsed.json = true;
        break;
      case '--source-agent':
        parsed.sourceAgent = args[++i];
        break;
      case '--source-profile':
        parsed.sourceProfile = args[++i];
        break;
      case '--source-origin':
        parsed.sourceOrigin = args[++i];
        break;
      case '--source-id':
        parsed.sourceId = args[++i];
        break;
      case '--canonical-root':
        parsed.canonicalRoot = args[++i];
        break;
      default:
        throw new Error(`Unknown session-packet option: ${arg}`);
    }
  }
  return parsed;
}

function printHelp(): void {
  console.log(`Usage: gbrain session-packet --input <transcript.txt> --output <sandbox-dir> [--dry-run] [--json]

Create a reviewable sandbox session packet from an agent/user transcript.

Safety guarantees:
  - writes only under --output
  - refuses canonical Obsidian output roots
  - does not connect to live GBrain
  - performs 0 LLM calls and 0 background agent jobs
  - raw transcript is not embedded in the packet

Options:
  --input <file>              Transcript/session log file to summarize (required)
  --output <dir>              Sandbox output root (required)
  --dry-run                   Render packet without writing files
  --json                      Emit machine-readable JSON
  --source-agent <name>       Hermes, Argos, Winston, Cato, Rogue, OOMOps, etc.
  --source-profile <name>     Agent profile name
  --source-origin <name>      telegram, cli, cron, codex, openclaw, etc.
  --source-id <id>            Stable source ID for traceability
  --canonical-root <dir>      Canonical vault root to refuse
`);
}
