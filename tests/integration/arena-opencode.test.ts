import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { repoFixture } from '../helpers.ts';
import { OpenCodeRuntime } from '../../src/runtime/opencode.ts';
import { runtimeConfig } from '../../src/runtime/config.ts';
import { runtimeEnvironment } from '../../src/runtime/environment.ts';
import { ArenaAgentAdapter } from '../../src/gateway/adapters.ts';
import { ModelRouter } from '../../src/gateway/router.ts';
import { Store } from '../../src/supervisor/store.ts';
import { Orchestrator } from '../../src/supervisor/orchestrator.ts';
import { GitWorktrees } from '../../src/supervisor/worktree.ts';
import { createApp } from '../../src/server.ts';

async function freePort(){const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port;await new Promise<void>(r=>server.close(()=>r()));return port;}
async function stop(child:ChildProcess){if(child.exitCode!==null)return;child.kill('SIGTERM');await Promise.race([once(child,'exit'),delay(3000).then(()=>{if(child.exitCode===null)child.kill('SIGKILL');})]);}

test('Arena mode with real OpenCode: generated config, session binding, local tools, review and terminal quota',{timeout:90000},async()=>{
  const f=await repoFixture();const seen:{session:string;model:string;maxTokens:number}[]=[];let child:ChildProcess|undefined;let logs='';
  const uuid=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
  const bridge=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer fixture-bridge-key');
    let raw='';for await(const chunk of req)raw+=chunk;
    const request=JSON.parse(raw),session=String(req.headers['x-codex-session-id'] ?? '');
    seen.push({session,model:request.model,maxTokens:request.max_tokens});
    if(request.model===uuid(3)){res.writeHead(429);res.end();return;}
    const messages=request.messages as any[];const lastUser=messages.findLastIndex(m=>m.role==='user');
    const results=messages.slice(lastUser+1).filter(m=>m.role==='tool');
    res.writeHead(200,{'content-type':'text/event-stream'});
    const chunk=(delta:unknown,finish:string|null=null)=>res.write(`data: ${JSON.stringify({id:'chatcmpl-arena-fixture',object:'chat.completion.chunk',created:1,model:request.model,choices:[{index:0,delta,finish_reason:finish}]})}\n\n`);
    const reviewer=request.model===uuid(2);
    if(!results.length){
      const name=reviewer?'read':'bash';
      const args=reviewer?{filePath:'proof.txt'}:{command:"printf 'verified\\n' > proof.txt",description:'Write local proof'};
      chunk({role:'assistant',tool_calls:[{index:0,id:reviewer?'call_review':'call_write',type:'function',function:{name,arguments:JSON.stringify(args)}}]});chunk({},'tool_calls');
    }else{
      const text=reviewer?JSON.stringify({approved:JSON.stringify(results).includes('verified'),findings:[]}):'Wrote proof.txt through the local tool';
      chunk({role:'assistant',content:text});chunk({},'stop');
    }
    res.end('data: [DONE]\n\n');
  });
  bridge.listen(0,'127.0.0.1');await once(bridge,'listening');
  const runtimePort=await freePort(),password='arena-runtime-fixture-password';
  const runtime=new OpenCodeRuntime(`http://127.0.0.1:${runtimePort}`,password);
  const store=new Store(join(f.root,'state.db'));const orch=new Orchestrator(store,runtime,new GitWorktrees(join(f.root,'trees')),1);
  const arena=new ArenaAgentAdapter(`http://127.0.0.1:${(bridge.address() as {port:number}).port}/v1`,'fixture-bridge-key',join(f.root,'bindings.json'));
  const router=new ModelRouter({retries:0,allowSimulatedTools:true,concurrency:1,record:r=>store.record(r)});
  for(const model of ['lead','sidekick','reviewer'])router.register(model,{adapter:arena,model});
  const key='arena-gateway-fixture-key';const gateway=createApp({key,router,store,orchestrator:orch,runtime,arena});gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
  const port=(gateway.address() as {port:number}).port;
  async function post(path:string,body:unknown){const response=await fetch(`http://127.0.0.1:${port}${path}`,{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});const result=await response.json() as any;assert.ok(response.ok,JSON.stringify(result));return result;}
  try{
    const state=join(f.root,'runtime');const configPath=await runtimeConfig(resolve('config/opencode.json'),state,{COAGENT_MODE:'arena',COAGENT_PORT:String(port)});
    const config=JSON.parse(await readFile(configPath,'utf8'));
    // Only this isolated fixture allows the fixed shell command without interaction.
    config.agent.sidekick.permission.bash='allow';await writeFile(configPath,JSON.stringify(config));
    const env=await runtimeEnvironment(state,configPath,{...process.env,COAGENT_API_KEY:key,OPENCODE_SERVER_PASSWORD:password});
    for(const name of ['OPENAI_API_KEY','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'])delete env[name];
    child=spawn(resolve('node_modules/.bin/opencode'),['serve','--hostname','127.0.0.1','--port',String(runtimePort)],{cwd:f.repo,env,stdio:['ignore','pipe','pipe']});
    child.stdout?.on('data',data=>logs+=data);child.stderr?.on('data',data=>logs+=data);
    let ready=false;for(let i=0;i<300;i++){if(child.exitCode!==null)throw new Error(logs.slice(-1000));try{await runtime.health();ready=true;break;}catch{await delay(100);}}assert.ok(ready,'Runtime startup');
    const argv=[process.execPath,'-e',"require('node:assert').equal(require('node:fs').readFileSync('proof.txt','utf8'),'verified\\n')"];
    await post('/tasks',{id:'arena-proof',repo:f.repo,prompt:'Create proof.txt containing verified and a newline using the local tool.',acceptance:argv});
    const prepared=await post('/tasks/arena-proof/prepare',{});
    await post('/arena/bindings',{sessionID:prepared.worker.runtimeID,arenaSessionID:uuid(1)});
    await post('/arena/bindings',{sessionID:prepared.reviewer.runtimeID,arenaSessionID:uuid(2)});
    await post('/tasks/arena-proof/approve',{});await orch.idle();
    const finished=store.task('arena-proof');assert.equal(finished.status,'succeeded',finished.error ?? '');
    assert.equal(await readFile(join(finished.worktree!,'proof.txt'),'utf8'),'verified\n');
    assert.ok(seen.length>=4);assert.ok(seen.every(turn=>turn.session.startsWith('ses_') && turn.maxTokens<=4096));
    assert.deepEqual(new Set(seen.map(turn=>turn.model)),new Set([uuid(1),uuid(2)]));
    await post('/tasks',{id:'arena-quota',repo:f.repo,prompt:'Do not replay a quota failure',maxAttempts:3,timeoutMs:3000});
    const quota=await post('/tasks/arena-quota/prepare',{});
    await post('/arena/bindings',{sessionID:quota.worker.runtimeID,arenaSessionID:uuid(3)});
    await post('/arena/bindings',{sessionID:quota.reviewer.runtimeID,arenaSessionID:uuid(4)});
    await post('/tasks/arena-quota/approve',{});await orch.idle();await orch.tick();await orch.idle();
    assert.equal(store.task('arena-quota').status,'failed');assert.equal(store.task('arena-quota').attempts,1);
    assert.equal(seen.filter(turn=>turn.model===uuid(3)).length,1,'OpenCode and Supervisor must not replay the quota failure');
    console.log(JSON.stringify({arenaTransport:'local fixture',runtime:'OpenCode 1.19.5',toolsExecuted:true,distinctSessions:true,quotaRequests:1}));
  }finally{
    await orch.close();if(child)await stop(child);gateway.closeAllConnections();bridge.closeAllConnections();
    await Promise.all([new Promise<void>(r=>gateway.close(()=>r())),new Promise<void>(r=>bridge.close(()=>r()))]);store.close();await f.cleanup();
  }
});
