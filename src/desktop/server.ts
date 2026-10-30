import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname, isAbsolute, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError } from '../errors.ts';
import { json, readJSON } from '../http.ts';
import { OpenCodeRuntime } from '../runtime/opencode.ts';
import { git, selectedDirectory, directChanges } from '../supervisor/worktree.ts';
import type { Task } from '../types.ts';
import { LocalServices } from './services.ts';
import {activity} from './activity.ts';
const exec=promisify(execFile);

function arenaUUID(value:unknown){
  if(typeof value!=='string')throw new AppError('请粘贴 Arena Agent 会话网址或 UUID');
  let id=value.trim();
  if(id.startsWith('https://')){const url=new URL(id);if(url.hostname!=='arena.ai')throw new AppError('会话网址必须属于 arena.ai');id=url.pathname.match(/^\/agent\/([^/]+)\/?$/)?.[1]??'';}
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))throw new AppError('无效的 Arena Agent 会话网址或 UUID');return id.toLowerCase();
}
export function createConsole(services:LocalServices){
  const session=randomUUID();
  const runtime=new OpenCodeRuntime(services.urls.runtime,services.env.OPENCODE_SERVER_PASSWORD??'');
  const secretCookie=(req:IncomingMessage)=>{const value=String(req.headers.cookie??'').match(/(?:^|;\s*)coagent_console=([^;]+)/)?.[1]??'';const a=Buffer.from(value),b=Buffer.from(session);return a.length===b.length&&timingSafeEqual(a,b);};
  const bindings=async()=>{try{return JSON.parse(await readFile(resolve(services.root,services.env.ARENA_SESSION_BINDINGS??'.coagent/arena-sessions.json'),'utf8')) as Record<string,string>;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {};throw new AppError('会话绑定文件无法读取',409);}};
  const task=async(id:string)=>services.gateway(`/tasks/${encodeURIComponent(id)}`) as Promise<Task>;
  const sessions=async(t:Task)=>{const all=await services.gateway('/sessions') as any[];return all.filter(s=>s.task_id?s.task_id===t.id:s.directory===t.worktree);};
  return createServer(async(req,res)=>{
    try{
      const host=req.headers.host??'';
      if(!/^(127\.0\.0\.1|localhost):\d+$/.test(host) || (req.headers.origin && req.headers.origin!==`http://${host}`))throw new AppError('只允许从本机控制台访问',403);
      const url=new URL(req.url??'/',`http://${host}`),path=url.pathname;
      res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');
      if(req.method==='GET' && path==='/health'){json(res,200,{app:'coagent-console',root:services.root});return;}
      const assets:Record<string,{file:string;type:string}>={'/':{file:'index.html',type:'text/html; charset=utf-8'},'/app.js':{file:'app.js',type:'text/javascript; charset=utf-8'},'/styles.css':{file:'styles.css',type:'text/css; charset=utf-8'}};
      if(req.method==='GET' && assets[path]){
        const asset=assets[path];res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
        if(path==='/')res.setHeader('set-cookie',`coagent_console=${session}; HttpOnly; SameSite=Strict; Path=/`);
        res.writeHead(200,{'content-type':asset.type,'cache-control':'no-store'});res.end(await readFile(new URL(`./public/${asset.file}`,import.meta.url)));return;
      }
      if(!secretCookie(req) || req.headers['x-coagent-console']!=='1' || req.headers['sec-fetch-site']==='cross-site')throw new AppError('请从本机控制台页面操作',403);
      if(req.method==='GET' && path==='/api/overview'){
        const states=await services.snapshot();let tasks:unknown[]=[];if(states.some(s=>s.name==='gateway'&&s.ready))tasks=await services.gateway('/tasks') as unknown[];
        const pool=services.env.COAGENT_MODE==='arena'&&states.some(s=>s.name==='gateway'&&s.ready)?await services.gateway('/arena/pool').catch(()=>null):null;
        const login=states.some(s=>s.name==='bridge'&&s.running)?await fetch(services.urls.bridge+'/coagent/login/status',{headers:{authorization:`Bearer ${services.env.ARENA_BRIDGE_KEY}`},signal:AbortSignal.timeout(1800)}).then(async r=>r.ok?await r.json():null).catch(()=>null) as any:null;
        json(res,200,{services:states,tasks,mode:services.env.COAGENT_MODE??'mock',pool,pendingLogin:login?.pending?.[0]??null});return;
      }
      if(req.method==='POST' && path==='/api/services/start'){json(res,200,{services:await services.start()});return;}
      if(req.method==='POST' && path==='/api/services/stop'){
        const tasks=await services.gateway('/tasks').catch(()=>[]) as Task[];
        if(tasks.some(t=>['running','reviewing'].includes(t.status)))throw new AppError('请先暂停或取消正在执行的任务，再停止组件',409);
        await services.stopOwned();json(res,200,{services:await services.snapshot()});return;
      }
      if(req.method==='GET' && path==='/api/directories'){
        const directory=url.searchParams.get('path')??homedir();if(!isAbsolute(directory))throw new AppError('请选择绝对路径');
        const entries=await readdir(directory,{withFileTypes:true}).catch(()=>{throw new AppError('无法打开该目录，请确认路径和权限');});
        json(res,200,{path:resolve(directory),parent:dirname(resolve(directory)),directories:entries.filter(e=>e.isDirectory()&&!e.name.startsWith('.')&&!['node_modules','dist','build','coverage'].includes(e.name)).map(e=>e.name).sort((a,b)=>a.localeCompare(b))});return;
      }
      if(req.method==='POST' && path==='/api/bridge/login'){
        const input=await readJSON(req) as any;
        if(typeof input?.email!=='string'||typeof input?.password!=='string'||!input.email.trim()||!input.password)throw new AppError('请填写邮箱和密码');
        const response=await fetch(services.urls.bridge+'/api/accounts/login',{method:'POST',headers:{authorization:`Bearer ${services.env.ARENA_BRIDGE_KEY}`,'content-type':'application/json'},body:JSON.stringify({email:input.email,password:input.password}),signal:AbortSignal.timeout(120000)});
        const result=await response.json().catch(()=>null) as any;if(!response.ok){const stage=({page:'打开 Arena 页面',credentials:'提交账号登录',session:'确认登录状态',network:'连接 Arena'} as Record<string,string>)[result?.error?.stage]??'桥接登录';throw new AppError(`${stage}未成功${result?.error?.upstreamStatus?'，Arena 返回 '+result.error.upstreamStatus:' ('+response.status+')'}。请检查浏览器网络代理，或在 Arena 网页正常完成登录。`,422);}
        const synced=await services.gateway('/arena/pool','POST',{}).catch(()=>null);json(res,200,{ok:true,synced:Boolean(synced)});return;
      }
      if(req.method==='POST'&&path==='/api/arena/sync'){json(res,200,await services.gateway('/arena/pool','POST',{}));return;}
      if(req.method==='POST'&&['/api/bridge/login/start','/api/bridge/login/complete'].includes(path)){
        const input=await readJSON(req),route=path.endsWith('/start')?'start':'complete';const response=await fetch(services.urls.bridge+`/coagent/login/${route}`,{method:'POST',headers:{authorization:`Bearer ${services.env.ARENA_BRIDGE_KEY}`,'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(60000)});const result=await response.json() as any;
        if(!response.ok)throw new AppError(result.error?.message??'网页登录窗口操作未成功',422);if(route==='complete')await services.gateway('/arena/pool','POST',{}).catch(()=>{});json(res,200,result);return;
      }
      if(req.method==='POST' && path==='/api/tasks'){
        const input=await readJSON(req) as any;
        if(typeof input?.repo!=='string'||!isAbsolute(input.repo)||typeof input?.prompt!=='string'||!input.prompt.trim())throw new AppError('请填写项目绝对路径和任务要求');
        const repo=await selectedDirectory(input.repo),workspaceMode=input.workspaceMode??'direct';
        if(!['direct','worktree'].includes(workspaceMode))throw new AppError('请选择有效的工作区模式');
        if(workspaceMode==='worktree')try{if(resolve(await git(repo,'rev-parse','--show-toplevel'))!==repo)throw new AppError('Git 隔离模式请选择仓库根目录');await git(repo,'rev-parse','HEAD');}catch(error){if(error instanceof AppError)throw error;throw new AppError('Git 隔离模式需要已有至少一次提交的仓库');}
        const created=await services.gateway('/tasks','POST',{id:randomUUID(),title:typeof input.title==='string'?input.title:undefined,repo,workspaceMode,prompt:input.prompt,acceptance:input.acceptance,timeoutMs:900000,requiresApproval:true}) as Task[];
        const t=created[0];
        try{await services.gateway(`/tasks/${t.id}/prepare`,'POST');json(res,201,{task:await task(t.id)});}catch(error){json(res,201,{task:await task(t.id),prepareError:error instanceof AppError?error.message:'准备失败，请点击“准备工作区”重试'});}return;
      }
      const match=/^\/api\/tasks\/([a-zA-Z0-9_-]+)(?:\/(details|diff|open-worktree|assign|release|followup|bind|approve|prepare|pause|resume|cancel|permissions\/[^/]+))?$/.exec(path);
      if(match){
        const [,id,action]=match,t=await task(id);
        if(req.method==='GET' && action==='details'){
          const known=await sessions(t),map=await bindings();let permissions:any[]=[];
          if(t.worktree && ['running','reviewing'].includes(t.status)){
            const response=await runtime.request('/permission',t.worktree).catch(()=>null);
            if(response){const all=await response.json() as any[];permissions=all.filter(p=>known.some(s=>s.runtime_id===p.sessionID&&s.role===t.role)).map(p=>({id:p.id,permission:p.permission,patterns:p.patterns,command:typeof p.metadata?.command==='string'?p.metadata.command:undefined}));}
          }
          const pool=await services.gateway('/arena/pool').catch(()=>null) as any;
          const events=t.worktree?await activity(runtime,t.worktree,known):[];
          json(res,200,{task:t,sessions:known.map(s=>{const assigned=pool?.sessions?.find((entry:any)=>entry.task_id===id&&entry.role===s.role);return {role:s.role,runtimeID:s.runtime_id,arenaUUID:assigned?.id??map[s.runtime_id]??null,title:assigned?.title??null,accountEmail:assigned?.account_email??null};}),permissions,activity:events,poolEnabled:Boolean(pool)});return;
        }
        if(req.method==='POST'&&['assign','release'].includes(action??'')){json(res,200,await services.gateway(`/tasks/${id}/${action}`,'POST',{}));return;}
        if(req.method==='POST'&&action==='followup'){
          const input=await readJSON(req) as any;if((await services.snapshot()).some(s=>!s.ready))throw new AppError('请先处理组件或账号状态',409);
          await services.gateway(`/tasks/${id}/followup`,'POST',{prompt:input.prompt});json(res,200,await services.gateway(`/tasks/${id}/approve`,'POST'));return;
        }
        if(req.method==='GET' && action==='diff'){if(!t.worktree)throw new AppError('工作区尚未创建');json(res,200,t.workspaceMode==='direct'?await directChanges(t.worktree):{diff:await git(t.worktree,'diff','HEAD','--'),untracked:await git(t.worktree,'ls-files','--others','--exclude-standard')});return;}
        if(req.method==='POST' && action==='open-worktree'){if(!t.worktree)throw new AppError('工作区尚未创建');await exec('xdg-open',[t.worktree],{timeout:10000}).catch(()=>{throw new AppError('无法打开文件管理器，请使用页面显示的代码目录');});json(res,200,{ok:true});return;}
        if(req.method==='POST' && action==='bind'){
          const input=await readJSON(req) as any,worker=arenaUUID(input?.worker),reviewer=arenaUUID(input?.reviewer);if(worker===reviewer)throw new AppError('Sidekick 和 Reviewer 必须使用不同的 Arena 会话');
          if(!['awaiting_approval','failed','paused'].includes(t.status))throw new AppError('请在任务尚未执行或已停止时绑定会话',409);
          const tasks=await services.gateway('/tasks') as Task[];if(t.workspaceMode==='direct'&&tasks.some(other=>other.id!==t.id&&other.worktree===t.worktree&&['running','reviewing'].includes(other.status)))throw new AppError('同一目录的会话正在被其他任务使用，请先等待该任务结束',409);
          const known=await sessions(t),w=known.find(s=>s.role===t.role),r=known.find(s=>s.role==='reviewer');if(!w||!r)throw new AppError('请先点击“准备工作区”',409);
          const map=await bindings();for(const [sessionID,uuid] of [[w.runtime_id,worker],[r.runtime_id,reviewer]])if(Object.entries(map).some(([key,value])=>key!==sessionID&&String(value).toLowerCase()===uuid))throw new AppError('该 Arena 会话已绑定其他任务，请使用未绑定的独立会话',409);
          for(const [sessionID,arenaSessionID] of [[w.runtime_id,worker],[r.runtime_id,reviewer]])await services.gateway('/arena/bindings','POST',{sessionID,arenaSessionID});json(res,200,{ok:true});return;
        }
        if(req.method==='POST' && action?.startsWith('permissions/')){
          if(!['running','reviewing'].includes(t.status))throw new AppError('只能处理当前正在执行任务的工具审批',409);
          const requestID=decodeURIComponent(action.slice('permissions/'.length)),input=await readJSON(req) as any;if(!['once','reject'].includes(input?.reply))throw new AppError('只允许本次批准或拒绝');
          if(!t.worktree)throw new AppError('工作区尚未创建');const known=await sessions(t),worker=known.find(s=>s.role===t.role);
          const pending=await runtime.request('/permission',t.worktree).then(r=>r.json()) as any[];
          if(!pending.some(p=>p.id===requestID&&p.sessionID===worker?.runtime_id)||t.role!=='sidekick')throw new AppError('该审批不属于当前 Sidekick 会话或已处理',409);
          await runtime.request(`/permission/${encodeURIComponent(requestID)}/reply`,t.worktree,'POST',{reply:input.reply});json(res,200,{ok:true});return;
        }
        if(req.method==='POST' && ['approve','prepare','pause','resume','cancel'].includes(action??'')){
          if(action==='approve'||action==='resume'){
            const states=await services.snapshot();if(states.some(s=>!s.ready))throw new AppError('请先处理页面顶部的服务或账号状态',409);
            if(services.env.COAGENT_MODE==='arena'){const known=await sessions(t),map=await bindings();if(!known.some(s=>s.role===t.role&&map[s.runtime_id])||!known.some(s=>s.role==='reviewer'&&map[s.runtime_id]))throw new AppError('请先绑定 Sidekick 和 Reviewer 会话',409);}
          }
          json(res,200,await services.gateway(`/tasks/${id}/${action}`,'POST'));return;
        }
      }
      throw new AppError('页面接口不存在',404);
    }catch(error){
      if(res.destroyed)return;
      json(res,error instanceof AppError?error.status:500,{error:{message:error instanceof AppError?error.message:'本机操作未成功，请检查组件是否运行和目录是否可访问'}});
    }
  });
}
