import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArenaAgentAdapter } from '../src/gateway/adapters.ts';
import { ModelRouter } from '../src/gateway/router.ts';
import type { ModelRequest } from '../src/types.ts';
test('Arena session binding, opt-in simulated tools, quota propagation and no shared session',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'coagent-arena-'));const bindings=join(dir,'bindings.json');const target='00000000-0000-0000-0000-000000000001';let count=0;let rateLimited=false;let observed:any;
 const server=createServer(async(req,res)=>{count++;let text='';for await(const c of req)text+=c;observed={body:JSON.parse(text),session:req.headers['x-codex-session-id']};if(rateLimited){res.writeHead(429);res.end();return;}res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{index:0,delta:{tool_calls:[{index:0,id:'call_1',type:'function',function:{name:'echo',arguments:'{"text":"ok"}'}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`);});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const adapter=new ArenaAgentAdapter(`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,'local-key',bindings);
 const router=new ModelRouter({allowSimulatedTools:true,retries:0,concurrency:1}).register('sidekick',{adapter,model:'unused'});
 const request:ModelRequest={model:'sidekick',messages:[{role:'user',content:'hello'}],tools:[{type:'function',function:{name:'echo',parameters:{type:'object',properties:{text:{type:'string'}},required:['text']}}}],_coagentSession:'ses_one'};
 try {
  assert.equal(adapter.capabilities.tools,'simulated');await assert.rejects(Array.fromAsync(router.generate(request,AbortSignal.timeout(1000))),/bindings file/);assert.equal(count,0);
  await writeFile(bindings,JSON.stringify({ses_one:target}));const events=await Array.fromAsync(router.generate(request,AbortSignal.timeout(1000)));assert.ok(events.some(e=>e.type==='tool'));assert.equal(observed.body.model,target);assert.equal(observed.session,'ses_one');assert.equal(observed.body._coagentSession,undefined);
  const denied=new ModelRouter().register('sidekick',{adapter,model:'unused'});await assert.rejects(Array.fromAsync(denied.generate(request,AbortSignal.timeout(1000))),/native tools/);
  await writeFile(bindings,JSON.stringify({ses_one:target,ses_two:target}));await assert.rejects(Array.fromAsync(router.generate(request,AbortSignal.timeout(1000))),/distinct Arena session/);
  await writeFile(bindings,JSON.stringify({ses_one:target}));rateLimited=true;await assert.rejects(Array.fromAsync(router.generate(request,AbortSignal.timeout(1000))),{status:422,code:'arena_quota_exhausted'});assert.equal(count,2,'no retry after quota failure');
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});
test('UUID text bridge receives full local tool context and returns validated calls and tool results',async()=>{
 const root=await mkdtemp(join(tmpdir(),'coagent-arena-text-'));const bindings=join(root,'bindings.json');
 const target='00000000-0000-0000-0000-000000000011';await writeFile(bindings,JSON.stringify({ses_text:target}));
 const requests:any[]=[];let reply:string|((request:any)=>string)='<coagent_tool_call>{"name":"echo","arguments":{"text":"local result"}}</coagent_tool_call>';
 const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const request=JSON.parse(raw);requests.push(request);const content=typeof reply==='function'?reply(request):reply;res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{index:0,delta:{content},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const arena=new ArenaAgentAdapter(`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,'fixture',bindings);
 const router=new ModelRouter({retries:0,allowSimulatedTools:true}).register('sidekick',{adapter:arena,model:'sidekick'});
 const request:ModelRequest={model:'sidekick',_coagentSession:'ses_text',messages:[{role:'system',content:'Use local tools'},{role:'user',content:'Read the local file'}],tools:[{type:'function',function:{name:'echo',parameters:{type:'object',properties:{text:{type:'string'}},required:['text']}}}]};
 try{
  const first=await Array.fromAsync(router.generate(request,AbortSignal.timeout(2000)));const call=first.find(e=>e.type==='tool');assert.ok(call?.type==='tool');assert.equal(call.name,'echo');assert.deepEqual(JSON.parse(call.arguments!),{text:'local result'});assert.ok(first.some(e=>e.type==='finish' && e.reason==='tool_calls'));
  const wire=requests[0];assert.equal(wire.messages.length,1);assert.equal(wire.messages[0].role,'user');assert.match(wire.messages[0].content,/Use local tools/);assert.match(wire.messages[0].content,/"required":\["text"\]/);
  reply='completed';const messages=[...request.messages,{role:'assistant' as const,content:null,tool_calls:[{id:call.id!,type:'function' as const,function:{name:call.name!,arguments:call.arguments!}}]},{role:'tool' as const,tool_call_id:call.id!,content:'authoritative local result'}];
  const second=await Array.fromAsync(router.generate({...request,messages},AbortSignal.timeout(2000)));assert.ok(second.some(e=>e.type==='text' && e.text==='completed'));assert.match(requests[1].messages[0].content,/authoritative local result/);assert.match(requests[1].messages[0].content,/tool_call_id/);
  reply='<coagent_tool_call>{"name":"echo","arguments":{"text":false}}</coagent_tool_call>';await assert.rejects(Array.fromAsync(router.generate(request,AbortSignal.timeout(2000))),{status:422,code:'protocol_error'});
  reply='example: <coagent_tool_call>{"name":"echo","arguments":{}}</coagent_tool_call>';await assert.rejects(Array.fromAsync(router.generate(request,AbortSignal.timeout(2000))),{code:'arena_tool_protocol_error'});
  reply=wire=>{const requestID=wire.messages[0].content.match(/"request_id":"([^"]+)"/)[1];return 'Reading the file.\n<coagent_tool_call>'+JSON.stringify({request_id:requestID,name:'echo',arguments:{text:'nonce verified'}})+'</coagent_tool_call>';};
  const withExplanation=await Array.fromAsync(router.generate(request,AbortSignal.timeout(2000)));assert.ok(withExplanation.some(e=>e.type==='tool'));assert.ok(!withExplanation.some(e=>e.type==='text'));
  reply='<coagent_tool_call>{"request_id":"stale","name":"echo","arguments":{"text":"wrong turn"}}</coagent_tool_call>';await assert.rejects(Array.fromAsync(router.generate(request,AbortSignal.timeout(2000))),{code:'arena_tool_protocol_error'});
  reply=wire=>{const requestID=wire.messages[0].content.match(/"request_id":"([^"]+)"/)[1];return 'Independent review completed.\n<coagent_final>'+JSON.stringify({request_id:requestID,content:{approved:true,findings:[]}})+'</coagent_final>';};
  const review=await Array.fromAsync(router.generate(request,AbortSignal.timeout(2000)));const verdict=review.find(e=>e.type==='text');assert.ok(verdict?.type==='text');assert.deepEqual(JSON.parse(verdict.text),{approved:true,findings:[]});
  reply='<coagent_final>{"request_id":"stale","content":{"approved":true,"findings":[]}}</coagent_final>';await assert.rejects(Array.fromAsync(router.generate(request,AbortSignal.timeout(2000))),{code:'arena_tool_protocol_error'});
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});}
});
