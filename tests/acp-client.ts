import {PassThrough} from 'node:stream';
import {RpcPeer} from '../src/acp/rpc.ts';
import {CoAgentAcp} from '../src/acp/agent.ts';
import {AcpSessions} from '../src/acp/sessions.ts';
import type {AcpBackend} from '../src/acp/backend.ts';
export function acpClient(backend:AcpBackend,state:string,onPermission:(params:any)=>any=()=>({outcome:{outcome:'selected',optionId:'allow_once'}})){
  const input=new PassThrough(),output=new PassThrough(),peer=new RpcPeer(output),agent=new CoAgentAcp(peer,backend,new AcpSessions(state)),connection=peer.listen(input,(method,params)=>agent.handle(method,params),()=>agent.close());
  let id=0,buffer='';const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:any)=>void}>(),updates:any[]=[],permissions:any[]=[];
  output.on('data',data=>{buffer+=String(data);let end;while((end=buffer.indexOf('\n'))>=0){const message=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);if(message.method==='session/update')updates.push(message.params);else if(message.method==='session/request_permission'){permissions.push(message.params);void Promise.resolve(onPermission(message.params)).then(result=>input.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\n'));}else if(message.id!==undefined){const p=pending.get(message.id);if(p){pending.delete(message.id);message.error?p.reject(message.error):p.resolve(message.result);}}}});
  return {updates,permissions,call(method:string,params:any={}){const key=++id,result=new Promise<any>((resolve,reject)=>pending.set(key,{resolve,reject}));input.write(JSON.stringify({jsonrpc:'2.0',id:key,method,params})+'\n');return result;},notify(method:string,params:any){input.write(JSON.stringify({jsonrpc:'2.0',method,params})+'\n');},async close(){await connection.stop();connection.lines.close();input.destroy();output.destroy();}};
}
