import {spawn} from 'node:child_process';
import {mkdir,open} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {RpcError} from './rpc.ts';
export interface AcpBackend{url:string;call(path:string,body?:unknown):Promise<any>;ready():Promise<void>}
/** Uses the existing authenticated local control API; it never owns a Supervisor. */
export class ConsoleBackend implements AcpBackend{
  url:string;private cookie='';private connection?:Promise<void>;private root:string;private env:NodeJS.ProcessEnv;private autoStart:boolean;
  constructor(root:string,env:NodeJS.ProcessEnv,autoStart=true){this.root=root;this.env=env;this.autoStart=autoStart;const port=Number(env.COAGENT_CONSOLE_PORT??4312);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('无效的控制台端口');this.url='http://127.0.0.1:'+port;}
  private async health(){try{const response=await fetch(this.url+'/health',{signal:AbortSignal.timeout(1500)});if(!response.ok)throw new RpcError(-32000,'控制台端口被其他服务占用');const data=await response.json() as any;if(data.app!=='coagent-console'||data.root!==this.root)throw new RpcError(-32000,'控制台端口属于其他应用或项目');return true;}catch(error){if(error instanceof RpcError)throw error;return false;}}
  private async connect(){
    if(!await this.health()){
      if(!this.autoStart)throw new RpcError(-32000,'CoAgent 控制台未运行');
      const directory=join(this.root,'.coagent');await mkdir(directory,{recursive:true,mode:0o700});const log=await open(join(directory,'console.log'),'a',0o600);
      try{const child=spawn(process.execPath,[join(this.root,'src/desktop/main.ts')],{cwd:this.root,env:{...this.env,COAGENT_NO_OPEN:'1'},detached:true,stdio:['ignore',log.fd,log.fd]});child.on('error',()=>{});child.unref();}finally{await log.close();}
      let online=false;for(let i=0;i<120;i++){if(await this.health()){online=true;break;}await delay(250);}if(!online)throw new RpcError(-32000,'控制台启动未完成，请查看 .coagent/console.log');
    }
    const page=await fetch(this.url+'/',{signal:AbortSignal.timeout(5000)});this.cookie=page.headers.get('set-cookie')?.split(';')[0]??'';await page.body?.cancel();if(!this.cookie)throw new RpcError(-32000,'控制台没有返回本机登录态');
  }
  async call(path:string,body?:unknown){
    if(!this.connection)this.connection=this.connect().catch(error=>{this.connection=undefined;throw error;});await this.connection;
    const response=await fetch(this.url+'/api'+path,{method:body===undefined?'GET':'POST',headers:{cookie:this.cookie,'x-coagent-console':'1','content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(path==='/tasks'||path.endsWith('/prepare')||path==='/arena/sync'||path==='/services/start'?180000:30000)});
    const result=await response.json() as any;if(!response.ok){if(response.status===403)this.connection=undefined;throw new RpcError(-32000,result.error?.message??'CoAgent HTTP '+response.status,{status:response.status});}return result;
  }
  async ready(){
    await this.call('/services/start',{});
    for(let i=0;i<120;i++){const overview=await this.call('/overview');if(overview.services.every((s:any)=>s.ready))return;
      const missing=overview.services.filter((s:any)=>!s.ready);if(missing.every((s:any)=>s.running))throw new RpcError(-32000,'请在 '+this.url+' 处理服务或 Arena 登录状态：'+missing.map((s:any)=>s.message).join('；'));
      await delay(500);
    }throw new RpcError(-32000,'本机组件仍未就绪，请打开 '+this.url);
  }
}
