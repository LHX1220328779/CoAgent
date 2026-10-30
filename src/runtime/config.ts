import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { arenaCapabilities } from '../gateway/adapters.ts';

/** Generate a V1 config without modifying the user's template or embedding secrets. */
export async function runtimeConfig(templatePath: string, stateDirectory: string, env: NodeJS.ProcessEnv = process.env) {
  const config = JSON.parse(await readFile(templatePath,'utf8'));
  const mode = env.COAGENT_MODE ?? 'mock';
  if (!['mock','litellm','arena'].includes(mode)) throw new Error('COAGENT_MODE must be mock, litellm or arena');
  const port = Number(env.COAGENT_PORT ?? 4310);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid COAGENT_PORT');
  const provider = config.provider.coagent;
  provider.options.baseURL = `http://127.0.0.1:${port}/v1`;
  if (mode === 'arena') {
    for (const model of Object.values(provider.models) as {limit: {context: number; output: number}}[]) {
      model.limit.context = Math.min(model.limit.context,arenaCapabilities.contextWindow);
      model.limit.output = Math.min(model.limit.output,arenaCapabilities.maxOutput);
    }
    // All Arena delegation is managed by Supervisor so each role can be bound first.
    config.agent.sidekick.permission = {...config.agent.sidekick.permission,task:'deny'};
  }
  config.plugin = config.plugin.map((plugin: string) => plugin.startsWith('.') ? pathToFileURL(resolve(dirname(templatePath),plugin)).href : plugin);
  const path = resolve(stateDirectory,'opencode.json');
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  await writeFile(path,JSON.stringify(config,null,2)+'\n',{mode:0o600});
  return path;
}
