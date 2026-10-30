import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,readFile,writeFile,rename,appendFile,readdir,access,open} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {join} from 'node:path';
import {RpcError} from './rpc.ts';
export interface AcpSession{id:string;cwd:string;taskID?:string;title:string;updatedAt:string;pendingPrompt?:boolean;acceptance?:string[]}
export class AcpSessions{
  root:string;private writes=Promise.resolve();
  constructor(root:string){this.root=root;}
  private path(id:string,suffix:string){if(!/^acp_[0-9a-f-]{36}$/.test(id))throw new RpcError(-32602,'无效的 CoAgent ACP 会话 ID');return join(this.root,id+suffix);}
  async save(session:AcpSession){await mkdir(this.root,{recursive:true,mode:0o700});const path=this.path(session.id,'.json');await writeFile(path+'.tmp',JSON.stringify(session,null,2)+'\n',{mode:0o600});await rename(path+'.tmp',path);}
  async get(id:string){try{return JSON.parse(await readFile(this.path(id,'.json'),'utf8')) as AcpSession;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new RpcError(-32602,'找不到该 ACP 会话');throw error;}}
  async acquire(id:string){
    const path=this.path(id,'.lock');await mkdir(this.root,{recursive:true,mode:0o700});const file=await open(path,'a',0o600);await file.close();
    // Kernel ownership outlives no process: an interrupted client cannot leave a
    // stale PID lock or let two processes create tasks for the same conversation.
    const child=spawn('flock',['-n','-E','75',path,process.execPath,'-e',"process.stdout.write('locked\\n');process.stdin.resume()"],{stdio:['pipe','pipe','ignore']});
    await new Promise<void>((resolve,reject)=>{let ready=false;child.once('error',()=>reject(new RpcError(-32000,'无法启动会话锁，需要本机 flock')));child.stdout.once('data',()=>{ready=true;resolve();});child.once('exit',()=>{if(!ready)reject(new RpcError(-32000,'该会话正在其他客户端操作'));});});
    return async()=>{if(child.exitCode!==null||child.signalCode)return;const exited=once(child,'exit');child.stdin.end();await exited;};
  }
  async list(){let names:string[];try{names=await readdir(this.root);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}return Promise.all(names.filter(name=>/^acp_[0-9a-f-]{36}\.json$/.test(name)).map(name=>this.get(name.slice(0,-5))));}
  append(id:string,update:unknown){const run=this.writes.then(()=>appendFile(this.path(id,'.jsonl'),JSON.stringify(update)+'\n',{mode:0o600}));this.writes=run.catch(()=>{});return run;}
  async replay(id:string,emit:(update:any)=>void){const path=this.path(id,'.jsonl');try{await access(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
    const stream=createReadStream(path),lines=createInterface({input:stream,crlfDelay:Infinity});try{for await(const line of lines)if(line)emit(JSON.parse(line));}finally{lines.close();stream.destroy();}
  }
}
