import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Store } from './supervisor/store.ts';
import { Orchestrator } from './supervisor/orchestrator.ts';
import { GitWorktrees } from './supervisor/worktree.ts';
import { runtimeEnvironment } from './runtime/environment.ts';
import { runtimeConfig } from './runtime/config.ts';
import { OpenCodeRuntime } from './runtime/opencode.ts';
import { ModelRouter } from './gateway/router.ts';
import { MockAdapter, OpenAIAdapter, ArenaResearchAdapter, ArenaAgentAdapter, arenaContextBudget } from './gateway/adapters.ts';
import { createApp } from './server.ts';
import { ArenaPool } from './arena/pool.ts';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const [command='help',arg,extra]=process.argv.slice(2);
const key=process.env.COAGENT_API_KEY ?? '';
const port=Number(process.env.COAGENT_PORT ?? 4310);
async function main(){
  if(command==='acp'){const {runAcp}=await import('./acp/main.ts');runAcp(root,process.env);return;}
  if(command==='acp-register'){const {registerDevin}=await import('./acp/registry.ts');console.log(JSON.stringify(await registerDevin(root),null,2));return;}
  if(command==='serve'){
    if(key.length<16)throw new Error('Set COAGENT_API_KEY (at least 16 characters); see .env.example');
    const mode=process.env.COAGENT_MODE ?? 'mock';if(!['mock','litellm','arena'].includes(mode))throw new Error('COAGENT_MODE must be mock, litellm or arena');
    const store=new Store(process.env.COAGENT_DB ?? '.coagent/state.db');
    const runtime=new OpenCodeRuntime(process.env.OPENCODE_URL ?? 'http://127.0.0.1:4096',process.env.OPENCODE_SERVER_PASSWORD ?? '');
    const orchestrator=new Orchestrator(store,runtime,new GitWorktrees(process.env.COAGENT_WORKTREE_ROOT??'.coagent/worktrees'),mode==='arena'?1:Number(process.env.COAGENT_CONCURRENCY ?? 2));
    const router=new ModelRouter({record:r=>store.record(r),...(mode==='arena'?{concurrency:1,retries:0,allowSimulatedTools:process.env.COAGENT_ALLOW_SIMULATED_TOOLS==='1',timeoutMs:600000}:{})});
    const upstreamURL=process.env.LITELLM_URL ?? 'http://127.0.0.1:4000/v1',upstreamKey=process.env.LITELLM_MASTER_KEY ?? '';
    const adapter=mode==='arena'?new ArenaAgentAdapter(process.env.ARENA_BRIDGE_URL ?? 'http://127.0.0.1:20140/v1',process.env.ARENA_BRIDGE_KEY ?? '',process.env.ARENA_SESSION_BINDINGS ?? '.coagent/arena-sessions.json',process.env.COAGENT_ARENA_DEBUG_DIR,arenaContextBudget(process.env.ARENA_CONTEXT_BUDGET_BYTES)):mode==='mock'?new MockAdapter():new OpenAIAdapter('litellm',upstreamURL,upstreamKey);
    for(const alias of ['lead','sidekick','reviewer'])router.register(alias,{adapter,model:alias});
    if(process.env.ARENA_RESEARCH_URL)router.register('arena-research',{adapter:new ArenaResearchAdapter(process.env.ARENA_RESEARCH_URL,process.env.ARENA_RESEARCH_KEY ?? ''),model:process.env.ARENA_RESEARCH_MODEL ?? 'research'});
    const server=createApp({key,router,store,orchestrator,runtime,...(adapter instanceof ArenaAgentAdapter?{arena:adapter,pool:new ArenaPool(store,adapter)}:{}),...(mode==='litellm'?{litellm:{url:upstreamURL,key:upstreamKey}}:{})});
    server.listen(port,'127.0.0.1',()=>console.log(`CoAgent http://127.0.0.1:${port} mode=${mode}`));
    const tick=setInterval(()=>{void orchestrator.tick().catch(()=>console.error('Scheduler tick failed'));},250);
    let stopping=false;
    const stop=async()=>{if(stopping)return;stopping=true;clearInterval(tick);await orchestrator.close();server.closeAllConnections();server.close(()=>{store.close();});};
    process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());return;
  }
  if(command==='runtime'){
    if(!process.env.OPENCODE_SERVER_PASSWORD)throw new Error('Set OPENCODE_SERVER_PASSWORD');
    const config=await runtimeConfig(resolve(root,'config/opencode.json'),'.coagent/runtime');
    const child=spawn(resolve(root,'node_modules/.bin/opencode'),['serve','--hostname','127.0.0.1','--port',new URL(process.env.OPENCODE_URL ?? 'http://127.0.0.1:4096').port || '4096'],{stdio:'inherit',env:await runtimeEnvironment('.coagent/runtime',config)});
    process.once('SIGINT',()=>child.kill('SIGINT'));process.once('SIGTERM',()=>child.kill('SIGTERM'));child.once('exit',code=>{process.exitCode=code ?? 1;});return;
  }
  const commands:Record<string,{method:string;path:string;body?:unknown}>={
    sessions:{method:'GET',path:'/sessions'},list:{method:'GET',path:'/tasks'},metrics:{method:'GET',path:'/metrics'},show:{method:'GET',path:`/tasks/${encodeURIComponent(arg ?? '')}`},
    prepare:{method:'POST',path:`/tasks/${encodeURIComponent(arg ?? '')}/prepare`},approve:{method:'POST',path:`/tasks/${encodeURIComponent(arg ?? '')}/approve`},pause:{method:'POST',path:`/tasks/${encodeURIComponent(arg ?? '')}/pause`},resume:{method:'POST',path:`/tasks/${encodeURIComponent(arg ?? '')}/resume`},cancel:{method:'POST',path:`/tasks/${encodeURIComponent(arg ?? '')}/cancel`}
  };
  if(command==='bind'){if(!arg || !extra)throw new Error('bind <OpenCode session ID> <existing Arena session UUID>');commands.bind={method:'POST',path:'/arena/bindings',body:{sessionID:arg,arenaSessionID:extra}};}
  if(command==='submit' || command==='plan' || command==='plan-prepare'){if(!arg)throw new Error('JSON file required');commands[command]={method:'POST',path:command==='plan'?'/plan':command==='plan-prepare'?'/plan/prepare':'/tasks',body:JSON.parse(await readFile(arg,'utf8'))};}
  if(commands[command]){const c=commands[command];const response=await fetch(`http://127.0.0.1:${port}${c.path}`,{method:c.method,headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:c.body===undefined?undefined:JSON.stringify(c.body)});console.log(JSON.stringify(await response.json(),null,2));if(!response.ok)process.exitCode=1;return;}
  if(command==='events'){const response=await fetch(`http://127.0.0.1:${port}/events?after=${Number(arg ?? 0)}`,{headers:{authorization:`Bearer ${key}`}});if(!response.ok)throw new Error(`HTTP ${response.status}`);if(response.body)for await(const chunk of response.body)process.stdout.write(chunk);return;}
  console.log('CoAgent: acp | acp-register | serve | runtime | submit <tasks.json> | plan-prepare/plan <goal.json> | list | sessions | bind <session ID> <Arena UUID> | show <id> | prepare/approve/pause/resume/cancel <id> | events [cursor] | metrics');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
