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
import {runtimeEnvironment} from '../src/runtime/environment.ts';

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
    const expanded=JSON.parse(await readFile(await runtimeConfig(template,root,{COAGENT_MODE:'arena',ARENA_CONTEXT_BUDGET_BYTES:'65536'}),'utf8'));
    assert.equal(expanded.provider.coagent.models.sidekick.limit.context,65536);
    const normal=JSON.parse(await readFile(await runtimeConfig(template,root,{COAGENT_MODE:'mock'}),'utf8'));
    assert.equal(normal.provider.coagent.models.sidekick.limit.output,8192);
    const mcp=JSON.parse(await readFile(await runtimeConfig(template,root,{COAGENT_MODE:'arena',COAGENT_MCP_URL:'https://mcp.example.invalid/test'}),'utf8'));
    assert.equal(mcp.mcp.local_workspace.url,'{env:COAGENT_MCP_URL}');assert.equal(mcp.mcp.local_workspace.oauth,false);
    assert.equal(mcp.agent.sidekick.tools.bash,false);assert.equal(mcp.agent.sidekick.permission.local_workspace_apply_patch,undefined);
    assert.equal(mcp.agent.sidekick.permission['local_workspace_*'],'ask');assert.equal(mcp.agent.reviewer.permission['local_workspace_*'],'deny');assert.equal(mcp.agent.reviewer.permission.local_workspace_read_files,'allow');
    const text=JSON.parse(await readFile(await runtimeConfig(template,root,{COAGENT_MCP_URL:'https://mcp.example.invalid/test',COAGENT_MCP_TEXT_ONLY:'1'}),'utf8'));
    assert.equal(text.mcp.local_workspace.type,'local');assert.equal(text.mcp.local_workspace.command[0],process.execPath);assert.match(text.mcp.local_workspace.command[1],/mcp-text-bridge\.ts$/);assert.doesNotMatch(JSON.stringify(text),/mcp\.example\.invalid/);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('managed runtime disables unsolicited registry, updater, project config and LSP downloads',async()=>{
  const root=await mkdtemp(join(tmpdir(),'coagent-environment-'));
  try{
    const env=await runtimeEnvironment(root,resolve('config/opencode.json'),{NO_PROXY:'mcp.example.invalid',OPENCODE_DISABLE_MODELS_FETCH:'false'});
    for(const key of ['OPENCODE_DISABLE_MODELS_FETCH','OPENCODE_DISABLE_AUTOUPDATE','OPENCODE_DISABLE_DEFAULT_PLUGINS','OPENCODE_DISABLE_LSP_DOWNLOAD','OPENCODE_DISABLE_PROJECT_CONFIG'])assert.equal(env[key],'true');
    assert.match(env.NO_PROXY!,/mcp\.example\.invalid/);assert.match(env.NO_PROXY!,/127\.0\.0\.1/);assert.equal(env.OPENCODE_CONFIG,resolve('config/opencode.json'));
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

test('a submitted prompt waits for the task signal without the fetch headers deadline',async t=>{
  const f=await fixture((_req,res)=>{setTimeout(()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({info:{},parts:[{type:'text',text:'finished after tool rounds'}]}));},60);});
  t.mock.method(globalThis,'fetch',async()=>{throw Object.assign(new Error('headers timeout'),{cause:{code:'UND_ERR_HEADERS_TIMEOUT'}});});
  try{const result=await f.runtime.prompt('ses_long','sidekick','/tmp',{providerID:'coagent',modelID:'sidekick'},'work',AbortSignal.timeout(1000));assert.equal(result.text,'finished after tool rounds');}
  finally{await f.close();}
});

test('review evidence comes from observed native tools, separate from assistant claims',async()=>{
  const f=await fixture((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify([{parts:[{type:'text',text:'assistant claims tests passed'},{type:'tool',tool:'local_workspace_run_command',state:{status:'completed',input:{command:'node --test'},output:'exit_code: 0'}}]}]));});
  try{const evidence=await f.runtime.toolHistory('ses_worker','/tmp');assert.equal(evidence.length,1);assert.ok('tool' in evidence[0]);assert.equal(evidence[0].tool,'local_workspace_run_command');assert.equal(evidence[0].output,'exit_code: 0');assert.doesNotMatch(JSON.stringify(evidence),/assistant claims/);}finally{await f.close();}
});
