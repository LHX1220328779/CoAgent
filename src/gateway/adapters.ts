import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from '../errors.ts';
import { parseSSE } from './protocol.ts';
import { arenaToolPrompt, arenaTextTools, arenaFinalAnswer } from './arena-tools.ts';
import type { ModelAdapter, ModelCapabilities, ModelEvent, ModelRequest } from '../types.ts';
export const nativeCapabilities: ModelCapabilities = { streaming: true, tools: 'native', parallelTools: true, contextWindow: 128000, maxOutput: 8192, protocols: ['chat'] };
export const arenaCapabilities: ModelCapabilities = { ...nativeCapabilities, tools: 'simulated', parallelTools: false, contextWindow: 32768, maxOutput: 4096 };
export function arenaContextBudget(value?:string) {
  const budget=Number(value ?? arenaCapabilities.contextWindow);
  if(!Number.isSafeInteger(budget) || budget<8192)throw new AppError('ARENA_CONTEXT_BUDGET_BYTES must be an integer of at least 8192');
  return budget;
}
export class OpenAIAdapter implements ModelAdapter {
  id: string; capabilities: ModelCapabilities; baseURL: string; apiKey: string;
  constructor(id: string, baseURL: string, apiKey: string, capabilities = nativeCapabilities) {
    this.id = id; this.baseURL = baseURL.replace(/\/$/, ''); this.apiKey = apiKey; this.capabilities = capabilities;
  }
  async *generate(request: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelEvent> {
    const { _coagentSession, ...wireRequest } = request;
    const response = await fetch(`${this.baseURL}/chat/completions`, { method: 'POST', signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}`, ...(typeof _coagentSession === 'string' ? {'x-codex-session-id':_coagentSession} : {}) },
      body: JSON.stringify({ ...wireRequest, stream: true, stream_options: { include_usage: true } }) });
    if (!response.ok) {
      await response.body?.cancel();
      const retry = response.headers.get('retry-after'); const seconds = Number(retry);
      const ms = retry ? (Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry) - Date.now()) : 0;
      throw new AppError(`Upstream HTTP ${response.status}`, response.status, 'upstream_error', Math.max(0, ms || 0));
    }
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new AppError('Expected upstream SSE', 502, 'protocol_error');
    let finished = false, done = false;
    for await (const frame of parseSSE(response.body, signal)) {
      if (frame.data === '[DONE]') { done = true; break; }
      let chunk;
      try { chunk = JSON.parse(frame.data); } catch { throw new AppError('Invalid SSE JSON', 502, 'protocol_error'); }
      if (chunk.error) throw new AppError('Upstream stream error', 502, 'upstream_error');
      if (chunk.usage) yield { type: 'usage', usage: { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0,
        cachedTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0, cost: null, estimated: false } };
      for (const choice of chunk.choices ?? []) {
        if (choice.index !== 0) throw new AppError('Only a single choice is supported', 502, 'protocol_error');
        if (choice.delta?.content) yield { type: 'text', text: choice.delta.content };
        for (const tool of choice.delta?.tool_calls ?? []) yield { type: 'tool', index: tool.index, id: tool.id, name: tool.function?.name, arguments: tool.function?.arguments };
        if (choice.finish_reason) {
          if (!['stop','length','tool_calls'].includes(choice.finish_reason)) throw new AppError('Unsupported finish reason', 502, 'protocol_error');
          finished = true; yield { type: 'finish', reason: choice.finish_reason };
        }
      }
    }
    if (!done || !finished) throw new AppError('Upstream stream ended without completion', 502, 'stream_interrupted');
  }
}
/** No browser automation. Only an explicitly supplied, authorized research transport. */
export class ArenaResearchAdapter extends OpenAIAdapter {
  constructor(baseURL: string, key: string) { super('arena-research', baseURL, key, { ...nativeCapabilities, tools: 'none', parallelTools: false, contextWindow: 8192 }); }
}
/** Explicit one-to-one binding to already authorized Arena Agent sessions; no harvesting or account rotation. */
export class ArenaAgentAdapter extends OpenAIAdapter {
  bindingsPath: string;
  diagnosticsDir?: string;
  private bindingWrite: Promise<void> = Promise.resolve();
  constructor(baseURL: string, key: string, bindingsPath: string, diagnosticsDir?:string, contextBudget=arenaCapabilities.contextWindow) {
    const url = new URL(baseURL);
    if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new AppError('Arena bridge must be local');
    super('arena-agent',baseURL,key,{...arenaCapabilities,contextWindow:arenaContextBudget(String(contextBudget))});
    this.bindingsPath=bindingsPath;
    this.diagnosticsDir=diagnosticsDir;
  }
  private async bindings(allowMissing=false): Promise<Record<string,string>> {
    let bindings;
    try { bindings=JSON.parse(await readFile(this.bindingsPath,'utf8')); }
    catch(error) {
      if(allowMissing && (error as NodeJS.ErrnoException).code==='ENOENT')return {};
      throw new AppError('Create a valid Arena session bindings file first',409,'arena_session_required');
    }
    if(!bindings || typeof bindings!=='object' || Array.isArray(bindings))throw new AppError('Invalid Arena session bindings');
    return bindings;
  }
  async bind(sessionID:string,arenaSessionID:string) {
    if(!/^ses_[a-zA-Z0-9_-]{1,128}$/.test(sessionID) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(arenaSessionID))throw new AppError('Expected an OpenCode session ID and an existing Arena UUID');
    const target=arenaSessionID.toLowerCase();
    const write=this.bindingWrite.then(async()=>{
      const bindings=await this.bindings(true);
      if(Object.entries(bindings).some(([id,value])=>id!==sessionID && typeof value==='string' && value.toLowerCase()===target))throw new AppError('Each agent requires a distinct Arena session',409,'arena_session_conflict');
      bindings[sessionID]=target;
      await mkdir(dirname(this.bindingsPath),{recursive:true,mode:0o700});
      const temporary=`${this.bindingsPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary,JSON.stringify(bindings,null,2)+'\n',{mode:0o600,flag:'wx'});
        await rename(temporary,this.bindingsPath);
      }finally{await rm(temporary,{force:true});}
    });
    this.bindingWrite=write.catch(()=>{});
    await write;return {sessionID,arenaSessionID:target};
  }
  override async *generate(request: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelEvent> {
    const session=request._coagentSession;
    if(typeof session!=='string' || !session)throw new AppError('Arena requires an explicit OpenCode session header',422,'arena_session_required');
    let bindings:Record<string,string>;
    try{bindings=await this.bindings();}catch(cause){const error=new AppError('Create a valid Arena session bindings file first',422,'arena_session_required');error.cause=cause;throw error;}
    const target=bindings[session];
    if(typeof target!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target))throw new AppError('Bind this OpenCode session to an existing Arena Agent session UUID',422,'arena_session_required');
    if(Object.values(bindings).filter(id=>typeof id==='string' && id.toLowerCase()===target.toLowerCase()).length!==1)throw new AppError('Each agent requires a distinct Arena session',422,'arena_session_conflict');
    try {
      const requestID=randomUUID();
      const prompt=arenaToolPrompt(request,requestID);
      if(Buffer.byteLength(prompt)+(request.max_tokens ?? this.capabilities.maxOutput)>this.capabilities.contextWindow)throw new AppError('Arena serialized context exceeds the configured budget',422,'arena_context_length');
      const events:ModelEvent[]=[];let text='';let finish:Extract<ModelEvent,{type:'finish'}>|undefined;let structured=false;
      for await(const event of super.generate({...request,model:target,messages:[{role:'user',content:prompt}]},signal)){
        if(event.type==='text'){
          text+=event.text;
          if(text.length>2*1024*1024)throw new AppError('Arena response exceeds the tool-frame budget',422,'arena_tool_protocol_error');
        }else if(event.type==='finish')finish=event;
        else{if(event.type==='tool')structured=true;events.push(event.type==='usage'?{...event,usage:{...event.usage,estimated:true}}:event);}
      }
      if(this.diagnosticsDir){
        await mkdir(this.diagnosticsDir,{recursive:true,mode:0o700});
        await writeFile(`${this.diagnosticsDir}/${Date.now()}-${randomUUID()}.json`,JSON.stringify({sessionID:session,requestID,tools:request.tools?.map(tool=>tool.function.name) ?? [],promptBytes:Buffer.byteLength(prompt),finish,text},null,2)+'\n',{mode:0o600,flag:'wx'});
      }
      const finalText=structured?undefined:arenaFinalAnswer(text,requestID);
      const calls=structured || finalText!==undefined ? [] : arenaTextTools(text,requestID);
      if(calls.length){
        if(!request.tools?.length || request.tool_choice==='none' || finish?.reason==='length')throw new AppError('Unexpected or incomplete Arena tool request',422,'arena_tool_protocol_error');
        for(const [index,call] of calls.entries())yield {type:'tool',index,id:call.id,name:call.function.name,arguments:call.function.arguments};
        for(const event of events)yield event;
        yield {type:'finish',reason:'tool_calls'};
      }else{
        if(finalText ?? text)yield {type:'text',text:finalText ?? text};
        for(const event of events)yield event;
        if(finish)yield finish;
      }
    } catch (cause) {
      signal.throwIfAborted();
      // OpenCode V1 itself retries 429/5xx even when this gateway has retries=0.
      // 409 is also retryable in the SDK, so 422 denotes a terminal local precondition.
      const status = cause instanceof AppError ? cause.status : undefined;
      const code = cause instanceof AppError && cause.code.startsWith('arena_') ? cause.code : status === 429 ? 'arena_quota_exhausted' : status === 401 || status === 403 ? 'arena_authorization_required' : 'arena_turn_interrupted';
      const error = new AppError(cause instanceof AppError && cause.code.startsWith('arena_') ? cause.message : 'Arena Agent needs attention; inspect the existing session before resuming',422,code);
      error.cause = cause;
      throw error;
    }
  }
}
export class MockAdapter implements ModelAdapter {
  id = 'mock'; capabilities = nativeCapabilities;
  async *generate(request: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelEvent> {
    signal.throwIfAborted();
    const last = request.messages.at(-1)!;
    const text = typeof last.content === 'string' ? last.content : Array.isArray(last.content) ? last.content.map((p:any)=>typeof p?.text==='string'?p.text:'').join('\n') : ''; 
    if (text.startsWith('DELAY:')) await delay(Number(text.slice(6)) || 500, undefined, { signal });
    if (text === 'FAULT:429') throw new AppError('Mock rate limit', 429, 'rate_limit', 10);
    if (text === 'FAULT:503') throw new AppError('Mock unavailable', 503, 'unavailable');
    const tool = request.tools?.find(t => t.function.name === 'echo');
    if (tool && last.role !== 'tool' && text.startsWith('TOOL:')) {
      yield { type: 'tool', index: 0, id: `call_${randomUUID()}`, name: 'echo', arguments: '{"text":' };
      yield { type: 'tool', index: 0, arguments: `${JSON.stringify(text.slice(5))}}` };
      yield { type: 'finish', reason: 'tool_calls' };
    } else {
      yield { type: 'text', text: 'mock: ' }; yield { type: 'text', text };
      if (text === 'FAULT:stream') throw new AppError('Mock stream interrupted', 502, 'stream_interrupted');
      yield { type: 'finish', reason: 'stop' };
    }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, cost: 0, estimated: true } };
  }
}
