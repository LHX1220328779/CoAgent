import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
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
import {ArenaPool} from '../../src/arena/pool.ts';
import {LocalServices} from '../../src/desktop/services.ts';
import {createConsole} from '../../src/desktop/server.ts';
import {ConsoleBackend} from '../../src/acp/backend.ts';
import {acpClient} from '../acp-client.ts';

async function freePort(){const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port;await new Promise<void>(r=>server.close(()=>r()));return port;}
async function stop(child:ChildProcess){if(child.exitCode!==null)return;child.kill('SIGTERM');await Promise.race([once(child,'exit'),delay(3000).then(()=>{if(child.exitCode===null)child.kill('SIGKILL');})]);}

test('Arena mode with real OpenCode: generated config, session binding, local tools, review and terminal quota',{timeout:90000},async()=>{
  const f=await repoFixture();const seen:{session:string;model:string;maxTokens:number}[]=[];const turns=new Map<string,number>(),contexts=new Map<string,any[]>();let child:ChildProcess|undefined;let logs='';let consoleServer:ReturnType<typeof createConsole>|undefined;
  const uuid=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
  const bridge=createServer(async(req,res)=>{
    if(req.url==='/health'){res.setHeader('content-type','application/json');res.end(JSON.stringify({ready:true,accounts:[]}));return;}
    assert.equal(req.headers.authorization,'Bearer fixture-bridge-key');
    if(req.method==='GET'&&req.url==='/coagent/login/status'){res.setHeader('content-type','application/json');res.end(JSON.stringify({pending:[]}));return;}
    if(req.url==='/coagent/sessions'){res.setHeader('content-type','application/json');res.end(JSON.stringify({accounts:[{email:'a@example.invalid',available:true},{email:'b@example.invalid',available:true}],sessions:[1,2,3,4].map(n=>({id:uuid(n),title:`原有会话标题 ${n} · 中文`,accountEmail:n%2?'a@example.invalid':'b@example.invalid',available:true})),syncedAt:Date.now()}));return;}
    let raw='';for await(const chunk of req)raw+=chunk;
    const request=JSON.parse(raw),session=String(req.headers['x-codex-session-id'] ?? '');
    seen.push({session,model:request.model,maxTokens:request.max_tokens});
    if(request.model===uuid(3)){res.writeHead(429);res.end();return;}
    // Match the real bridge's UUID path: it reads only the last user text and
    // returns text, without interpreting tools or converting XML to tool_calls.
    const prompt=request.messages.at(-1).content as string;
    assert.equal(request.messages.length,1);assert.match(prompt,/"tools":/);
    const context=JSON.parse(prompt.split('OpenCode request JSON:\n')[1]);assert.equal(context.context.session_id,session);const canonical=context.context.kind==='append'?[...(contexts.get(session)??[]),...context.messages]:context.messages;contexts.set(session,canonical);const effectivePrompt=JSON.stringify(canonical);
    const turn=(turns.get(session) ?? 0)+1;turns.set(session,turn);
    res.writeHead(200,{'content-type':'text/event-stream'});
    const chunk=(delta:unknown,finish:string|null=null)=>res.write(`data: ${JSON.stringify({id:'chatcmpl-arena-fixture',object:'chat.completion.chunk',created:1,model:request.model,choices:[{index:0,delta,finish_reason:finish}]})}\n\n`);
    const reviewer=request.model===uuid(2);
    if(turn===1){
      const name=reviewer?'read':'bash';
      const args=reviewer?{filePath:'proof.txt'}:{command:"printf 'verified\\n' > proof.txt",description:'Write local proof'};
      const requestID=prompt.match(/"request_id":"([^"]+)"/)![1];
      chunk({role:'assistant',content:`Requesting the local tool.\n<coagent_tool_call>${JSON.stringify({request_id:requestID,name,arguments:args})}</coagent_tool_call>`});chunk({},'stop');
    }else{
      assert.match(effectivePrompt,/tool_call_id/);
      const text=reviewer?JSON.stringify({approved:effectivePrompt.includes('1: verified'),findings:[]}):'Wrote proof.txt through the local tool';
      const requestID=prompt.match(/"request_id":"([^"]+)"/)![1];chunk({role:'assistant',content:'<coagent_final>'+JSON.stringify({request_id:requestID,content:text})+'</coagent_final>'});chunk({},'stop');
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
  const pool=new ArenaPool(store,arena);
  const key='arena-gateway-fixture-key';const gateway=createApp({key,router,store,orchestrator:orch,runtime,arena,pool});gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
  const port=(gateway.address() as {port:number}).port;
  async function post(path:string,body:unknown){const response=await fetch(`http://127.0.0.1:${port}${path}`,{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});const result=await response.json() as any;assert.ok(response.ok,JSON.stringify(result));return result;}
  try{
    const state=join(f.root,'runtime');const configPath=await runtimeConfig(resolve('config/opencode.json'),state,{COAGENT_MODE:'arena',COAGENT_PORT:String(port)});
    const config=JSON.parse(await readFile(configPath,'utf8'));
    config.agent.sidekick.permission.bash='ask';await writeFile(configPath,JSON.stringify(config));
    const env=await runtimeEnvironment(state,configPath,{...process.env,COAGENT_API_KEY:key,OPENCODE_SERVER_PASSWORD:password});
    for(const name of ['OPENAI_API_KEY','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'])delete env[name];
    child=spawn(resolve('node_modules/.bin/opencode'),['serve','--hostname','127.0.0.1','--port',String(runtimePort)],{cwd:f.repo,env,stdio:['ignore','pipe','pipe']});
    child.stdout?.on('data',data=>logs+=data);child.stderr?.on('data',data=>logs+=data);
    let ready=false;for(let i=0;i<300;i++){if(child.exitCode!==null)throw new Error(logs.slice(-1000));try{await runtime.health();ready=true;break;}catch{await delay(100);}}assert.ok(ready,'Runtime startup');
    const argv=[process.execPath,'-e',"require('node:assert').equal(require('node:fs').readFileSync('proof.txt','utf8'),'verified\\n')"];
    consoleServer=createConsole(new LocalServices(f.root,{COAGENT_MODE:'arena',COAGENT_PORT:String(port),OPENCODE_URL:runtime.url,OPENCODE_SERVER_PASSWORD:password,COAGENT_API_KEY:key,ARENA_BRIDGE_URL:arena.baseURL,ARENA_BRIDGE_KEY:'fixture-bridge-key',ARENA_SESSION_BINDINGS:arena.bindingsPath}));consoleServer.listen(0,'127.0.0.1');await once(consoleServer,'listening');
    const base=`http://127.0.0.1:${(consoleServer.address() as {port:number}).port}`,page=await fetch(base),cookie=page.headers.get('set-cookie')!.split(';')[0];
    async function client(path:string,body?:unknown){const response=await fetch(base+'/api'+path,{method:body===undefined?'GET':'POST',headers:{cookie,'x-coagent-console':'1','content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json() as any;assert.ok(response.ok,JSON.stringify(data));return data;}
    const inventory=await client('/arena/sync',{});assert.equal(inventory.sessions[0].title,'原有会话标题 1 · 中文');
    const project=join(f.root,'plain-client-project');await mkdir(project);
    const created=await client('/tasks',{repo:project,prompt:'Create proof.txt containing verified and a newline using the local tool.',acceptance:argv});const id=created.task.id;assert.equal(created.task.workspaceMode,'direct');
    const prepared=await client(`/tasks/${id}/details`);assert.equal(prepared.sessions.length,2);assert.equal(prepared.sessions[0].title,'原有会话标题 1 · 中文');assert.equal(new Set(prepared.sessions.map((s:any)=>s.accountEmail)).size,2);
    const children=await runtime.request(`/session/${prepared.sessions[0].runtimeID}/children`,project).then(r=>r.json()) as any[];assert.ok(children.some(child=>child.id===prepared.sessions[1].runtimeID),'Reviewer is a native child Agent session');
    await client(`/tasks/${id}/approve`,{});let approvals=0;
    for(let i=0;i<250;i++){const detail=await client(`/tasks/${id}/details`);for(const permission of detail.permissions){assert.equal(permission.command,"printf 'verified\\n' > proof.txt");await client(`/tasks/${id}/permissions/${permission.id}`,{reply:'once'});approvals++;}if(['succeeded','failed'].includes(detail.task.status))break;await delay(100);}
    await orch.idle();assert.equal(approvals,1);const finished=store.task(id);assert.equal(finished.status,'succeeded',finished.error ?? '');
    const details=await client(`/tasks/${id}/details`);assert.ok(details.activity.some((event:any)=>event.type==='tool'&&event.tool==='bash'&&event.status==='completed'));assert.ok(details.activity.some((event:any)=>event.role==='reviewer'&&event.tool==='read'));
    await client(`/tasks/${id}/followup`,{prompt:'确认已有 proof.txt 内容，保持文件不变。'});await orch.idle();assert.equal(store.task(id).status,'succeeded');assert.equal(store.task(id).attempts,2);assert.equal(store.session('sidekick',project,id)!.runtimeID,prepared.sessions[0].runtimeID,'follow-up retains the task context');
    assert.equal(await readFile(join(finished.worktree!,'proof.txt'),'utf8'),'verified\n');
    assert.ok(seen.length>=4);assert.ok(seen.every(turn=>turn.session.startsWith('ses_') && turn.maxTokens<=4096));
    assert.deepEqual(new Set(seen.map(turn=>turn.model)),new Set([uuid(1),uuid(2)]));
    await post('/tasks',{id:'arena-quota',repo:f.repo,prompt:'Do not replay a quota failure',maxAttempts:3,timeoutMs:3000});
    await post('/tasks/arena-quota/prepare',{});
    await post('/tasks/arena-quota/approve',{});await orch.idle();await orch.tick();await orch.idle();
    assert.equal(store.task('arena-quota').status,'failed');assert.equal(store.task('arena-quota').attempts,1);
    assert.equal(seen.filter(turn=>turn.model===uuid(3)).length,1,'OpenCode and Supervisor must not replay the quota failure');
    assert.equal(pool.assignments(id).length,2,'success does not release sessions automatically');await post('/tasks',{id:'next-task',repo:project,workspaceMode:'direct',prompt:'Next task'});
    const exhausted=await fetch(`http://127.0.0.1:${port}/tasks/next-task/prepare`,{method:'POST',headers:{authorization:`Bearer ${key}`}});assert.equal(exhausted.status,409);
    assert.equal(pool.assignments('next-task').length,0,'insufficient resources do not reserve a partial pair');
    await client(`/tasks/${id}/release`,{});await post('/tasks/next-task/assign',{});assert.equal(pool.assignments('next-task').length,2);assert.notEqual(store.session('sidekick',project,'next-task')!.runtimeID,prepared.sessions[0].runtimeID);
    await post('/tasks/next-task/release',{});await post('/tasks/arena-quota/release',{});
    const acpProject=join(f.root,'acp-project');await mkdir(acpProject);const acpState=join(f.root,'acp-sessions');
    const backend=new ConsoleBackend(f.root,{COAGENT_CONSOLE_PORT:String((consoleServer.address() as {port:number}).port)},false);
    let acp=acpClient(backend,acpState);
    try{
      await acp.call('initialize',{protocolVersion:1});const session=await acp.call('session/new',{cwd:acpProject,mcpServers:[]});
      await acp.call('session/prompt',{sessionId:session.sessionId,prompt:[{type:'text',text:'/coagent-acceptance '+JSON.stringify(argv)}]});
      const result=await acp.call('session/prompt',{sessionId:session.sessionId,prompt:[{type:'text',text:'Create proof.txt containing verified and a newline using the local tool.'}]});
      assert.equal(result.stopReason,'end_turn');assert.equal(await readFile(join(acpProject,'proof.txt'),'utf8'),'verified\n');assert.equal(acp.permissions.length,1);assert.equal(acp.permissions[0].toolCall.rawInput.command,"printf 'verified\\n' > proof.txt");
      const metadata=JSON.parse(await readFile(join(acpState,session.sessionId+'.json'),'utf8')),acpTask=store.task(metadata.taskID),worker=store.session('sidekick',acpProject,metadata.taskID)!;assert.equal(acpTask.status,'succeeded');assert.equal(pool.assignments(acpTask.id).length,2);
      assert.ok(acp.updates.some((u:any)=>u.update.title?.startsWith('Reviewer')));assert.ok(acp.updates.some((u:any)=>u.update.content?.text?.includes('原有会话标题')));
      await acp.call('session/prompt',{sessionId:session.sessionId,prompt:[{type:'text',text:'确认已有文件，保持内容不变。'}]});assert.equal(store.task(acpTask.id).status,'succeeded');assert.equal(store.session('sidekick',acpProject,acpTask.id)!.runtimeID,worker.runtimeID);
      await acp.close();acp=acpClient(backend,acpState);await acp.call('initialize',{protocolVersion:1});await acp.call('session/load',{sessionId:session.sessionId,cwd:acpProject,mcpServers:[]});assert.equal((await acp.call('session/list')).sessions.length,1);assert.ok(acp.updates.some((u:any)=>u.update.sessionUpdate==='tool_call'));assert.equal(store.task(acpTask.id).attempts,2,'load does not replay model execution');
      await acp.call('session/prompt',{sessionId:session.sessionId,prompt:[{type:'text',text:'/coagent-release'}]});assert.equal(pool.assignments(acpTask.id).length,0);
      await acp.call('session/prompt',{sessionId:session.sessionId,prompt:[{type:'text',text:'/coagent-assign'}]});assert.equal(pool.assignments(acpTask.id).length,2);await acp.call('session/prompt',{sessionId:session.sessionId,prompt:[{type:'text',text:'/coagent-release'}]});assert.equal(pool.assignments(acpTask.id).length,0);
      console.log(JSON.stringify({acpV1:true,nativeRuntime:'1.19.5',clientWorkflow:'ACP → CoAgent → OpenCode',originalTitles:true,oneTimePermission:true,realFileWrite:true,externalAcceptance:true,followup:true,historyReplay:true,explicitRelease:true,modelUpstream:'fixture'}));
    }finally{await acp.close();}
    console.log(JSON.stringify({arenaTransport:'local fixture',runtime:'OpenCode 1.19.5',clientWorkflow:true,automaticMultiAccountAllocation:true,originalTitles:true,pagePermissionApprovals:approvals,taskExclusiveReuse:true,toolsExecuted:true,quotaRequests:1}));
  }finally{
    await orch.close();if(child)await stop(child);if(consoleServer){consoleServer.closeAllConnections();await new Promise<void>(r=>consoleServer!.close(()=>r()));}gateway.closeAllConnections();bridge.closeAllConnections();
    await Promise.all([new Promise<void>(r=>gateway.close(()=>r())),new Promise<void>(r=>bridge.close(()=>r()))]);store.close();await f.cleanup();
  }
});
