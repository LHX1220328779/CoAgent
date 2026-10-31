import { AppError, RuntimeExecutionError } from '../errors.ts';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {Readable} from 'node:stream';
import { parseSSE } from '../gateway/protocol.ts';
import type { AgentRuntime, AgentRole, ModelRef, RuntimeResult } from '../types.ts';
export class OpenCodeRuntime implements AgentRuntime {
  url: string; password: string;
  constructor(url: string, password: string) { this.url = url.replace(/\/$/,''); this.password = password; }
  async request(path: string, directory: string, method = 'GET', body?: unknown, signal?: AbortSignal) {
    const url = this.url+path+'?directory='+encodeURIComponent(directory),options={ method,redirect:'error' as const,
      headers: { 'content-type':'application/json', authorization:'Basic '+Buffer.from('opencode:'+this.password).toString('base64') },
      body: body === undefined ? undefined : JSON.stringify(body), signal: signal ?? AbortSignal.timeout(15000) };
    // A prompt includes all tool rounds and approvals. fetch's independent 300s
    // headers timeout must not abort it before the task's own AbortSignal.
    const response = method==='POST'&&/^\/session\/[^/]+\/message$/.test(path)?await new Promise<Response>((resolve,reject)=>{
      const request=(url.startsWith('https:')?httpsRequest:httpRequest)(url,{method,headers:options.headers,signal:options.signal,timeout:0},incoming=>{
        const headers=new Headers();for(let i=0;i<incoming.rawHeaders.length;i+=2)headers.append(incoming.rawHeaders[i],incoming.rawHeaders[i+1]);
        resolve(new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>,{status:incoming.statusCode??502,headers}));
      });request.once('error',reject);request.end(options.body);
    }):await fetch(url,options);
    if (!response.ok) { await response.body?.cancel(); throw new AppError(`OpenCode HTTP ${response.status}`,response.status,'runtime_error'); }
    return response;
  }
  async health() { const r = await this.request('/global/health',''); const data = await r.json() as {version:string;healthy:boolean}; if (!data.healthy || data.version !== '1.19.5') throw new AppError(`Expected OpenCode 1.19.5, got ${data.version}`,503,'runtime_version'); return data; }
  async create(role: AgentRole, directory: string, model: ModelRef, parentID?: string) {
    const r = await this.request('/session',directory,'POST',{title:`CoAgent ${role}`, ...(parentID ? {parentID} : {})});
    const s = await r.json() as {id:string}; if (!s.id) throw new AppError('Missing session ID',502); return s.id;
  }
  async prompt(id: string, role: AgentRole, directory: string, model: ModelRef, prompt: string, signal: AbortSignal): Promise<RuntimeResult> {
    signal.throwIfAborted();
    // Await runtime abort before returning to the scheduler: no next writer may start early.
    try {
      const response = await this.request(`/session/${encodeURIComponent(id)}/message`,directory,'POST',{
        agent:role,model,parts:[{type:'text',text:prompt}]
      },signal);
      const result = await response.json() as { info: {error?:unknown;tokens?: {input?:number;output?:number;cache?:{read?:number}};cost?:number}; parts: {type:string;text?:string;[key:string]:unknown}[] };
      if (result.info?.error) {
        const failure=result.info.error as {name?:string;data?:{statusCode?:number}};
        const status=failure.data?.statusCode;
        const error=new RuntimeExecutionError('OpenCode reported model execution error',typeof status==='number' && Number.isInteger(status) && status>=400 && status<=599 ? status : failure.name==='ProviderAuthError' ? 401 : 502);
        error.cause=result.info.error;throw error;
      }
      if (!Array.isArray(result.parts)) throw new AppError('Invalid OpenCode response',502,'runtime_error');
      return {text:result.parts.filter(p=>p.type==='text').map(p=>p.text ?? '').join('\n'),parts:result.parts,
        usage:{inputTokens:result.info.tokens?.input ?? 0,outputTokens:result.info.tokens?.output ?? 0,cachedTokens:result.info.tokens?.cache?.read ?? 0,cost:result.info.cost ?? null,estimated:false}};
    } catch (cause) {
      if (!signal.aborted && cause instanceof RuntimeExecutionError) throw cause;
      let stopConfirmed=true;
      try { await this.abort(id,directory); } catch { stopConfirmed=false; }
      const error=new RuntimeExecutionError(stopConfirmed ? signal.aborted ? 'OpenCode turn interrupted' : 'OpenCode turn failed; inspect before resuming' : 'OpenCode stop not confirmed; reconcile this session before resuming',stopConfirmed ? 502 : 409,stopConfirmed);
      error.cause=cause;throw error;
    }
  }
  async toolHistory(id:string,directory:string){
    const response=await this.request('/session/'+encodeURIComponent(id)+'/message',directory),messages=await response.json() as {parts?:any[]}[];
    const tools=messages.flatMap(message=>message.parts??[]).filter(part=>part.type==='tool');
    return [...(tools.length>40?[{omittedEarlierTools:tools.length-40}]:[]),...tools.slice(-40).map(part=>({tool:part.tool,status:part.state?.status,input:part.state?.input,output:String(part.state?.output??'').slice(0,12000),outputTruncated:String(part.state?.output??'').length>12000,error:part.state?.error}))];
  }
  async abort(id: string, directory: string) {
    const response=await this.request(`/session/${encodeURIComponent(id)}/abort`,directory,'POST');
    if(await response.json()!==true)throw new AppError('OpenCode did not confirm stopping this session',409,'runtime_stop_unconfirmed');
  }
  async summarize(id: string, directory: string, model: ModelRef) { await this.request(`/session/${encodeURIComponent(id)}/summarize`,directory,'POST',model); }
  async *events(directory: string, signal: AbortSignal) {
    const response = await this.request('/event',directory,'GET',undefined,signal);
    if (!response.body) throw new AppError('Missing event stream',502);
    for await (const event of parseSSE(response.body,signal)) yield JSON.parse(event.data) as unknown;
  }
}
