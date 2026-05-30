import { buildCapabilityCatalog, writeCapabilityCatalog } from '../core/capability-catalog.ts';

interface ParsedArgs {
  agents: Array<{ name: string; skillsDir: string }>;
  skillpackManifests: string[];
  output?: string;
  json: boolean;
}

export async function runCapabilityCatalogCommand(args: string[]) {
  const parsed = parseArgs(args);
  if (parsed.agents.length === 0) throw new Error('At least one --agent Name=/path/to/skills is required');
  const catalog = buildCapabilityCatalog({ agents: parsed.agents, skillpackManifests: parsed.skillpackManifests });
  const written = parsed.output ? writeCapabilityCatalog(catalog, parsed.output) : undefined;
  if (parsed.json) {
    console.log(JSON.stringify({ ok: true, written, catalog }, null, 2));
    return;
  }
  console.log(`Fleet capability catalog: ${catalog.agents.length} agent(s), ${catalog.skillpacks.length} skillpack(s), ${catalog.routes.length} route(s)`);
  if (written) console.log(`Wrote ${written.markdown}\nWrote ${written.json}`);
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { agents: [], skillpackManifests: [], json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      case '--agent': {
        const spec = args[++i];
        const eq = spec.indexOf('=');
        if (eq === -1) throw new Error('--agent must be Name=/path/to/skills');
        parsed.agents.push({ name: spec.slice(0, eq), skillsDir: spec.slice(eq + 1) });
        break;
      }
      case '--skillpack-manifest':
        parsed.skillpackManifests.push(args[++i]);
        break;
      case '--output':
        parsed.output = args[++i];
        break;
      case '--json':
        parsed.json = true;
        break;
      default:
        throw new Error(`Unknown capability-catalog option: ${arg}`);
    }
  }
  return parsed;
}

function printHelp(): void {
  console.log(`Usage: gbrain capability-catalog --agent Hermes=/path/to/skills [--agent Winston=/path] [--skillpack-manifest manifest.json] [--output dir] [--json]

Build a central fleet capability catalog from agent skill directories and shared skillpack manifests.

Safety guarantees:
  - filesystem read-only except explicit --output artifacts
  - no live DB writes
  - no prompt/resident memory mutation

Options:
  --agent Name=/dir              Agent name and skill directory; repeatable
  --skillpack-manifest <file>    Shared skillpack manifest JSON; repeatable
  --output <dir>                 Write fleet-capability-catalog.{md,json}
  --json                         Emit machine-readable result
`);
}
