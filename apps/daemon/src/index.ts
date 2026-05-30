import { loadEnvFiles } from './cli/load-env.js';

const envResult = loadEnvFiles();

import { runServe } from './cli/serve.js';
import { runIndexRepo } from './cli/index-repo.js';
import { runConsentCommand } from './cli/consent.js';
import { log } from './cli/util.js';

type CommandTable = Record<string, (args: readonly string[]) => Promise<number>>;

const commands: CommandTable = {
  serve: () => runServe(),
  index: (args) => runIndexRepo(args),
  consent: (args) => runConsentCommand(args),
};

function usage(): void {
  console.log(`Usage:
  upwell serve                         Start the daemon (env: DEEPGRAM_API_KEY, VOYAGE_API_KEY, RISEZOME_SIDECAR_PATH, RISEZOME_SIDECAR_SHA, RISEZOME_PORT)
  upwell index <owner/repo>            Index a GitHub repo into the corpus (env: GITHUB_TOKEN, VOYAGE_API_KEY)
  upwell consent list                  List recorded consent grants
  upwell consent grant <provider>      Record consent for a provider (deepgram|voyage|openai|anthropic)
  upwell consent revoke <provider>     Revoke recorded consent for a provider
`);
}

async function main(): Promise<void> {
  for (const path of envResult.loaded) {
    log('info', `loaded env from ${path}`);
  }
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === undefined || cmd === '-h' || cmd === '--help') {
    usage();
    process.exit(0);
  }
  const handler = commands[cmd];
  if (handler === undefined) {
    log('error', `Unknown command '${cmd}'.`);
    usage();
    process.exit(2);
  }
  try {
    const code = await handler(rest);
    process.exit(code);
  } catch (err) {
    log('error', `command '${cmd}' failed: ${(err as Error).message}`, {
      stack: (err as Error).stack,
    });
    process.exit(1);
  }
}

void main();
