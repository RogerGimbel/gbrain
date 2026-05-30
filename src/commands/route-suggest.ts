import { readFileSync } from 'fs';
import { suggestRoute, renderRouteSuggestionMarkdown } from '../core/route-suggest.ts';
import type { CapabilityCatalog } from '../core/capability-catalog.ts';

interface ParsedArgs {
  catalog?: string;
  request?: string;
  output?: string;
  json: boolean;
  markdown: boolean;
}

export async function runRouteSuggestCommand(args: string[]) {
  const parsed = parseArgs(args);
  if (!parsed.catalog) throw new Error('Missing required --catalog <catalog.json>');
  if (!parsed.request) throw new Error('Missing required --request "..."');
  const catalog = JSON.parse(readFileSync(parsed.catalog, 'utf8')) as CapabilityCatalog;
  const result = suggestRoute({ catalog, request: parsed.request, outputRoot: parsed.output });
  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (parsed.markdown) {
    process.stdout.write(renderRouteSuggestionMarkdown(result));
    return;
  }
  console.log([
    `Route suggestion: ${result.suggested_agent}`,
    `route_group: ${result.route_group}`,
    `confidence: ${result.confidence}`,
    `skills: ${result.skills.join(', ') || 'none'}`,
    'Side effects: task_executions=0 live_db=0',
  ].join('\n'));
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { json: false, markdown: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      case '--catalog': parsed.catalog = args[++i]; break;
      case '--request': parsed.request = args[++i]; break;
      case '--output': parsed.output = args[++i]; break;
      case '--json': parsed.json = true; break;
      case '--markdown': parsed.markdown = true; break;
      default:
        if (!arg.startsWith('--') && !parsed.request) parsed.request = arg;
        else throw new Error(`Unknown route-suggest option: ${arg}`);
    }
  }
  return parsed;
}

function printHelp(): void {
  console.log(`Usage: gbrain route-suggest --catalog <catalog.json> --request "..." [--output dir] [--json|--markdown]

Suggest an agent/profile/skill/page route from the fleet capability catalog. Suggestions only; no task execution.
`);
}
