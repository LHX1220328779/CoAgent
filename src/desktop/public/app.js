'use strict';
const $=id=>document.getElementById(id);
const labels={awaiting_approval:'等待确认',queued:'已排队',running:'正在实现',reviewing:'独立审查',succeeded:'已完成',failed:'需要处理',paused:'已暂停',canceled:'已取消',blocked:'依赖未完成'};
const state={tasks:[],services:[],mode:'arena',selected:null,detail:null,loading:false,busy:false,directory:null};
function element(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;}
function notice(message,error=false){$('notice').hidden=!message;$('notice').textContent=message;$('notice').classList.toggle('error',error);}
async function api(path,body){const response=await fetch('/api'+path,{method:body===undefined?'GET':'POST',headers:{'x-coagent-console':'1','content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw new Error(data.error?.message||`请求失败 (${response.status})`);return data;}
async function action(button,work){if(state.busy)return;state.busy=true;button.disabled=true;try{await work();}catch(error){notice(error.message,true);}finally{state.busy=false;button.disabled=false;await refresh();}}
function button(text,className,callback){const node=element('button',className,text);node.type='button';node.addEventListener('click',()=>action(node,callback));return node;}
function renderServices(){
  $('services').replaceChildren();const names={bridge:'Arena 桥接',runtime:'OpenCode 本地工具',gateway:'任务调度'};
  for(const service of state.services){const card=element('div','service');card.append(element('span',`dot ${service.ready?'ok':service.running?'':'off'}`));const content=element('div');content.append(element('strong','',names[service.name]),element('p','',service.message),element('p','address',service.url));card.append(content);$('services').append(card);}
  const ready=state.services.length>0&&state.services.every(s=>s.ready);$('summary').textContent=ready?'● 组件已就绪':'● 请处理下方状态';$('mode').textContent=state.mode==='arena'?'Arena 网页会话':state.mode;
  const bridge=state.services.find(s=>s.name==='bridge');$('account-panel').hidden=!bridge?.running||bridge.ready;$('stop').disabled=!state.services.some(s=>s.managed)||state.busy;
  if(bridge){$('account-message').textContent=bridge.message;if(bridge.url)$('bridge-link').href=bridge.url;if(!$('email').value&&bridge.accounts?.[0]?.email)$('email').value=bridge.accounts[0].email;}
}
function renderTasks(){
  $('tasks').replaceChildren();$('task-count').textContent=String(state.tasks.length);
  for(const task of [...state.tasks].sort((a,b)=>b.createdAt-a.createdAt)){
    const item=element('button',`task-item${task.id===state.selected?' selected':''}`);item.append(element('strong','',task.title));const small=element('small');small.append(element('span','',labels[task.status]||task.status),element('span','',new Date(task.createdAt).toLocaleDateString()));item.append(small);item.addEventListener('click',async()=>{if(state.busy)return;state.selected=task.id;state.detail=null;renderTasks();await loadDetail(true);});$('tasks').append(item);
  }
  $('recent-projects').replaceChildren(...[...new Set(state.tasks.map(t=>t.repo))].map(repo=>{const option=document.createElement('option');option.value=repo;return option;}));
}
async function loadDetail(force=false){
  if(!state.selected)return;const id=state.selected;const detail=await api(`/tasks/${id}/details`);if(state.selected!==id)return;
  const previous=JSON.stringify(state.detail),next=JSON.stringify(detail);state.detail=detail;
  if(force||previous!==next){const panel=$('task-panel');if(!force&&panel.contains(document.activeElement)&&['INPUT','TEXTAREA'].includes(document.activeElement.tagName))return;renderDetail();}
}
function renderDetail(){
  const detail=state.detail;if(!detail)return;const {task,sessions,permissions}=detail,panel=$('task-panel');panel.replaceChildren();
  const heading=element('div','task-heading'),title=element('div');title.append(element('h2','',task.title),element('p','path',task.repo));heading.append(title,element('span',`pill ${task.status}`,labels[task.status]||task.status));panel.append(heading);
  const stepper=element('div','stepper');const stage=task.status==='succeeded'?4:task.status==='reviewing'?3:['running','failed','paused'].includes(task.status)?2:task.worktree?1:0;
  ['准备工作区','绑定会话','实现与测试','独立审查','完成'].forEach((name,i)=>stepper.append(element('div',`step${i<=stage?' done':''}`,name)));panel.append(stepper,element('p','task-prompt',task.prompt));
  if(task.error)panel.append(element('p','error-text',task.error));
  if(permissions.length){for(const permission of permissions){const box=element('section','box warm');box.append(element('h3','','需要批准本地工具'),element('pre','',permission.command||JSON.stringify(permission.patterns??permission.permission)),element('p','hint',`工作区：${task.worktree}`));const row=element('div','actions');row.append(button('仅本次允许','primary',async()=>{await api(`/tasks/${task.id}/permissions/${encodeURIComponent(permission.id)}`,{reply:'once'});notice('已批准本次工具调用');}),button('拒绝','danger',async()=>{await api(`/tasks/${task.id}/permissions/${encodeURIComponent(permission.id)}`,{reply:'reject'});notice('已拒绝该工具调用');}));box.append(row);panel.append(box);}}
  if(task.worktree&&state.mode==='arena'){
    const active=['running','reviewing','succeeded','canceled'].includes(task.status),form=element('form','box');form.append(element('h3','','Arena 会话绑定'),element('p','hint','粘贴两条独立会话的网址即可，系统自动关联本地 Agent。新任务请使用尚未绑定其他任务的会话。'));
    const inputs={};for(const role of [task.role,'reviewer']){const session=sessions.find(s=>s.role===role),label=element('label','',role==='reviewer'?'Reviewer · 独立审查':'Sidekick · 编程实现'),row=element('div','binding-row'),input=document.createElement('input');input.placeholder='https://arena.ai/agent/…';input.value=session?.arenaUUID?`https://arena.ai/agent/${session.arenaUUID}`:'';input.required=true;input.disabled=active;inputs[role]=input;row.append(input);if(session?.arenaUUID){const link=element('a','','打开会话');link.href=`https://arena.ai/agent/${session.arenaUUID}`;link.target='_blank';link.rel='noopener noreferrer';row.append(link);}label.append(row);form.append(label);}
    if(!active){const save=element('button','secondary','保存会话绑定');save.type='submit';form.append(save);form.addEventListener('submit',event=>{event.preventDefault();action(save,async()=>{await api(`/tasks/${task.id}/bind`,{worker:inputs[task.role].value,reviewer:inputs.reviewer.value});notice('两条会话已绑定，可以批准开始');});});}panel.append(form);
  }
  const actions=element('div','actions');
  if(!task.worktree)actions.append(button('准备工作区','secondary',async()=>{await api(`/tasks/${task.id}/prepare`,{});notice('工作区和会话已准备');}));
  if(task.status==='awaiting_approval')actions.append(button('批准并开始','primary',async()=>{await api(`/tasks/${task.id}/approve`,{});notice('任务已开始，等待工具审批时会在这里显示');}));
  if(['running','reviewing','queued'].includes(task.status))actions.append(button('暂停任务','secondary',async()=>{await api(`/tasks/${task.id}/pause`,{});notice('本地任务已暂停，请同时确认对应网页会话状态');}));
  if(['failed','paused','blocked'].includes(task.status))actions.append(button('恢复任务','primary',async()=>{if(!window.confirm('请先确认原网页回合已结束，并检查已执行的修改。现在继续此任务？'))return;await api(`/tasks/${task.id}/resume`,{});notice('已恢复原任务');}));
  if(!['succeeded','canceled'].includes(task.status))actions.append(button('取消任务','quiet',async()=>{if(!window.confirm('取消本地任务并保留工作树？请同时确认网页执行状态。'))return;await api(`/tasks/${task.id}/cancel`,{});notice('任务已取消，工作树保留');}));
  if(task.worktree)actions.append(button('查看代码改动','secondary',async()=>{const diff=await api(`/tasks/${task.id}/diff`);$('diff-output')?.remove();const output=element('pre','',`${diff.diff||'暂无已跟踪文件改动'}${diff.untracked?`\n\n新增文件：\n${diff.untracked}`:''}`);output.id='diff-output';panel.append(output);}));panel.append(actions);
  if(task.worktree)actions.append(button('打开工作区','quiet',async()=>{await api(`/tasks/${task.id}/open-worktree`,{});notice('已请求在文件管理器打开任务代码目录');}));
  if(task.acceptance)panel.append(element('p','status-text',`外部验收：${task.acceptance.join(' ')}`));else panel.append(element('p','status-text','本任务未配置外部验收测试。'));
  if(task.worktree)panel.append(element('p','path',`代码目录：${task.worktree}`));
  if(task.result){const result=element('section','result');result.append(element('h3','','Worker 报告'),element('pre','',task.result));panel.append(result);}
  if(task.status==='succeeded')panel.append(element('p','hint','独立审查已通过。请查看实际改动，在工作树中审核、提交后再合入原项目；操作步骤见项目根目录《使用手册.md》。'));
  panel.append(element('p','task-id',`任务 ${task.id}`));
}
async function refresh(){if(state.loading)return;state.loading=true;try{const overview=await api('/overview');Object.assign(state,{tasks:overview.tasks,services:overview.services,mode:overview.mode});renderServices();if(!state.selected&&state.tasks.length)state.selected=[...state.tasks].sort((a,b)=>b.createdAt-a.createdAt)[0].id;renderTasks();await loadDetail();}catch(error){notice(error.message,true);}finally{state.loading=false;}}
$('connect').addEventListener('click',()=>action($('connect'),async()=>{notice('正在连接已有组件，缺少的组件将自动启动…');await api('/services/start',{});notice('组件连接已完成，请查看账号状态');}));
$('stop').addEventListener('click',()=>action($('stop'),async()=>{await api('/services/stop',{});notice('已停止本控制台启动的组件；原先已运行的服务继续保留');}));
$('login-form').addEventListener('submit',event=>{event.preventDefault();action($('login'),async()=>{notice('正在登录桥接，请稍候…');try{await api('/bridge/login',{email:$('email').value,password:$('password').value});notice('登录成功');}finally{$('password').value='';}});});
$('task-form').addEventListener('submit',event=>{event.preventDefault();action($('create'),async()=>{const program=$('program').value.trim(),args=$('arguments').value.split('\n').map(s=>s.trim()).filter(Boolean);if(!program&&args.length)throw new Error('填写参数时也需要填写程序名称');const result=await api('/tasks',{repo:$('repo').value.trim(),prompt:$('prompt').value,acceptance:program?[program,...args]:undefined});state.selected=result.task.id;state.detail=null;notice(result.prepareError?`任务已创建，但尚未就绪：${result.prepareError}`:'工作区已准备，请在右侧粘贴两条 Arena 会话网址',Boolean(result.prepareError));});});
async function openDirectory(path){const data=await api('/directories'+(path?'?path='+encodeURIComponent(path):''));state.directory=data;$('directory-path').textContent=data.path;$('directories').replaceChildren(...data.directories.map(name=>button('▸  '+name,'directory',()=>openDirectory(data.path.replace(/\/$/,'')+'/'+name))));$('parent-directory').disabled=data.parent===data.path;}
$('browse').addEventListener('click',()=>action($('browse'),async()=>{await openDirectory($('repo').value||undefined);$('directory-dialog').showModal();}));
$('close-directory').addEventListener('click',()=>$('directory-dialog').close());
$('parent-directory').addEventListener('click',()=>action($('parent-directory'),()=>openDirectory(state.directory.parent)));
$('choose-directory').addEventListener('click',()=>{$('repo').value=state.directory.path;$('directory-dialog').close();});
void refresh();setInterval(()=>{if(!state.busy)void refresh();},4000);
