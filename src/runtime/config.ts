import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { arenaCapabilities, arenaContextBudget } from '../gateway/adapters.ts';

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
      model.limit.context = Math.min(model.limit.context,arenaContextBudget(env.ARENA_CONTEXT_BUDGET_BYTES));
      model.limit.output = Math.min(model.limit.output,arenaCapabilities.maxOutput);
    }
    // All Arena delegation is managed by Supervisor so each role can be bound first.
    config.agent.sidekick.permission = {...config.agent.sidekick.permission,task:'deny'};
  }
  if(env.COAGENT_MCP_URL){
    const endpoint=new URL(env.COAGENT_MCP_URL);if(endpoint.protocol!=='https:'&&!(endpoint.protocol==='http:'&&['127.0.0.1','localhost'].includes(endpoint.hostname)))throw new Error('MCP URL must use HTTPS or loopback HTTP');
    config.mcp={...config.mcp,local_workspace:env.COAGENT_MCP_TEXT_ONLY==='1'?{type:'local',command:[process.execPath,resolve(import.meta.dirname,'mcp-text-bridge.ts')],enabled:true,timeout:120000}:{type:'remote',url:'{env:COAGENT_MCP_URL}',enabled:true,oauth:false,timeout:120000}};
    const reads=['read_files','read_image','list_directory','find_files','search_files','get_diagnostics'];
    for(const role of ['sidekick','reviewer','explorer','lead']){
      const agent=config.agent[role];agent.tools={...agent.tools,read:false,glob:false,grep:false,list:false,edit:false,write:false,bash:false};
      agent.prompt+='\nUse absolute paths for local_workspace MCP file tools and set run_command.cwd to this task workspace. The MCP server default directory may differ from the selected local project; never write a replacement in its default directory.';
      agent.permission={...agent.permission,'local_workspace_*':role==='sidekick'?'ask':'deny'};
      for(const tool of reads)agent.permission['local_workspace_'+tool]='allow';
    }
  }
  config.plugin = config.plugin.map((plugin: string) => plugin.startsWith('.') ? pathToFileURL(resolve(dirname(templatePath),plugin)).href : plugin);
  const path = resolve(stateDirectory,'opencode.json');
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  await writeFile(path,JSON.stringify(config,null,2)+'\n',{mode:0o600});
  return path;
}
