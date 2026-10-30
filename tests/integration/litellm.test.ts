import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../../src/supervisor/store.ts';
import { Orchestrator } from '../../src/supervisor/orchestrator.ts';
import { ModelRouter } from '../../src/gateway/router.ts';
import { MockAdapter, OpenAIAdapter } from '../../src/gateway/adapters.ts';
import { createApp } from '../../src/server.ts';
import { FakeRuntime } from '../helpers.ts';
async function freePort(){const s=createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));return p;}
async function stop(child:ChildProcess){if(child.exitCode!==null)return;child.kill('SIGTERM');await Promise.race([once(child,'exit'),delay(3000).then(()=>{if(child.exitCode===null)child.kill('SIGKILL');})]);}
test('real LiteLLM proxy: Chat, Responses, Messages, streaming and tool-result roundtrip',{timeout:120000},async()=>{
 const executable=resolve('.venv/bin/litellm');await access(executable); // Missing dependency is an explicit failure, never a silent skip.
 const root=await mkdtemp(join(tmpdir(),'coagent-litellm-'));const runtime=new FakeRuntime();const worktrees={async create(){return '/tmp/unused';},async diff(){return '';},async remove(){}};
 const upstreamStore=new Store(':memory:'),upstreamOrch=new Orchestrator(upstreamStore,runtime,worktrees);
 const upstreamRouter=new ModelRouter({retries:0}).register('gpt-4o',{adapter:new MockAdapter(),model:'mock'});
 const generate=upstreamRouter.generate.bind(upstreamRouter);upstreamRouter.generate=async function*(...args){console.log('upstream request',JSON.stringify(args[0]));yield* generate(...args);};
 const upstream=createApp({key:'fixture-upstream-key',store:upstreamStore,orchestrator:upstreamOrch,runtime,router:upstreamRouter});upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const upstreamURL=`http://127.0.0.1:${(upstream.address() as {port:number}).port}/v1`,port=await freePort(),master='sk-fixture-litellm-master-key';
 const config=join(root,'litellm.yaml');await writeFile(config,`model_list:\n  - model_name: test\n    litellm_params:\n      model: openai/gpt-4o\n      api_base: ${upstreamURL}\n      api_key: fixture-upstream-key\n      use_chat_completions_api: true\nlitellm_settings:\n  drop_params: false\nrouter_settings:\n  num_retries: 0\n  timeout: 15\ngeneral_settings:\n  master_key: ${master}\n`);
 const env:NodeJS.ProcessEnv={...process.env,LITELLM_LOCAL_MODEL_COST_MAP:'True',LITELLM_TELEMETRY:'False',LITELLM_USE_CHAT_COMPLETIONS_URL_FOR_ANTHROPIC_MESSAGES:'1'};
 for(const name of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy','DATABASE_URL'])delete env[name];env.NO_PROXY='127.0.0.1,localhost';
 let logs='';const child=spawn(executable,['--config',config,'--host','127.0.0.1','--port',String(port)],{env,stdio:['ignore','pipe','pipe']});child.stdout?.on('data',d=>logs+=d);child.stderr?.on('data',d=>logs+=d);
 const store=new Store(':memory:'),orch=new Orchestrator(store,runtime,worktrees);const litellmURL=`http://127.0.0.1:${port}/v1`;
 const router=new ModelRouter({retries:0}).register('test',{adapter:new OpenAIAdapter('litellm',litellmURL,master),model:'test'});
 const front=createApp({key:'fixture-front-key',store,orchestrator:orch,runtime,router,litellm:{url:litellmURL,key:master}});front.listen(0,'127.0.0.1');await once(front,'listening');const frontURL=`http://127.0.0.1:${(front.address() as {port:number}).port}`;
 async function post(path:string,body:unknown){const r=await fetch(frontURL+path,{method:'POST',headers:{authorization:'Bearer fixture-front-key','content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});const text=await r.text();assert.equal(r.status,200,text);return text;}
 try{
  let ready=false;for(let i=0;i<600;i++){if(child.exitCode!==null)throw new Error(`LiteLLM startup failed: ${logs.slice(-3000)}`);try{const r=await fetch(`http://127.0.0.1:${port}/health/liveliness`,{signal:AbortSignal.timeout(500)});if(r.ok){ready=true;break;}}catch{}await delay(100);}assert.ok(ready,logs.slice(-3000));
  const chat={model:'test',messages:[{role:'user',content:'中文协议验证'}]};assert.match(JSON.parse(await post('/v1/chat/completions',chat)).choices[0].message.content,/中文协议验证/);
  assert.match(await post('/v1/chat/completions',{...chat,stream:true}),/\[DONE\]/);
  const response=JSON.parse(await post('/v1/responses',{model:'test',input:'中文响应验证'}));assert.equal(response.object,'response');assert.match(JSON.stringify(response.output),/中文响应验证/);
  assert.match(await post('/v1/responses',{model:'test',input:'stream',stream:true}),/response.completed/);
  const messages={model:'test',max_tokens:128,messages:[{role:'user',content:'中文消息验证'}]};const message=JSON.parse(await post('/v1/messages',messages));console.log('anthropic result',JSON.stringify(message));assert.equal(message.type,'message');assert.match(JSON.stringify(message.content),/中文消息验证/);
  assert.match(await post('/v1/messages',{...messages,stream:true}),/message_stop/);
  const tools=[{name:'echo',description:'echo text',input_schema:{type:'object',properties:{text:{type:'string'}},required:['text']}}];
  const toolResponse=JSON.parse(await post('/v1/messages',{model:'test',max_tokens:128,messages:[{role:'user',content:'TOOL:hello'}],tools}));
  assert.equal(toolResponse.stop_reason,'tool_use');const call=toolResponse.content.find((p:any)=>p.type==='tool_use');assert.equal(call.input.text,'hello');
  const final=JSON.parse(await post('/v1/messages',{model:'test',max_tokens:128,tools,messages:[{role:'user',content:'TOOL:hello'},{role:'assistant',content:toolResponse.content},{role:'user',content:[{type:'tool_result',tool_use_id:call.id,content:'hello'}]}]}));assert.equal(final.stop_reason,'end_turn');assert.match(JSON.stringify(final.content),/hello/);
  console.log(JSON.stringify({litellm:'1.106.6',protocols:['chat','responses','messages'],streaming:true,toolRoundtrip:true}));
 }catch(e){console.log(logs.slice(-5000));throw e;}finally{await orch.close();await upstreamOrch.close();await stop(child);front.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise<void>(r=>front.close(()=>r())),new Promise<void>(r=>upstream.close(()=>r()))]);store.close();upstreamStore.close();await rm(root,{recursive:true,force:true});}
});
