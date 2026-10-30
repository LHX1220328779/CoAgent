import { spawn, type ChildProcess } from 'node:child_process';
import { open, readFile, mkdir } from 'node:fs/promises';
import { connect } from 'node:net';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from '../errors.ts';

type Name = 'bridge' | 'runtime' | 'gateway';
export interface ServiceState { name: Name; url: string; running: boolean; ready: boolean; managed: boolean; message: string; accounts?: { email: string; disabled: boolean; expired: boolean; blocked: boolean }[] }

/** Connect before starting anything; never terminate an existing listener. */
export class LocalServices {
  root: string; env: NodeJS.ProcessEnv; urls: Record<Name,string>;
  private children = new Map<Name,ChildProcess>();
  private starting?: Promise<ServiceState[]>;
  private errors = new Map<Name,string>();
  constructor(root: string, env: NodeJS.ProcessEnv) {
    this.root=resolve(root);this.env={...env};
    this.urls={bridge:env.ARENA_BRIDGE_URL?.replace(/\/v1\/?$/,'') ?? 'http://127.0.0.1:20140',runtime:env.OPENCODE_URL ?? 'http://127.0.0.1:4096',gateway:`http://127.0.0.1:${env.COAGENT_PORT ?? 4310}`};
    for(const value of Object.values(this.urls)){
      const url=new URL(value);
      if(url.protocol!=='http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.username || url.password)throw new AppError('控制台只连接本机 HTTP 服务');
    }
  }
  async gateway(path:string,method='GET',body?:unknown) {
    const response=await fetch(this.urls.gateway+path,{method,headers:{authorization:`Bearer ${this.env.COAGENT_API_KEY}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
    if(!response.ok){const data=await response.json().catch(()=>null) as any;throw new AppError(data?.error?.message ?? `CoAgent 请求失败 (${response.status})`,response.status,'console_upstream');}
    return response.json();
  }
  async state(name:Name):Promise<ServiceState> {
    const base={name,url:this.urls[name],running:false,ready:false,managed:this.children.has(name),message:this.errors.get(name) ?? '未启动'};
    try{
      const headers:Record<string,string>=name==='runtime'?{authorization:`Basic ${Buffer.from(`opencode:${this.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`}:name==='gateway'?{authorization:`Bearer ${this.env.COAGENT_API_KEY}`}:{ };
      const path=name==='runtime'?'/global/health':name==='gateway'?'/tasks':'/health';
      const response=await fetch(this.urls[name]+path,{headers,signal:AbortSignal.timeout(1800)});
      if(!response.ok)return {...base,running:true,message:response.status===401?'鉴权配置不匹配，请检查本机 .env':`端口已占用，服务返回 ${response.status}；未启动重复进程`};
      const data=await response.json() as any;
      if(name==='gateway')return Array.isArray(data)?{...base,running:true,ready:true,message:'已连接'}:{...base,running:true,message:'端口被其他服务占用'};
      if(name==='runtime')return {...base,running:true,ready:data.healthy===true && data.version==='1.19.5',message:data.version==='1.19.5'?(data.healthy===true?'已连接':'Runtime 尚未就绪'):`需要 OpenCode 1.19.5，当前版本 ${String(data.version ?? '未知')}`};
      if(!Array.isArray(data.accounts) || typeof data.ready!=='boolean')return {...base,running:true,message:'端口被其他服务占用'};
      const accounts=data.accounts.map((a:any)=>({email:String(a.email??''),disabled:a.disabled===true,expired:typeof a.cookieExpirySeconds==='number' && a.cookieExpirySeconds<=0,blocked:/403/.test(String(a.lastError??''))}));
      return {...base,running:true,ready:data.ready,message:data.ready?'账号可用':accounts.some((a:any)=>a.blocked)?'登录被拒绝（403），请正常登录 Arena 后重新登录桥接':accounts.length?'登录已失效或账号不可用，请重新登录':'请登录 Arena 账号',accounts};
    }catch{
      const occupied=await this.occupied(name);
      return {...base,running:occupied,message:occupied?(this.children.has(name)?'正在启动，请稍候':'端口已有进程但无法确认服务，请检查；未启动重复进程'):base.message};
    }
  }
  private occupied(name:Name) {
    const url=new URL(this.urls[name]);
    return new Promise<boolean>(done=>{const socket=connect({host:url.hostname.replace(/^\[|\]$/g,''),port:Number(url.port||80)});let finished=false;const end=(value:boolean)=>{if(finished)return;finished=true;socket.destroy();done(value);};socket.once('connect',()=>end(true));socket.once('error',()=>end(false));socket.setTimeout(600,()=>end(true));});
  }
  async snapshot(){return Promise.all((this.env.COAGENT_MODE==='arena'?['bridge','runtime','gateway']:['runtime','gateway']).map(name=>this.state(name as Name)));}
  start(){if(!this.starting)this.starting=this.startAll().finally(()=>{this.starting=undefined;});return this.starting;}
  private async startAll(){
    const names:Name[]=this.env.COAGENT_MODE==='arena'?['bridge','runtime','gateway']:['runtime','gateway'];
    for(const name of names){
      const current=await this.state(name);if(current.running)continue;
      if(this.children.has(name))continue;
      try{await this.launch(name);}catch(error){this.errors.set(name,error instanceof AppError?error.message:'启动失败，请查看 .coagent/console-services 日志');}
    }
    return this.snapshot();
  }
  private async launch(name:Name){
    if(!this.env.COAGENT_API_KEY || !this.env.OPENCODE_SERVER_PASSWORD)throw new AppError('根目录 .env 缺少本机鉴权配置');
    const env={...this.env};let args:string[],cwd=this.root;
    if(name==='bridge'){
      if(!env.ARENA_BRIDGE_KEY)throw new AppError('.env 缺少 ARENA_BRIDGE_KEY，请使用已有桥接的本机密钥');
      try{const settings=JSON.parse(await readFile(join(this.root,'.coagent/bridge-launch.json'),'utf8'));for(const key of ['http_proxy','https_proxy','HTTP_PROXY','HTTPS_PROXY','no_proxy','NO_PROXY','ARENA_AGENT_PROXY'])if(typeof settings[key]==='string')env[key]=settings[key];}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      cwd=join(this.root,'arena-local-bridge');
      try{await readFile(join(cwd,'src/index.mjs'));}catch{throw new AppError('未安装 arena-local-bridge，请按接入说明安装到项目根目录');}
      const url=new URL(this.urls.bridge);env.ARENA_AGENT_BRIDGE_KEY=env.ARENA_BRIDGE_KEY;env.PORT=url.port||'20140';env.HOST='127.0.0.1';args=[join(cwd,'src/index.mjs')];
    }else args=[join(this.root,'src/cli.ts'),name==='runtime'?'runtime':'serve'];
    const logDirectory=join(this.root,'.coagent/console-services');await mkdir(logDirectory,{recursive:true,mode:0o700});
    const log=await open(join(logDirectory,`${name}.log`),'a',0o600);
    let child:ChildProcess;
    try{child=spawn(process.execPath,args,{cwd,env,detached:true,stdio:['ignore',log.fd,log.fd]});}finally{await log.close();}
    this.children.set(name,child);
    child.once('error',()=>{this.errors.set(name,'启动失败，请查看本机服务日志');this.children.delete(name);});
    child.once('exit',()=>{if(this.children.get(name)===child)this.children.delete(name);});
    for(let i=0;i<60;i++){
      if(child.exitCode!==null || child.signalCode)throw new AppError('组件已退出，请查看 .coagent/console-services 日志');
      if((await this.state(name)).running){this.errors.delete(name);return;}
      await delay(500);
    }
    this.errors.set(name,'仍在启动，请稍后刷新；不会重复启动进程');
  }
  async stopOwned(){
    if(this.starting)await this.starting;
    for(const name of ['gateway','runtime','bridge'] as Name[]){
      const child=this.children.get(name);if(!child?.pid)continue;
      try{process.kill(-child.pid,'SIGTERM');}catch{}
      for(let i=0;i<40 && child.exitCode===null && !child.signalCode;i++)await delay(100);
      if(child.exitCode===null && !child.signalCode)throw new AppError(`${name} 尚未退出，已保留进程供检查`,409);
      this.children.delete(name);
    }
  }
}
