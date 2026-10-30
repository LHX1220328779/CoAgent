import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { repoFixture } from '../helpers.ts';
import { runtimeEnvironment } from '../../src/runtime/environment.ts';
import { OpenCodeRuntime } from '../../src/runtime/opencode.ts';
import { Store } from '../../src/supervisor/store.ts';
import { Orchestrator, taskFromInput } from '../../src/supervisor/orchestrator.ts';
import { GitWorktrees } from '../../src/supervisor/worktree.ts';
import { ModelRouter } from '../../src/gateway/router.ts';
import { OpenAIAdapter } from '../../src/gateway/adapters.ts';
import { createApp } from '../../src/server.ts';
async function freePort(){const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const p=(server.address() as {port:number}).port;await new Promise<void>(r=>server.close(()=>r()));return p;}
async function kill(child:ChildProcess){if(child.exitCode!==null)return;child.kill('SIGTERM');await Promise.race([once(child,'exit'),delay(5000).then(()=>{if(child.exitCode===null)child.kill('SIGKILL');})]);}
test('real OpenCode 1.19.5: provider, native tool, subagent route, SSE, persistent session and model switch',{timeout:180000},async()=>{
  const f=await repoFixture();const seen:any[]=[];let child:ChildProcess|undefined;let logs='';const eventsController=new AbortController();let listening=Promise.resolve();
  const upstream=createServer(async(req,res)=>{
    if(req.url?.endsWith('/models')){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({object:'list',data:[]}));return;}
    const chunks:Buffer[]=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks).toString());seen.push({...body,sessionHeader:req.headers['x-codex-session-id']});
    const messages=body.messages ?? [];const lastUser=[...messages].reverse().find((m:any)=>m.role==='user');
    const content=typeof lastUser?.content==='string'?lastUser.content:JSON.stringify(lastUser?.content ?? '');
    const lastUserIndex=messages.lastIndexOf(lastUser);const results=messages.slice(lastUserIndex+1).filter((m:any)=>m.role==='tool');
    if(content.includes('COAGENT_DELAY')){await new Promise<void>(r=>{const timer=setTimeout(r,30000);res.once('close',()=>{clearTimeout(timer);r();});});if(res.destroyed)return;}
    const toolNames=(body.tools ?? []).map((t:any)=>t.function.name);
    const emit=(delta:unknown,reason:string|null=null)=>res.write(`data: ${JSON.stringify({id:'chatcmpl-fixture',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason:reason}]})}\n\n`);
    res.writeHead(200,{'content-type':'text/event-stream'});
    if(body.model==='reviewer' && !results.length && toolNames.includes('read')){
      emit({role:'assistant',tool_calls:[{index:0,id:'call_review',type:'function',function:{name:'read',arguments:JSON.stringify({filePath:'proof.txt'})}}]});emit({},'tool_calls');
    }else if(body.model==='reviewer'){emit({role:'assistant',content:JSON.stringify({approved:JSON.stringify(results).includes('verified'),findings:[]})});emit({},'stop');
    }else if(content.includes('COAGENT_WRITE') && !results.length && toolNames.includes('bash')){
      emit({role:'assistant',tool_calls:[{index:0,id:'call_write',type:'function',function:{name:'bash',arguments:JSON.stringify({command:"printf 'verified\\n' > proof.txt",description:'Create integration proof'})}}]});emit({},'tool_calls');
    }else if(content.includes('COAGENT_DELEGATE') && !results.length && toolNames.includes('task')){
      emit({role:'assistant',tool_calls:[{index:0,id:'call_delegate',type:'function',function:{name:'task',arguments:JSON.stringify({description:'Verify subagent route',prompt:'COAGENT_CHILD reply child-ok',subagent_type:'sidekick'})}}]});emit({},'tool_calls');
    }else{emit({role:'assistant',content:content.includes('COAGENT_CHILD')?'child-ok':content.includes('COAGENT_RECALL') && JSON.stringify(messages).includes('COAGENT_WRITE')?'history-preserved':'fixture-ok'});emit({},'stop');}
    res.write(`data: ${JSON.stringify({id:'chatcmpl-fixture',object:'chat.completion.chunk',created:1,model:body.model,choices:[],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})}\n\n`);res.end('data: [DONE]\n\n');
  });
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const port=await freePort(),password='integration-only-password';const base=`http://127.0.0.1:${(upstream.address() as {port:number}).port}/v1`;
  const runtime=new OpenCodeRuntime(`http://127.0.0.1:${port}`,password);
  const store=new Store(join(f.root,'supervisor.db'));const orch=new Orchestrator(store,runtime,new GitWorktrees(join(f.root,'trees')),2);
  const router=new ModelRouter({retries:0,record:r=>store.record(r)});const adapter=new OpenAIAdapter('fixture',base,'fixture');for(const model of ['lead','sidekick','reviewer'])router.register(model,{adapter,model});
  const generate=router.generate.bind(router);router.generate=async function*(...args){try{yield* generate(...args);}catch(e){console.log('gateway failure',e);throw e;}};
  const gateway=createApp({key:'integration-gateway-key',router,store,orchestrator:orch,runtime});gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
  const gatewayBase=`http://127.0.0.1:${(gateway.address() as {port:number}).port}/v1`;
  const config={plugin:[pathToFileURL(resolve('src/runtime/session-plugin.ts')).href],model:'coagent/lead',small_model:'coagent/sidekick',enabled_providers:['coagent'],provider:{coagent:{npm:'@ai-sdk/openai-compatible',options:{baseURL:gatewayBase,apiKey:'integration-gateway-key'},models:{lead:{name:'Lead',limit:{context:128000,output:8192}},sidekick:{name:'Worker',limit:{context:128000,output:8192}},reviewer:{name:'Reviewer',limit:{context:128000,output:8192}}}}},agent:{lead:{mode:'primary',model:'coagent/lead'},sidekick:{mode:'all',model:'coagent/sidekick'},reviewer:{mode:'all',model:'coagent/reviewer',permission:{bash:'deny',edit:'deny',task:'deny'}}},permission:{'*':'deny',bash:'allow',read:'allow',task:'allow'},share:'disabled',autoupdate:false};
  const configPath=join(f.root,'opencode.json');await writeFile(configPath,JSON.stringify(config));await mkdir(join(f.root,'config'));
  const env=await runtimeEnvironment(f.root,configPath,{...process.env,OPENCODE_SERVER_PASSWORD:password});
  for(const name of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'])delete env[name];
  delete env.OPENAI_API_KEY; // A missing OpenAI key must never trigger fallback to a different provider.
  async function start(){const c=spawn(resolve('node_modules/.bin/opencode'),['serve','--hostname','127.0.0.1','--port',String(port)],{cwd:f.repo,env,stdio:['ignore','pipe','pipe']});c.stdout?.on('data',d=>logs+=d);c.stderr?.on('data',d=>logs+=d);for(let i=0;i<400;i++){if(c.exitCode!==null)throw new Error(`OpenCode exited: ${logs.slice(-4000)}`);try{await runtime.health();return c;}catch{await delay(100);}}await kill(c);throw new Error(`OpenCode did not start: ${logs.slice(-4000)}`);}
  try{
    child=await start();console.log('runtime started');const model={providerID:'coagent',modelID:'lead'};const session=await runtime.create('lead',f.repo,model);
    const events:unknown[]=[];listening=(async()=>{try{for await(const e of runtime.events(f.repo,eventsController.signal)){events.push(e);}}catch(e){if(!eventsController.signal.aborted)console.log('event stream disconnected');}})();
    const first=await runtime.prompt(session,'lead',f.repo,model,'COAGENT_WRITE use the bash tool to create proof.txt',AbortSignal.timeout(60000));
    assert.equal(await readFile(join(f.repo,'proof.txt'),'utf8'),'verified\n');
    const toolHistory=await runtime.request(`/session/${session}/message`,f.repo).then(r=>r.json()) as any[];
    assert.ok(toolHistory.flatMap(m=>m.parts).some((p:any)=>p.type==='tool' && p.tool==='bash' && p.state.status==='completed')); 
    await runtime.prompt(session,'lead',f.repo,model,'COAGENT_DELEGATE use task to call sidekick',AbortSignal.timeout(60000));
    assert.ok(seen.some(r=>r.model==='sidekick'),'subagent must reach sidekick model');
    assert.ok(seen.every(r=>['lead','sidekick'].includes(r.model)));
    assert.ok(seen.every(r=>typeof r.sessionHeader==='string' && r.sessionHeader.startsWith('ses_')),'plugin must attach real session IDs');
    const children=await runtime.request(`/session/${session}/children`,f.repo).then(r=>r.json()) as any[];assert.ok(children.length>=1);
    eventsController.abort();await listening;assert.ok(events.length>1,'SSE events emitted');
    await kill(child);child=await start();
    const history=await runtime.request(`/session/${session}/message`,f.repo).then(r=>r.json()) as any[];assert.ok(history.length>=4);
    const recalled=await runtime.prompt(session,'lead',f.repo,{providerID:'coagent',modelID:'sidekick'},'COAGENT_RECALL preserve previous history',AbortSignal.timeout(60000));
    assert.match(recalled.text,/history-preserved/);assert.equal(seen.at(-1).model,'sidekick');
    const cancelSession=await runtime.create('lead',f.repo,model);
    await assert.rejects(runtime.prompt(cancelSession,'lead',f.repo,model,'COAGENT_DELAY',AbortSignal.timeout(300)));
    const statuses=await runtime.request('/session/status',f.repo).then(r=>r.json()) as Record<string,{type:string}>;assert.ok(!statuses[cancelSession] || statuses[cancelSession].type==='idle');
    store.add(['e2e-a','e2e-b'].map(id=>taskFromInput({id,prompt:'COAGENT_WRITE create proof.txt',repo:f.repo,requiresApproval:true,acceptance:[process.execPath,'-e',"require('node:assert').equal(require('node:fs').readFileSync('proof.txt','utf8'),'verified\\n')"]})));
    await orch.tick();for(const id of ['e2e-a','e2e-b'])orch.approve(id);await orch.tick();await orch.idle();
    assert.deepEqual(store.tasks().map(t=>[t.id,t.status,t.error]),[['e2e-a','succeeded',null],['e2e-b','succeeded',null]]);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM sessions').get()!.count,4);
    console.log(JSON.stringify({opencode:'1.19.5',providerRequests:seen.length,childSessions:children.length,events:events.length,toolExecuted:true,restarted:true}));
  }catch(error){console.log('failure logs',logs.slice(-2000));console.log('fixture path',f.root);try{console.log((await readFile(join(f.root,'data/opencode/log/opencode.log'),'utf8')).slice(-5000));}catch{}throw error;}finally{eventsController.abort();await listening;await orch.close();gateway.closeAllConnections();await new Promise<void>(r=>gateway.close(()=>r()));store.close();if(child)await kill(child);upstream.closeAllConnections();await new Promise<void>(r=>upstream.close(()=>r()));await f.cleanup();}
});
