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
