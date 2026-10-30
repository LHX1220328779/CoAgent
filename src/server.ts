import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from './errors.ts';
import { authorized, readJSON, json, streamHeaders, write } from './http.ts';
import { validateRequest } from './gateway/protocol.ts';
import { ModelRouter } from './gateway/router.ts';
import type { ArenaAgentAdapter } from './gateway/adapters.ts';
import { Store } from './supervisor/store.ts';
import { Orchestrator, taskFromInput } from './supervisor/orchestrator.ts';
import type { AgentRuntime, ToolCall, ModelUsage } from './types.ts';
import type {ArenaPool} from './arena/pool.ts';
export function createApp(options:{key:string;router:ModelRouter;store:Store;orchestrator:Orchestrator;runtime:AgentRuntime;arena?:ArenaAgentAdapter;pool?:ArenaPool;litellm?:{url:string;key:string}}) {
  const {key,router,store,orchestrator,runtime}=options;
  if(key.length<16)throw new Error('COAGENT_API_KEY must contain at least 16 characters');
  return createServer(async(req,res)=>{
    const controller=new AbortController();res.once('close',()=>controller.abort());const signal=controller.signal;
    try {
      const path=new URL(req.url ?? '/','http://localhost').pathname;
      if(req.method==='GET' && path==='/health'){json(res,200,{ok:true,version:'0.1.0'});return;}
      if(!authorized(req,key))throw new AppError('Unauthorized',401,'authentication_error');
      if(req.method==='POST' && path==='/arena/bindings'){
        if(!options.arena)throw new AppError('Enable arena mode before binding sessions',409);
        const body=await readJSON(req) as {sessionID?:unknown;arenaSessionID?:unknown}|null;
        if(typeof body?.sessionID!=='string' || typeof body?.arenaSessionID!=='string')throw new AppError('sessionID and arenaSessionID required');
        const native=store.sessions().find((s:any)=>s.runtime_id===body.sessionID) as any;if(!native)throw new AppError('Prepare this OpenCode session first',404);
        if(options.pool&&native.task_id)throw new AppError('请使用任务自动分配会话，保留任务独占关系',409);
        if(options.pool&&(options.pool.snapshot().leases as any[]).some(lease=>lease.arena_id===String(body.arenaSessionID).toLowerCase()))throw new AppError('该会话已被任务独占，请先由原任务解绑',409);
        const result=await options.arena.bind(body.sessionID,body.arenaSessionID);
        store.audit('arena_bind',null,{sessionID:body.sessionID});json(res,200,result);return;
      }
      if(req.method==='GET' && path==='/v1/models'){json(res,200,{object:'list',data:[...router.routes].map(([id,r])=>({id,object:'model',created:0,owned_by:'coagent',capabilities:r[0].adapter.capabilities}))});return;}
      if(req.method==='POST' && path==='/v1/chat/completions'){
        const input=await readJSON(req);validateRequest(input);input._coagentSession=typeof req.headers['x-coagent-session']==='string'?req.headers['x-coagent-session']:undefined;const id=`chatcmpl-${randomUUID()}`,created=Math.floor(Date.now()/1000);
        let text='',usage:ModelUsage|null=null,finish='stop';const calls=new Map<number,ToolCall>();
        const chunk=(delta:unknown,reason:string|null=null)=>({id,object:'chat.completion.chunk',created,model:input.model,choices:[{index:0,delta,finish_reason:reason}]});
        for await(const event of router.generate(input,signal)) {
          if(event.type==='usage'){usage=event.usage;continue;}
          if(input.stream && !res.headersSent){streamHeaders(res);await write(res,`data: ${JSON.stringify(chunk({role:'assistant'}))}\n\n`,signal);}
          if(event.type==='text'){text+=event.text;if(input.stream)await write(res,`data: ${JSON.stringify(chunk({content:event.text}))}\n\n`,signal);}
          if(event.type==='tool'){const call={id:event.id!,type:'function' as const,function:{name:event.name!,arguments:event.arguments!}};calls.set(event.index,call);if(input.stream)await write(res,`data: ${JSON.stringify(chunk({tool_calls:[{index:event.index,...call}]}))}\n\n`,signal);}
          if(event.type==='finish'){finish=event.reason;if(input.stream)await write(res,`data: ${JSON.stringify(chunk({},finish))}\n\n`,signal);}
        }
        const wireUsage=usage?{prompt_tokens:usage.inputTokens,completion_tokens:usage.outputTokens,total_tokens:usage.inputTokens+usage.outputTokens,prompt_tokens_details:{cached_tokens:usage.cachedTokens}}:undefined;
        if(input.stream){if(!res.headersSent)streamHeaders(res);if((input.stream_options as {include_usage?:boolean}|undefined)?.include_usage && wireUsage)await write(res,`data: ${JSON.stringify({id,object:'chat.completion.chunk',created,model:input.model,choices:[],usage:wireUsage})}\n\n`,signal);res.end('data: [DONE]\n\n');}
        else json(res,200,{id,object:'chat.completion',created,model:input.model,choices:[{index:0,message:{role:'assistant',content:text || null,...(calls.size?{tool_calls:[...calls.values()]}:{})},finish_reason:finish}],usage:wireUsage});return;
      }
      // Delegate protocol translation to pinned LiteLLM; never fake another protocol's semantics.
      if(req.method==='POST' && ['/v1/responses','/v1/messages'].includes(path)){
        if(!options.litellm)throw new AppError('This endpoint requires configured LiteLLM',501,'protocol_unavailable');
        const body=await readJSON(req);
        if(!body || typeof body!=='object' || !router.routes.has(String((body as {model?:unknown}).model)))throw new AppError('Unknown model',404);
        const protocolSignal=AbortSignal.any([signal,AbortSignal.timeout(router.timeoutMs)]);
        const started=Date.now();let status='failed';let release:(()=>void)|undefined;
        try{
          release=await router.semaphore.acquire(protocolSignal);
          const upstream=await fetch(`${options.litellm.url.replace(/\/v1\/?$/,'')}${path}`,{method:'POST',signal:protocolSignal,headers:{'content-type':'application/json',authorization:`Bearer ${options.litellm.key}`,'anthropic-version':'2023-06-01'},body:JSON.stringify(body)});
          if(!upstream.ok){await upstream.body?.cancel();throw new AppError(`LiteLLM HTTP ${upstream.status}`,upstream.status,'upstream_error');}
          res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type') ?? 'application/json','cache-control':'no-store'});
          if(upstream.body){const decoder=new TextDecoder();for await(const part of upstream.body)await write(res,decoder.decode(part,{stream:true}),protocolSignal);await write(res,decoder.decode(),protocolSignal);}res.end();
          status='succeeded';
        }finally{release?.();store.record({model:String((body as {model?:unknown}).model),adapter:'litellm',latencyMs:Date.now()-started,status:protocolSignal.aborted?'canceled_or_timeout':status,usage:null});}return;
      }
      if(path==='/arena/pool'&&options.pool){if(req.method==='GET'){json(res,200,options.pool.snapshot());return;}if(req.method==='POST'){json(res,200,await options.pool.refresh());return;}}
      const allocation=/^\/tasks\/([a-zA-Z0-9_-]+)\/(assign|release|followup)$/.exec(path);
      if(allocation&&req.method==='POST'){
        const [,id,action]=allocation;
        if(action==='followup'){const input=await readJSON(req) as {prompt:string};orchestrator.followup(id,input.prompt);json(res,200,store.task(id));return;}
        if(!options.pool)throw new AppError('当前模式没有 Arena 会话池',409);
        json(res,200,await (action==='assign'?options.pool.assign(id):options.pool.release(id)));return;
      }
      if(req.method==='GET' && path==='/sessions'){json(res,200,store.sessions());return;}
      if(req.method==='GET' && path==='/tasks'){json(res,200,store.tasks());return;}
      if(req.method==='POST' && path==='/tasks'){
        const body=await readJSON(req);const inputs=Array.isArray(body)?body:[body];if(!inputs.length || inputs.length>100)throw new AppError('Expected 1..100 tasks');
        const tasks=inputs.map(v=>{if(!v || typeof v!=='object')throw new AppError('Invalid task');return taskFromInput(v);});store.add(tasks);await orchestrator.tick();json(res,201,tasks.map(t=>store.task(t.id)));return;
      }
      if(req.method==='POST' && path==='/plan/prepare'){const input=await readJSON(req) as Record<string,unknown>;const base=taskFromInput(input);const session=await orchestrator.getSession('lead',base.repo,{providerID:'coagent',modelID:'lead'});json(res,200,session);return;}
      if(req.method==='POST' && path==='/plan'){
        const input=await readJSON(req) as Record<string,unknown>;const base=taskFromInput(input);const model={providerID:'coagent',modelID:'lead'};
        const lead=await orchestrator.getSession('lead',base.repo,model);const session=lead.runtimeID;
        const result=await runtime.prompt(session,'lead',base.repo,model,`Decompose this task into a small DAG (1-4 tasks). Return JSON array with id, title, prompt, dependsOn (IDs in this array only). Do not include commands or model settings. Task: ${base.prompt}`,AbortSignal.any([signal,AbortSignal.timeout(base.timeoutMs)]));
        let plan:Record<string,unknown>[];try{plan=JSON.parse(result.text);}catch{throw new AppError('Lead returned invalid JSON',422);}
        if(!Array.isArray(plan) || !plan.length || plan.length>4)throw new AppError('Invalid plan',422);
        const prefix=randomUUID().slice(0,8);const ids=new Map(plan.map(t=>[t.id,`${prefix}-${String(t.id)}`]));
        const tasks=plan.map(t=>taskFromInput({id:ids.get(t.id),title:t.title,prompt:t.prompt,dependsOn:Array.isArray(t.dependsOn)?t.dependsOn.map(d=>ids.get(d) ?? ''):[],repo:base.repo,workspaceMode:base.workspaceMode,requiresApproval:true}));
        store.add(tasks);store.audit('plan',null,{session,taskIDs:tasks.map(t=>t.id)});await orchestrator.tick();json(res,201,tasks.map(t=>store.task(t.id)));return;
      }
      const action=/^\/tasks\/([a-zA-Z0-9_-]+)(?:\/(pause|resume|cancel|approve|prepare))?$/.exec(path);
      if(action){const id=action[1];if(req.method==='GET' && !action[2]){json(res,200,store.task(id));return;}if(req.method==='POST' && action[2]){
        switch(action[2]){case 'prepare':{const prepared=await orchestrator.prepare(id);if(options.pool)await options.pool.assign(id);json(res,200,prepared);return;}case 'pause':await orchestrator.pause(id);break;case 'cancel':await orchestrator.cancel(id);break;case 'resume':options.pool?.ready(id);orchestrator.resume(id);break;case 'approve':options.pool?.ready(id);orchestrator.approve(id);break;}
        await orchestrator.tick();json(res,200,store.task(id));return;
      }}
      if(req.method==='GET' && path==='/metrics'){json(res,200,store.metrics());return;}
      if(req.method==='GET' && path==='/events'){
        const cursor=Number(req.headers['last-event-id'] ?? new URL(req.url!,'http://localhost').searchParams.get('after') ?? 0);if(!Number.isSafeInteger(cursor)||cursor<0)throw new AppError('Invalid event cursor');
        streamHeaders(res);let after=cursor;
        while(!signal.aborted){const events=store.events(after) as {id:number}[];for(const event of events){await write(res,`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`,signal);after=event.id;}if(!events.length)await write(res,': heartbeat\n\n',signal);await delay(500,undefined,{signal});}return;
      }
      throw new AppError('Not found',404);
    }catch(error){
      if(res.destroyed)return;
      const status=error instanceof AppError?error.status:error instanceof Error && error.name==='TimeoutError'?504:500;
      const body={error:{message:error instanceof AppError?error.message:status===504?'Request timed out':'Internal server error',type:error instanceof AppError?error.code:'server_error'}};
      if(res.headersSent)res.end(`event: error\ndata: ${JSON.stringify(body)}\n\n`);else json(res,status,body);
    }
  });
}
