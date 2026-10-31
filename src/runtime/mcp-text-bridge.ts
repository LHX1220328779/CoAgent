import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
import * as http from 'node:http';

type Message={jsonrpc?:string;id?:string|number;method?:string;params?:any;result?:any;error?:unknown};
/** Opt-in text transport for servers that advertise outputSchema but return only content.
 * Preserve input schemas, result content, isError and server access controls verbatim. */
export class McpTextBridge{
  private session?:string;private version='2025-03-26';private active=new Map<string|number,AbortController>();
  private endpoint:string;private request:typeof fetch;
  constructor(endpoint:string,request:typeof fetch=fetch){
    const url=new URL(endpoint);if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)))throw new Error('MCP URL must use HTTPS or loopback HTTP');
    this.endpoint=endpoint;this.request=request;
  }
  close(){for(const controller of this.active.values())controller.abort();this.active.clear();}
  async forward(message:Message,emit:(message:Message)=>void){
    if(message.method==='notifications/cancelled')this.active.get(message.params?.requestId)?.abort();
    const controller=new AbortController();if(message.id!==undefined)this.active.set(message.id,controller);
    const deliver=(reply:Message)=>{
      if(reply.id===message.id&&message.method==='initialize'&&reply.result?.protocolVersion)this.version=reply.result.protocolVersion;
      if(reply.id===message.id&&message.method==='tools/list'&&Array.isArray(reply.result?.tools))reply={...reply,result:{...reply.result,tools:reply.result.tools.map(({outputSchema,...tool}:any)=>tool)}};
      emit(reply);
    };
    try{
      const response=await this.request(this.endpoint,{method:'POST',redirect:'error',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':this.version,...(this.session?{'mcp-session-id':this.session}:{})},body:JSON.stringify(message),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(120000)])});
      this.session=response.headers.get('mcp-session-id')??this.session;
      if(!response.ok){await response.body?.cancel();throw new Error('MCP HTTP '+response.status);}
      if(response.status===202||response.status===204){await response.body?.cancel();if(message.id!==undefined)throw new Error('MCP response missing');return;}
      if(response.headers.get('content-type')?.includes('text/event-stream')&&response.body){
        const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
        try{for(;;){const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});buffer=buffer.replace(/\r\n/g,'\n');let end;
          while((end=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);const data=block.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(!data)continue;const reply=JSON.parse(data);deliver(reply);if(message.id!==undefined&&reply.id===message.id)return;}
        }}finally{await reader.cancel().catch(()=>{});}
        if(message.id!==undefined)throw new Error('MCP response incomplete');
      }else{const raw=await response.text();if(raw)deliver(JSON.parse(raw));else if(message.id!==undefined)throw new Error('MCP response missing');}
    }catch(error){if(message.id!==undefined)emit({jsonrpc:'2.0',id:message.id,error:{code:-32000,message:controller.signal.aborted?'MCP request cancelled':error instanceof Error&&/^MCP (HTTP \d+|response \w+)$/.test(error.message)?error.message:'MCP transport failed'}});}
    finally{if(message.id!==undefined)this.active.delete(message.id);}
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  (http as typeof http&{setGlobalProxyFromEnv:()=>void}).setGlobalProxyFromEnv();const bridge=new McpTextBridge(process.env.COAGENT_MCP_URL??''),lines=createInterface({input:process.stdin});
  lines.on('line',line=>{try{void bridge.forward(JSON.parse(line),message=>process.stdout.write(JSON.stringify(message)+'\n'));}catch{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}})+'\n');}});
  lines.once('close',()=>bridge.close());process.once('SIGTERM',()=>{bridge.close();lines.close();});
}
