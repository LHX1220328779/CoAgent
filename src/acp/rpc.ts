import {createInterface} from 'node:readline';
import type {Readable,Writable} from 'node:stream';
export class RpcError extends Error{code:number;data?:unknown;constructor(code:number,message:string,data?:unknown){super(message);this.code=code;this.data=data;}}
export class RpcPeer{
  private output:Writable;private sequence=0;private pending=new Map<string,{resolve:(value:any)=>void;reject:(error:unknown)=>void}>();private closed=false;
  constructor(output:Writable){this.output=output;output.on('error',()=>this.close());}
  send(value:unknown){if(!this.closed)this.output.write(JSON.stringify(value)+'\n');}
  notify(method:string,params:unknown){this.send({jsonrpc:'2.0',method,params});}
  request(method:string,params:unknown){const id='coagent_'+(++this.sequence);const result=new Promise<any>((resolve,reject)=>this.pending.set(id,{resolve,reject}));this.send({jsonrpc:'2.0',id,method,params});return {result,cancel:()=>{const p=this.pending.get(id);if(p){this.pending.delete(id);p.resolve({outcome:{outcome:'cancelled'}});}}};}
  close(){this.closed=true;for(const p of this.pending.values())p.resolve({outcome:{outcome:'cancelled'}});this.pending.clear();}
  listen(input:Readable,handler:(method:string,params:any)=>Promise<unknown>,onClose:()=>Promise<void>){
    const lines=createInterface({input});
    lines.on('line',line=>{
      let message:any;try{message=JSON.parse(line);}catch{this.send({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});return;}
      if(!message||message.jsonrpc!=='2.0'||typeof message!=='object'||Array.isArray(message)){this.send({jsonrpc:'2.0',id:message?.id??null,error:{code:-32600,message:'Invalid Request'}});return;}
      if(!message.method){const p=this.pending.get(message.id);if(p){this.pending.delete(message.id);if(message.error)p.reject(new RpcError(message.error.code,message.error.message));else p.resolve(message.result);}return;}
      void handler(message.method,message.params??{}).then(result=>{if(message.id!==undefined)this.send({jsonrpc:'2.0',id:message.id,result:result??{}});},error=>{if(message.id!==undefined)this.send({jsonrpc:'2.0',id:message.id,error:{code:error instanceof RpcError?error.code:-32000,message:error instanceof Error?error.message:'CoAgent 请求失败',...(error instanceof RpcError&&error.data!==undefined?{data:error.data}:{})}});});
    });
    let stopping:Promise<void>|undefined;const stop=()=>stopping??=(async()=>{await onClose();this.close();})();lines.once('close',()=>void stop());return {stop,lines};
  }
}
