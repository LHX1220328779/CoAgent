import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RuntimeExecutionError } from '../src/errors.ts';
import { OpenCodeRuntime } from '../src/runtime/opencode.ts';
import { runtimeConfig } from '../src/runtime/config.ts';
import { arenaCapabilities } from '../src/gateway/adapters.ts';

async function fixture(handler:RequestListener){
  const server=createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');
  return {runtime:new OpenCodeRuntime(`http://127.0.0.1:${(server.address() as {port:number}).port}`,'fixture'),close:async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}};
}

test('runtime config aligns Arena model limits and gateway port without altering the template',async()=>{
  const root=await mkdtemp(join(tmpdir(),'coagent-config-'));const template=resolve('config/opencode.json');const before=await readFile(template,'utf8');
  try{
    const path=await runtimeConfig(template,root,{COAGENT_MODE:'arena',COAGENT_PORT:'54321'});
    const config=JSON.parse(await readFile(path,'utf8'));
    assert.equal(config.provider.coagent.options.baseURL,'http://127.0.0.1:54321/v1');
    for(const model of Object.values(config.provider.coagent.models) as any[]){assert.equal(model.limit.output,arenaCapabilities.maxOutput);assert.equal(model.limit.context,arenaCapabilities.contextWindow);}
    assert.equal(config.agent.sidekick.permission.task,'deny');
    assert.match(config.plugin[0],/^file:\/\//);
    assert.equal(config.provider.coagent.options.apiKey,'{env:COAGENT_API_KEY}');
    assert.equal(await readFile(template,'utf8'),before);
    const normal=JSON.parse(await readFile(await runtimeConfig(template,root,{COAGENT_MODE:'mock'}),'utf8'));
    assert.equal(normal.provider.coagent.models.sidekick.limit.output,8192);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('runtime preserves upstream status while forbidding automatic replay of a submitted turn',async()=>{
  const f=await fixture((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({info:{error:{name:'APIError',data:{statusCode:429,isRetryable:true,message:'private upstream diagnostic'}}},parts:[]}));});
  try{
    await assert.rejects(f.runtime.prompt('ses_one','sidekick','/tmp',{providerID:'coagent',modelID:'sidekick'},'work',AbortSignal.timeout(1000)),error=>{
      assert.ok(error instanceof RuntimeExecutionError);assert.equal(error.status,429);assert.equal(error.retryable,false);assert.equal(error.stopConfirmed,true);assert.doesNotMatch(error.message,/private/);return true;
    });
  }finally{await f.close();}
});

test('cancel confirmation failure is explicit and retains the original interruption cause',async()=>{
  let aborts=0;
  const f=await fixture((req,res)=>{if(req.url?.includes('/abort')){aborts++;res.setHeader('content-type','application/json');res.end('false');}});
  try{
    await assert.rejects(f.runtime.prompt('ses_one','sidekick','/tmp',{providerID:'coagent',modelID:'sidekick'},'work',AbortSignal.timeout(50)),error=>{
      assert.ok(error instanceof RuntimeExecutionError);assert.equal(error.stopConfirmed,false);assert.equal(error.code,'runtime_stop_unconfirmed');assert.ok(error.cause);return true;
    });assert.equal(aborts,1);
  }finally{await f.close();}
});
