import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/supervisor/store.ts';
import { Orchestrator } from '../src/supervisor/orchestrator.ts';
import { ModelRouter } from '../src/gateway/router.ts';
import { ArenaAgentAdapter, MockAdapter, OpenAIAdapter } from '../src/gateway/adapters.ts';
import { createApp } from '../src/server.ts';
import { parseSSE } from '../src/gateway/protocol.ts';
import { FakeRuntime } from './helpers.ts';
const key='test-key-for-coagent-only';
async function setup(arena?:ArenaAgentAdapter){const store=new Store(':memory:');const runtime=new FakeRuntime();const orch=new Orchestrator(store,runtime,{async create(){return '/tmp/fake';},async diff(){return '';},async remove(){}});const router=new ModelRouter({retries:0,record:r=>store.record(r)}).register('mock',{adapter:new MockAdapter(),model:'mock'});const server=createApp({key,router,store,orchestrator:orch,runtime,arena});server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;return {store,router,url,request:(path:string,body?:unknown)=>fetch(url+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),close:async()=>{await orch.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();}};}
test('HTTP auth, chat, SSE, native tool roundtrip, metrics and bad input',async()=>{const s=await setup();try{assert.equal((await fetch(s.url+'/tasks')).status,401);const body={model:'mock',messages:[{role:'user',content:'中文'}]};let r=await s.request('/v1/chat/completions',body);assert.equal(r.status,200);assert.equal((await r.json() as any).choices[0].message.content,'mock: 中文');r=await s.request('/v1/chat/completions',{...body,stream:true});const frames=await Array.fromAsync(parseSSE(r.body!));assert.equal(frames.at(-1)!.data,'[DONE]');const tool={type:'function',function:{name:'echo',parameters:{type:'object',properties:{text:{type:'string'}},required:['text']}}};r=await s.request('/v1/chat/completions',{model:'mock',messages:[{role:'user',content:'TOOL:hello'}],tools:[tool]});const completion=await r.json() as any;assert.equal(completion.choices[0].finish_reason,'tool_calls');const assistant=completion.choices[0].message;r=await s.request('/v1/chat/completions',{model:'mock',messages:[{role:'user',content:'TOOL:hello'},assistant,{role:'tool',tool_call_id:assistant.tool_calls[0].id,content:'hello'}]});assert.equal((await r.json() as any).choices[0].message.content,'mock: hello');assert.equal((await s.request('/v1/chat/completions',{model:'mock',messages:[]})).status,400);assert.ok((await s.request('/metrics').then(r=>r.json()) as any[]).length);}finally{await s.close();}});
test('HTTP adapter consumes actual SSE, stream errors omit DONE',async()=>{const s=await setup();try{const adapter=new OpenAIAdapter('loop',s.url+'/v1',key);const events=await Array.fromAsync(adapter.generate({model:'mock',messages:[{role:'user',content:'中文'}]},AbortSignal.timeout(2000)));assert.equal(events.filter(x=>x.type==='text').map(x=>x.text).join(''),'mock: 中文');const r=await s.request('/v1/chat/completions',{model:'mock',messages:[{role:'user',content:'FAULT:stream'}],stream:true});const text=await r.text();assert.match(text,/event: error/);assert.doesNotMatch(text,/\[DONE\]/);}finally{await s.close();}});
test('HTTP task approval and durable event cursor',async()=>{const s=await setup();try{let r=await s.request('/tasks',{id:'task',prompt:'do work',repo:'/tmp'});assert.equal(r.status,201);assert.equal((await r.json() as any[])[0].status,'awaiting_approval');r=await s.request('/tasks/task/approve',{});assert.equal(r.status,200);r=await s.request('/events?after=1');const reader=r.body!.getReader();const first=new TextDecoder().decode((await reader.read()).value);assert.match(first,/id: 2/);await reader.cancel();}finally{await s.close();}});
test('OpenAI adapter rejects JSON in SSE endpoint and missing DONE',async()=>{const server=createServer((req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":"stop"}]}\n\n');});server.listen(0,'127.0.0.1');await once(server,'listening');try{const adapter=new OpenAIAdapter('bad',`http://127.0.0.1:${(server.address() as {port:number}).port}`,'');await assert.rejects(Array.fromAsync(adapter.generate({model:'x',messages:[{role:'user',content:'x'}]},AbortSignal.timeout(1000))),/without completion/);}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}});
test('Arena binding API requires prepared sessions and preserves distinct concurrent bindings',async()=>{
 const root=await mkdtemp(join(tmpdir(),'coagent-bind-'));const path=join(root,'nested','bindings.json');
 const arena=new ArenaAgentAdapter('http://127.0.0.1:1/v1','unused',path);const s=await setup(arena);
 const workerUUID='ABCDEFAB-0000-0000-0000-000000000001',reviewerUUID='abcdefab-0000-0000-0000-000000000002';
 try{
  assert.equal((await s.request('/arena/bindings',{sessionID:'ses_missing',arenaSessionID:workerUUID})).status,404);
  await s.request('/tasks',{id:'bind',prompt:'Work',repo:'/tmp'});const prepared=await s.request('/tasks/bind/prepare',{}).then(r=>r.json()) as any;
  const responses=await Promise.all([
   s.request('/arena/bindings',{sessionID:prepared.worker.runtimeID,arenaSessionID:workerUUID}),
   s.request('/arena/bindings',{sessionID:prepared.reviewer.runtimeID,arenaSessionID:reviewerUUID})
  ]);assert.deepEqual(responses.map(r=>r.status),[200,200]);
  const bindings=JSON.parse(await readFile(path,'utf8'));assert.equal(bindings[prepared.worker.runtimeID],workerUUID.toLowerCase());assert.equal(bindings[prepared.reviewer.runtimeID],reviewerUUID);
  assert.equal((await s.request('/arena/bindings',{sessionID:prepared.reviewer.runtimeID,arenaSessionID:workerUUID.toLowerCase()})).status,409);
  assert.deepEqual(JSON.parse(await readFile(path,'utf8')),bindings);
 }finally{await s.close();await rm(root,{recursive:true,force:true});}
});
