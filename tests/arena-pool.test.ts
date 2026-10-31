import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {Store} from '../src/supervisor/store.ts';
import {Orchestrator,taskFromInput} from '../src/supervisor/orchestrator.ts';
import {GitWorktrees} from '../src/supervisor/worktree.ts';
import {ArenaAgentAdapter} from '../src/gateway/adapters.ts';
import {ArenaPool} from '../src/arena/pool.ts';
import {FakeRuntime,repoFixture} from './helpers.ts';
test('task reservations are exclusive, atomic, persistent, preserve titles and require explicit release',async()=>{
 const fixture=await repoFixture(),path=join(fixture.root,'state.db'),store=new Store(path),runtime=new FakeRuntime(),orch=new Orchestrator(store,runtime,new GitWorktrees(join(fixture.root,'trees')));let closed=false;
 let title='原有会话标题 · 中文与 spaces',visible=true;const bridge=createServer((req,res)=>{assert.equal(req.headers.authorization,'Bearer pool-fixture-key');res.setHeader('content-type','application/json');res.end(JSON.stringify({accounts:[1,2].map(n=>({email:`owner${n}@example.invalid`,available:true})),syncedAt:Date.now(),sessions:(visible?[1,2]:[]).map(n=>({id:`00000000-0000-0000-0000-00000000000${n}`,title:title+String(n),accountEmail:`owner${n}@example.invalid`,available:true}))}));});bridge.listen(0,'127.0.0.1');await once(bridge,'listening');
 const bindingFile=join(fixture.root,'bindings.json'),adapter=new ArenaAgentAdapter(`http://127.0.0.1:${(bridge.address() as {port:number}).port}/v1`,'pool-fixture-key',bindingFile),pool=new ArenaPool(store,adapter);
 try{
  store.add(['a','b'].map(id=>taskFromInput({id,prompt:'A task',repo:fixture.repo,workspaceMode:'direct'})));
  const [a,b]=await Promise.all([orch.prepare('a'),orch.prepare('b')]);assert.notEqual(a.worker.runtimeID,b.worker.runtimeID);
  await pool.refresh();const assigned=await Promise.allSettled([pool.assign('a'),pool.assign('b')]);assert.equal(assigned[0].status,'fulfilled');assert.equal(assigned[1].status,'rejected');assert.equal(pool.assignments('a').length,2);assert.equal(pool.assignments('b').length,0);
  assert.equal((pool.snapshot().sessions[0] as any).title,title+'1');store.update('a',{status:'succeeded'});await assert.rejects(pool.assign('b'),{code:'arena_sessions_unavailable'});
  visible=false;await pool.refresh();assert.doesNotThrow(()=>pool.ready('a'),'a partial history must not invalidate an existing reservation');visible=true;await pool.refresh();
  await pool.release('a');assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM arena_successful_sessions').get()!.n,2);
  // A newly discovered but untested session must not displace a successful one.
  store.db.prepare('INSERT INTO arena_catalog VALUES(?,?,?,?,?)').run('00000000-0000-0000-0000-000000000000','owner3@example.invalid','未测试会话',1,Date.now()+1000);
  await pool.assign('b');assert.ok(pool.assignments('b').every((s:any)=>s.arena_id!=='00000000-0000-0000-0000-000000000000'));const bindings=JSON.parse(await readFile(bindingFile,'utf8'));assert.equal(bindings[a.worker.runtimeID],undefined);assert.ok(bindings[b.worker.runtimeID]);assert.equal(pool.assignments('a').length,0);
  title='原网页更新的标题 ';await pool.refresh();assert.equal((pool.assignments('b')[0] as any).title,title+'2');
  store.update('b',{status:'running'});await assert.rejects(pool.release('b'),{status:409});store.update('b',{status:'paused'});
  await orch.close();store.close();closed=true;const reopened=new Store(path);try{assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM arena_leases').get()!.n,2);assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM task_agent_sessions').get()!.n,4);}finally{reopened.close();}
 }finally{if(!closed){await orch.close();store.close();}bridge.closeAllConnections();await new Promise<void>(done=>bridge.close(()=>done()));await fixture.cleanup();}
});
test('pending workers use less loaded accounts without rebinding existing tasks or counting completed reservations as work',async()=>{
 const fixture=await repoFixture(),store=new Store(join(fixture.root,'state.db')),runtime=new FakeRuntime(),orch=new Orchestrator(store,runtime,new GitWorktrees(join(fixture.root,'trees')));
 const adapter=new ArenaAgentAdapter('http://127.0.0.1:20140/v1','fixture',join(fixture.root,'bindings.json')),pool=new ArenaPool(store,adapter);
 try{
  store.add(['history','a','b','c','d'].map(id=>taskFromInput({id,prompt:'A task',repo:fixture.repo,workspaceMode:'direct'})));store.update('history',{status:'succeeded'});
  for(let n=1;n<=12;n++){
   const id=`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
   store.db.prepare('INSERT INTO arena_catalog VALUES(?,?,?,?,?)').run(id,n<=6?'owner1@example.invalid':'owner2@example.invalid','原始标题 '+n,1,1);
   if(n<=6)store.db.prepare('INSERT INTO arena_successful_sessions VALUES(?,?,?)').run(id,'history',1);
  }
  await orch.prepare('a');await orch.prepare('b');await orch.prepare('c');await orch.prepare('d');
  await pool.assign('a');const original=pool.assignments('a');assert.ok(original.every((s:any)=>s.account_email==='owner1@example.invalid'));
  await pool.assign('b');assert.equal((pool.assignments('b').find((s:any)=>s.role==='sidekick') as any).account_email,'owner2@example.invalid','pending task a already reserves a worker on owner1');
  await pool.assign('a');assert.deepEqual(pool.assignments('a'),original,'assignment remains stable despite changed loads');
  store.update('a',{status:'succeeded'});await pool.assign('c');assert.equal((pool.assignments('c').find((s:any)=>s.role==='sidekick') as any).account_email,'owner1@example.invalid','completed task keeps its reservation but no longer adds pending work');
  store.update('b',{status:'reviewing'});await pool.assign('d');assert.equal((pool.assignments('d').find((s:any)=>s.role==='sidekick') as any).account_email,'owner2@example.invalid','reviewing task b now loads its reviewer account, not its idle worker account');
  assert.equal(pool.assignments('a').length,2);assert.equal(new Set((pool.snapshot().leases as any[]).map(s=>s.arena_id)).size,8);
 }finally{await orch.close();store.close();await fixture.cleanup();}
});
