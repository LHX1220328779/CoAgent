import {randomUUID} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {selectedDirectory} from '../supervisor/worktree.ts';
import {RpcError,RpcPeer} from './rpc.ts';
import {AcpSessions,type AcpSession} from './sessions.ts';
import type {AcpBackend} from './backend.ts';
type Active={session:AcpSession;owns:boolean;controlsTask:boolean;cancelled:boolean;permissions:Map<string,()=>void>;setup:Promise<void>;settled:()=>void;stopping?:Promise<void>;error?:unknown};
const terminal=new Set(['succeeded','failed','paused','canceled','blocked']);
const commands=[{name:'coagent-acceptance',description:'在首次任务前设置外部验收 argv',input:{hint:'["npm","test"]'}},{name:'coagent-status',description:'查看任务、Agent 原始标题及控制台地址'},{name:'coagent-assign',description:'准备任务并自动分配空闲会话，不开始模型执行'},{name:'coagent-resume',description:'显式恢复已停止任务，保留完成的审查检查点'},{name:'coagent-release',description:'显式解绑并归还该任务的 Arena 会话'},{name:'coagent-console',description:'打开账号登录和任务管理入口'}];
function tool(event:any){const name=String(event.tool??'tool'),input=event.input??{},kind=/bash|command/.test(name)?'execute':/edit|write|patch/.test(name)?'edit':/read/.test(name)?'read':/search|glob|list|find/.test(name)?'search':'other';
  const output=[event.error,event.output,event.diff].filter(value=>typeof value==='string'&&value.length>0).join('\n\n'),paths=[input.filePath,input.path,...(Array.isArray(input.files)?input.files.map((f:any)=>f.path):[])].filter((p:unknown)=>typeof p==='string'&&isAbsolute(p));
  return {toolCallId:event.id,title:((event.role==='reviewer'?'Reviewer':'Sidekick')+' · '+name+(input.command?' · '+input.command:'')).slice(0,500),kind,status:({pending:'pending',running:'in_progress',completed:'completed',error:'failed'} as any)[event.status]??'pending',rawInput:input,...(output?{rawOutput:output,content:[{type:'content',content:{type:'text',text:String(output)}}]}:{}),locations:paths.map(path=>({path})),_meta:{'coagent/role':event.role}};
}
export class CoAgentAcp{
  private peer:RpcPeer;private backend:AcpBackend;private sessions:AcpSessions;private initialized=false;private active=new Map<string,Active>();private closing=false;
  constructor(peer:RpcPeer,backend:AcpBackend,sessions:AcpSessions){this.peer=peer;this.backend=backend;this.sessions=sessions;}
  private async update(id:string,update:any){await this.sessions.append(id,update);this.peer.notify('session/update',{sessionId:id,update});}
  private text(id:string,text:string){return this.update(id,{sessionUpdate:'agent_message_chunk',content:{type:'text',text}});}
  private capabilities(){return {modes:{currentModeId:'build',availableModes:[{id:'build',name:'协作开发',description:'OpenCode Sidekick 执行，独立 Reviewer 审查'}]}};}
  private announce(id:string){this.peer.notify('session/update',{sessionId:id,update:{sessionUpdate:'available_commands_update',availableCommands:commands}});}
  private checkMcp(params:any){if(!Array.isArray(params.mcpServers)||params.mcpServers.length)throw new RpcError(-32602,'此入口使用 CoAgent 已配置的 MCP；请将客户端额外 mcpServers 设为空数组');}
  async handle(method:string,params:any){
    if(method==='initialize'){if(!Number.isInteger(params.protocolVersion))throw new RpcError(-32602,'protocolVersion 必须为整数');this.initialized=true;return {protocolVersion:1,agentInfo:{name:'coagent',title:'CoAgent · OpenCode 协作开发',version:'0.1.0'},agentCapabilities:{loadSession:true,sessionCapabilities:{list:{}},promptCapabilities:{image:false,audio:false,embeddedContext:false},mcpCapabilities:{http:false,sse:false}},authMethods:[],_meta:{'coagent/consoleUrl':this.backend.url}};}
    if(!this.initialized)throw new RpcError(-32002,'请先初始化 ACP');
    if(method==='session/new'){this.checkMcp(params);if(typeof params.cwd!=='string'||!isAbsolute(params.cwd))throw new RpcError(-32602,'请选择项目绝对目录');const cwd=await selectedDirectory(params.cwd),session={id:'acp_'+randomUUID(),cwd,title:'新开发会话',updatedAt:new Date().toISOString()};await this.sessions.save(session);this.announce(session.id);return {sessionId:session.id,...this.capabilities()};}
    if(method==='session/list'){const all=(await this.sessions.list()).filter(s=>!params.cwd||s.cwd===params.cwd).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id)),offset=params.cursor===undefined?0:Number(params.cursor);if(!Number.isSafeInteger(offset)||offset<0)throw new RpcError(-32602,'无效的会话游标');return {sessions:all.slice(offset,offset+50).map(s=>({sessionId:s.id,cwd:s.cwd,title:s.title,updatedAt:s.updatedAt})),...(offset+50<all.length?{nextCursor:String(offset+50)}:{})};}
    if(!['session/load','session/set_mode','session/cancel','session/prompt'].includes(method))throw new RpcError(-32601,'Method not found');
    const session=await this.sessions.get(params.sessionId);
    if(method==='session/load'){this.checkMcp(params);if(typeof params.cwd!=='string'||await selectedDirectory(params.cwd)!==session.cwd)throw new RpcError(-32602,'加载目录必须与原会话项目一致');if(this.active.has(session.id))throw new RpcError(-32000,'会话正在执行');if(session.taskID){const d=await this.backend.call('/tasks/'+session.taskID+'/details');if(['running','reviewing','queued'].includes(d.task.status))throw new RpcError(-32000,'该任务正在其他窗口执行，请先在控制台暂停');}await this.sessions.replay(session.id,update=>this.peer.notify('session/update',{sessionId:session.id,update}));this.announce(session.id);return this.capabilities();}
    if(method==='session/set_mode'){if(params.modeId!=='build')throw new RpcError(-32602,'目前只提供协作开发模式');return {};}
    if(method==='session/cancel'){await this.cancel(session);return;}
    if(method==='session/prompt')return this.prompt(session,params.prompt);
    throw new RpcError(-32601,'Method not found');
  }
  private async stop(session:AcpSession,active:Active){
    if(!active.stopping)active.stopping=(async()=>{await active.setup;if(!active.owns||!active.controlsTask||!session.taskID)return;const detail=await this.backend.call('/tasks/'+session.taskID+'/details');if(!terminal.has(detail.task.status))await this.backend.call('/tasks/'+session.taskID+'/pause',{});})();await active.stopping;
  }
  private async cancel(session:AcpSession){const active=this.active.get(session.id);if(!active)return;active.cancelled=true;for(const cancel of active.permissions.values())cancel();active.permissions.clear();await this.stop(active.session,active);}
  async close(){this.closing=true;await Promise.allSettled([...this.active.values()].map(active=>this.cancel(active.session)));}
  private async prompt(session:AcpSession,blocks:any){
    if(this.closing||this.active.has(session.id))throw new RpcError(-32000,'会话仍在执行或正在关闭');
    if(!Array.isArray(blocks)||!blocks.length||blocks.some(b=>b?.type!=='text'||typeof b.text!=='string'))throw new RpcError(-32602,'当前 ACP 入口只接收文本，请通过项目工具读取文件');const text=blocks.map(b=>b.text).join('\n').trim();if(!text)throw new RpcError(-32602,'请输入任务要求');
    let settled!:()=>void;const active:Active={session,owns:false,controlsTask:false,cancelled:false,permissions:new Map(),setup:new Promise<void>(resolve=>{settled=resolve;}),settled:()=>settled()};this.active.set(session.id,active);
    const seen=new Map<string,string>(),texts=new Map<string,string>(),asked=new Set<string>();let lastStatus='',releaseLock:(()=>Promise<void>)|undefined;
    try{
      releaseLock=await this.sessions.acquire(session.id);active.owns=true;
      const acceptance=text.match(/^\/coagent-acceptance\s+([\s\S]+)$/)?.[1];
      if(acceptance){if(session.taskID)throw new RpcError(-32602,'请在新会话首次任务前设置验收命令');let argv:any;try{argv=JSON.parse(acceptance);}catch{throw new RpcError(-32602,'验收命令须为 JSON argv 数组');}if(!Array.isArray(argv)||!argv.length||argv.some(v=>typeof v!=='string')||!argv[0]||argv[0].startsWith('-'))throw new RpcError(-32602,'无效的验收 argv');session.acceptance=argv;await this.sessions.save(session);active.settled();await this.text(session.id,'已设置外部验收：'+JSON.stringify(argv)+'\n');return {stopReason:'end_turn'};}
      const command=text.match(/^\/coagent-(status|assign|resume|release|console)$/)?.[1];
      if(command==='console'){await this.backend.call('/overview');active.settled();await this.text(session.id,'账号登录与任务管理：'+this.backend.url+'\n');return {stopReason:'end_turn'};}
      if(command&&command!=='resume'){
        if(!session.taskID){active.settled();await this.text(session.id,'尚未提交开发任务。管理入口：'+this.backend.url+'\n');return {stopReason:'end_turn'};}
        if(command==='assign'){const current=await this.backend.call('/tasks/'+session.taskID+'/details');await this.backend.call('/tasks/'+session.taskID+(current.sessions.length===2?'/assign':'/prepare'),{});}
        if(command==='release')await this.backend.call('/tasks/'+session.taskID+'/release',{});
        const detail=await this.backend.call('/tasks/'+session.taskID+'/details');active.settled();await this.text(session.id,JSON.stringify({status:detail.task.status,agents:detail.sessions.map((s:any)=>({role:s.role,title:s.title,account:s.accountEmail})),console:this.backend.url},null,2)+'\n');return {stopReason:'end_turn'};
      }
      await this.backend.ready();if(active.cancelled){active.settled();await this.stop(session,active);return {stopReason:'cancelled'};}
      let detail:any;
      if(command==='resume'){
        if(!session.taskID)throw new RpcError(-32602,'当前会话还没有任务');detail=await this.backend.call('/tasks/'+session.taskID+'/details');
      }else{
        await this.sessions.append(session.id,{sessionUpdate:'user_message_chunk',content:{type:'text',text}});
        if(!session.taskID){const result=await this.backend.call('/tasks',{repo:session.cwd,workspaceMode:'direct',prompt:text,title:text.slice(0,80),acceptance:session.acceptance});session.taskID=result.task.id;active.controlsTask=true;session.title=text.slice(0,80);session.pendingPrompt=true;await this.sessions.save(session);if(result.prepareError)throw new RpcError(-32000,result.prepareError+'；请处理后使用 /coagent-assign，管理入口：'+this.backend.url);}
        detail=await this.backend.call('/tasks/'+session.taskID+'/details');
      }
      if(['running','reviewing','queued'].includes(detail.task.status))throw new RpcError(-32000,'该任务正在其他窗口执行，请先等待或暂停');
      // Seed the cursor with old output; follow-ups must not replay it as new work.
      for(const event of detail.activity??[]){if(event.type==='tool')seen.set(event.id,JSON.stringify(tool(event)));else if(event.type==='text')texts.set(event.id,event.text);}
      for(const role of detail.sessions??[])await this.text(session.id,(role.role==='reviewer'?'Reviewer':'Sidekick')+'：'+(role.title??'尚未分配')+(role.accountEmail?' · '+role.accountEmail:'')+'\n');
      active.settled();if(active.cancelled){await this.stop(session,active);return {stopReason:'cancelled'};}
      active.controlsTask=true;
      if(command==='resume'){session.pendingPrompt=false;await this.sessions.save(session);await this.backend.call('/tasks/'+session.taskID+(detail.task.status==='awaiting_approval'?'/approve':'/resume'),{});}
      else if(session.pendingPrompt){session.pendingPrompt=false;await this.sessions.save(session);await this.backend.call('/tasks/'+session.taskID+'/approve',{});}
      else await this.backend.call('/tasks/'+session.taskID+'/followup',{prompt:text});
      for(;;){
        if(active.error)throw active.error;
        if(active.cancelled)await this.stop(session,active);
        detail=await this.backend.call('/tasks/'+session.taskID+'/details');
        if(detail.task.status!==lastStatus){lastStatus=detail.task.status;await this.text(session.id,'任务状态：'+lastStatus+'\n');}
        for(const event of detail.activity??[]){
          if(event.type==='tool'){const value=tool(event),serialized=JSON.stringify(value),previous=seen.get(event.id);if(previous!==serialized){await this.update(session.id,{sessionUpdate:previous?'tool_call_update':'tool_call',...value});seen.set(event.id,serialized);}}
          else if(event.type==='text'&&event.role!=='user'){const previous=texts.get(event.id)??'';if(event.text!==previous){const delta=event.text.startsWith(previous)?event.text.slice(previous.length):'\n'+event.text;await this.text(session.id,(previous?'':'\n'+(event.role==='reviewer'?'Reviewer':'Sidekick')+'：\n')+delta);texts.set(event.id,event.text);}}
        }
        if(terminal.has(detail.task.status)){
          if(detail.task.error)await this.text(session.id,'执行结果：'+detail.task.error+'\n');
          if(active.cancelled)return {stopReason:'cancelled'};
          if(detail.task.status!=='succeeded')throw new RpcError(-32000,'任务未通过：'+(detail.task.error??detail.task.status),{taskId:session.taskID,status:detail.task.status});
          return {stopReason:'end_turn',_meta:{'coagent/taskId':session.taskID,'coagent/status':detail.task.status}};
        }
        for(const permission of detail.permissions??[]){if(asked.has(permission.id)||active.cancelled)continue;asked.add(permission.id);
          const event=permission.toolCallID?(detail.activity??[]).find((e:any)=>e.type==='tool'&&e.role==='sidekick'&&e.callID===permission.toolCallID):undefined;
          const call=event?tool(event):{toolCallId:permission.id,title:permission.command??permission.permission+'（未关联操作详情）',kind:'execute',status:'pending',rawInput:{command:permission.command,patterns:permission.patterns}};
          const canAllow=Boolean(event||permission.command),options=[...(canAllow?[{optionId:'allow_once',name:'仅本次允许',kind:'allow_once'}]:[]),{optionId:'reject_once',name:'拒绝',kind:'reject_once'}];
          const request=this.peer.request('session/request_permission',{sessionId:session.id,toolCall:call,options});active.permissions.set(permission.id,request.cancel);
          void request.result.then(async result=>{if(active.cancelled||this.active.get(session.id)!==active)return;const reply=canAllow&&result?.outcome?.outcome==='selected'&&result.outcome.optionId==='allow_once'?'once':'reject';await this.backend.call('/tasks/'+session.taskID+'/permissions/'+encodeURIComponent(permission.id),{reply});}).catch(error=>{active.error=error;}).finally(()=>active.permissions.delete(permission.id));
        }
        await delay(750);
      }
    }catch(error){active.settled();if(active.cancelled){await this.stop(session,active);return {stopReason:'cancelled'};}await this.stop(session,active).catch(()=>{});throw error;}
    finally{active.settled();for(const cancel of active.permissions.values())cancel();active.permissions.clear();this.active.delete(session.id);if(active.owns){try{session.updatedAt=new Date().toISOString();await this.sessions.save(session);}finally{await releaseLock?.();}}}
  }
}
