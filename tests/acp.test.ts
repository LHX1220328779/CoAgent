import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {acpClient} from './acp-client.ts';
import {registerDevin} from '../src/acp/registry.ts';
import type {AcpBackend} from '../src/acp/backend.ts';
class Backend implements AcpBackend{
 url='http://127.0.0.1:4312';task:any;activity:any[]=[];permissions:any[]=[];approved=0;followups=0;replies:string[]=[];gate?:Promise<void>;entered?:()=>void;creates=0;stage=0;
 async ready(){}
 async call(path:string,body?:any):Promise<any>{
  if(path==='/tasks'){this.creates++;this.entered?.();await this.gate;this.task={id:'task-fixture',repo:body.repo,status:'awaiting_approval',prompt:body.prompt};return {task:this.task};}
  if(path.endsWith('/details')){if(this.stage===1){this.stage=2;this.task.status='succeeded';}return {task:{...this.task},sessions:[{role:'sidekick',runtimeID:'ses_worker',title:'原始标题 Worker'},{role:'reviewer',runtimeID:'ses_review',title:'原始标题 Reviewer'}],activity:this.activity,permissions:this.permissions};}
  if(path.endsWith('/approve')||path.endsWith('/followup')){if(path.endsWith('/approve'))this.approved++;else this.followups++;this.task.status='running';this.activity=[{id:'tool_'+(this.approved+this.followups),callID:'call_'+(this.approved+this.followups),role:'sidekick',type:'tool',tool:'local_workspace_run_command',status:'running',input:{command:'node --test',cwd:this.task.repo},output:''}];this.permissions=[{id:'permission_'+this.followups,toolCallID:'call_'+(this.approved+this.followups),permission:'local_workspace_run_command',patterns:['node --test']}];return this.task;}
  if(path.includes('/permissions/')){this.replies.push(body.reply);this.permissions=[];this.activity[0]={...this.activity[0],status:body.reply==='once'?'completed':'error',output:body.reply==='once'?'exit_code: 0':'permission rejected',diff:body.reply==='once'?'--- before\n+++ after\n-old\n+new':undefined};if(body.reply==='once'){this.task.status='reviewing';this.stage=1;}else{this.task.status='failed';this.task.error='permission rejected';}return {};}
  if(path.endsWith('/pause')){this.task.status='paused';return this.task;}
  if(path.endsWith('/release'))return {released:2};
  throw new Error('Unexpected endpoint '+path);
 }
}
async function fixture(){const root=await mkdtemp(join(tmpdir(),'coagent-acp-'));return {root,backend:new Backend(),state:join(root,'sessions'),cleanup:()=>rm(root,{recursive:true,force:true})};}
test('ACP keeps task ownership, original titles, actual tool details, once-only approval, follow-up and persisted replay',async()=>{
 const f=await fixture();let client=acpClient(f.backend,f.state);
 try{await client.call('initialize',{protocolVersion:1});const session=await client.call('session/new',{cwd:f.root,mcpServers:[]});const prompt={sessionId:session.sessionId,prompt:[{type:'text',text:'修复项目'}]};assert.equal((await client.call('session/prompt',prompt)).stopReason,'end_turn');assert.deepEqual(f.backend.replies,['once']);assert.equal(client.permissions[0].toolCall.rawInput.command,'node --test');assert.deepEqual(client.permissions[0].options.map((o:any)=>o.kind),['allow_once','reject_once']);assert.ok(client.updates.some(u=>u.update.content?.text?.includes('原始标题 Worker')));assert.ok(client.updates.some(u=>u.update.rawOutput?.includes('exit_code: 0')));assert.ok(client.updates.some(u=>u.update.content?.[0]?.content?.text?.includes('--- before')));assert.equal((await client.call('session/prompt',{...prompt,prompt:[{type:'text',text:'继续检查'}]})).stopReason,'end_turn');assert.equal(f.backend.followups,1);
  const updates=client.updates.filter(u=>u.update.sessionUpdate!=='available_commands_update');await client.close();client=acpClient(f.backend,f.state);await client.call('initialize',{protocolVersion:1});await client.call('session/load',{sessionId:session.sessionId,cwd:f.root,mcpServers:[]});assert.ok(client.updates.length>=updates.length);assert.ok(client.updates.some(u=>u.update.sessionUpdate==='user_message_chunk'&&u.update.content.text==='继续检查'));assert.equal(f.backend.approved,1);assert.equal(f.backend.followups,1);assert.equal((await client.call('session/list')).sessions[0].sessionId,session.sessionId);
 }finally{await client.close();await f.cleanup();}
});
test('ACP never interprets an unknown approval as allow and never reports a failed task as end_turn',async()=>{
 const f=await fixture(),client=acpClient(f.backend,f.state,()=>({outcome:{outcome:'selected',optionId:'allow_always'}}));try{await client.call('initialize',{protocolVersion:1});const s=await client.call('session/new',{cwd:f.root,mcpServers:[]});await assert.rejects(client.call('session/prompt',{sessionId:s.sessionId,prompt:[{type:'text',text:'work'}]}),(e:any)=>e.code===-32000&&e.data.status==='failed');assert.deepEqual(f.backend.replies,['reject']);}finally{await client.close();await f.cleanup();}
});
test('ACP cancellation during preparation does not approve or start the task after the cancel notification',async()=>{
 const f=await fixture(),client=acpClient(f.backend,f.state);let release!:()=>void,entered!:()=>void;const began=new Promise<void>(resolve=>{entered=resolve;});f.backend.entered=entered;f.backend.gate=new Promise<void>(resolve=>{release=resolve;});try{await client.call('initialize',{protocolVersion:1});const s=await client.call('session/new',{cwd:f.root,mcpServers:[]}),running=client.call('session/prompt',{sessionId:s.sessionId,prompt:[{type:'text',text:'work'}]});await began;client.notify('session/cancel',{sessionId:s.sessionId});await delay(20);release();assert.equal((await running).stopReason,'cancelled');assert.equal(f.backend.approved,0);assert.equal(f.backend.task.status,'paused');}finally{release();await client.close();await f.cleanup();}
});
test('ACP requires initialization and does not silently discard attachments or client MCP servers',async()=>{
 const f=await fixture(),client=acpClient(f.backend,f.state);try{await assert.rejects(client.call('session/new',{cwd:f.root,mcpServers:[]}),(e:any)=>e.code===-32002);await client.call('initialize',{protocolVersion:1});await assert.rejects(client.call('session/new',{cwd:f.root,mcpServers:[{name:'other'}]}),(e:any)=>e.code===-32602);const s=await client.call('session/new',{cwd:f.root,mcpServers:[]});await assert.rejects(client.call('session/prompt',{sessionId:s.sessionId,prompt:[{type:'image',data:'fixture'}]}),(e:any)=>e.code===-32602);assert.equal(f.backend.approved,0);}finally{await client.close();await f.cleanup();}
});
test('Devin registration preserves other agents and rejects malformed files without overwriting them',async()=>{
 const f=await fixture(),path=join(f.root,'registry.json');try{await writeFile(path,JSON.stringify({version:'1.0.0',agents:[{id:'existing'}],extensions:[{id:'keep'}],custom:true}));await registerDevin('/project',path);await registerDevin('/project',path);const r=JSON.parse(await readFile(path,'utf8'));assert.deepEqual(r.agents.map((a:any)=>a.id),['existing','coagent']);assert.deepEqual(r.extensions,[{id:'keep'}]);assert.equal(r.custom,true);assert.equal(r.agents[1].distribution.binary['linux-x86_64'].args[0],'/project/启动CoAgentACP.sh');await writeFile(path,'broken');await assert.rejects(registerDevin('/project',path));assert.equal(await readFile(path,'utf8'),'broken');}finally{await f.cleanup();}
});

test('two ACP processes cannot submit or cancel each other through the same saved session',async()=>{
 const f=await fixture(),first=acpClient(f.backend,f.state),second=acpClient(f.backend,f.state);let release!:()=>void,entered!:()=>void;const began=new Promise<void>(resolve=>{entered=resolve;});f.backend.entered=entered;f.backend.gate=new Promise<void>(resolve=>{release=resolve;});
 try{await first.call('initialize',{protocolVersion:1});await second.call('initialize',{protocolVersion:1});const s=await first.call('session/new',{cwd:f.root,mcpServers:[]}),prompt={sessionId:s.sessionId,prompt:[{type:'text',text:'work'}]},running=first.call('session/prompt',prompt);await began;await assert.rejects(second.call('session/prompt',prompt),(e:any)=>e.code===-32000&&e.message.includes('其他客户端'));await second.close();release();assert.equal((await running).stopReason,'end_turn');assert.equal(f.backend.approved,1);assert.equal(f.backend.creates,1);assert.equal(f.backend.task.status,'succeeded');}finally{release();await first.close();await second.close();await f.cleanup();}
});

test('a permission without a matching native call cannot approve an unrelated visible command',async()=>{
 const f=await fixture(),original=f.backend.call.bind(f.backend);f.backend.call=async(path,body)=>{const result=await original(path,body);if(path.endsWith('/details'))result.permissions=result.permissions.map((p:any)=>({...p,toolCallID:undefined}));return result;};const client=acpClient(f.backend,f.state);
 try{await client.call('initialize',{protocolVersion:1});const s=await client.call('session/new',{cwd:f.root,mcpServers:[]});await assert.rejects(client.call('session/prompt',{sessionId:s.sessionId,prompt:[{type:'text',text:'work'}]}));assert.deepEqual(client.permissions[0].options.map((o:any)=>o.optionId),['reject_once']);assert.deepEqual(f.backend.replies,['reject']);}finally{await client.close();await f.cleanup();}
});

test('the account management entry remains available before login or model readiness',async()=>{
 const f=await fixture();let opened=0;f.backend.ready=async()=>{throw new Error('Arena login needed');};const original=f.backend.call.bind(f.backend);f.backend.call=async(path,body)=>{if(path==='/overview'){opened++;return {};}return original(path,body);};const client=acpClient(f.backend,f.state);
 try{await client.call('initialize',{protocolVersion:1});const s=await client.call('session/new',{cwd:f.root,mcpServers:[]});assert.equal((await client.call('session/prompt',{sessionId:s.sessionId,prompt:[{type:'text',text:'/coagent-console'}]})).stopReason,'end_turn');assert.equal(opened,1);assert.equal(f.backend.creates,0);assert.ok(client.updates.some(u=>u.update.content?.text?.includes(f.backend.url)));}finally{await client.close();await f.cleanup();}
});
