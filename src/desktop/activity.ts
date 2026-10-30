import type {OpenCodeRuntime} from '../runtime/opencode.ts';
export async function activity(runtime:OpenCodeRuntime,directory:string,sessions:{role:string;runtime_id:string}[]){
  const events:unknown[]=[];
  for(const session of sessions){
    const response=await runtime.request(`/session/${encodeURIComponent(session.runtime_id)}/message`,directory).catch(()=>null);if(!response)continue;
    const messages=await response.json() as any[];
    for(const message of messages.slice(-60))for(const part of message.parts??[]){
      if(part.type==='tool')events.push({id:part.id,callID:part.callID,role:session.role,type:'tool',tool:part.tool,status:part.state?.status,input:part.state?.input,output:String(part.state?.output??'').slice(0,20000),diff:part.state?.metadata?.diff,error:part.state?.error,time:part.state?.time?.start??message.info?.time?.created??0});
      else if(part.type==='text'&&part.text)events.push({id:part.id,role:message.info?.role==='user'?'user':session.role,type:'text',text:part.text.slice(0,20000),time:message.info?.time?.created??0});
    }
  }return events.sort((a:any,b:any)=>a.time-b.time).slice(-100);
}
