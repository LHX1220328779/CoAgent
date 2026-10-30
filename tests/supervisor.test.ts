import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile, readFile, mkdir, access, symlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/supervisor/store.ts';
import { Orchestrator, taskFromInput } from '../src/supervisor/orchestrator.ts';
import { GitWorktrees, git } from '../src/supervisor/worktree.ts';
import { AppError, RuntimeExecutionError } from '../src/errors.ts';
import { FakeRuntime, repoFixture } from './helpers.ts';
async function setup(){const f=await repoFixture();const store=new Store(join(f.root,'db.sqlite'));const runtime=new FakeRuntime();const worktrees=new GitWorktrees(join(f.root,'trees'));const orch=new Orchestrator(store,runtime,worktrees,2);return {...f,store,runtime,worktrees,orch,close:async()=>{await orch.close();store.close();await f.cleanup();}};}
test('DAG transaction rejects cycles and missing references',()=>{const store=new Store(':memory:');try{const a=taskFromInput({id:'a',prompt:'A',repo:'.',dependsOn:['b']});const b=taskFromInput({id:'b',prompt:'B',repo:'.',dependsOn:['a']});assert.throws(()=>store.add([a,b]),/cycle/);assert.equal(store.tasks().length,0);assert.throws(()=>store.add([a]),/Unknown/);}finally{store.close();}});
test('approval, DAG ordering, reviewer and acceptance in real worktree',async()=>{const s=await setup();try{s.runtime.handler=async(role,directory)=>{if(role==='reviewer')return '{"approved":true,"findings":[]}';await writeFile(join(directory,'result.txt'),'done');return 'result.txt created';};s.store.add([taskFromInput({id:'a',prompt:'Write file',repo:s.repo,acceptance:[process.execPath,'-e',"require('node:assert').equal(require('node:fs').readFileSync('result.txt','utf8'),'done')"]}),taskFromInput({id:'b',prompt:'Next',repo:s.repo,dependsOn:['a'],requiresApproval:false})]);await s.orch.tick();assert.equal(s.store.task('a').status,'awaiting_approval');assert.equal(s.runtime.prompts.length,0);s.orch.approve('a');await s.orch.tick();await s.orch.idle();assert.equal(s.store.task('a').status,'succeeded');await s.orch.tick();await s.orch.idle();assert.equal(s.store.task('b').status,'succeeded');assert.match(s.runtime.prompts.find(p=>p.role==='sidekick' && p.prompt.startsWith('Next'))!.prompt,/result.txt created/);assert.equal(await git(s.repo,'status','--porcelain'),'');assert.notEqual(s.store.task('a').worktree,s.store.task('b').worktree);}finally{await s.close();}});
test('independent workers run concurrently with separate worktrees',async()=>{const s=await setup();let active=0,peak=0;try{s.runtime.handler=async(role,directory)=>{if(role==='reviewer')return '{"approved":true,"findings":[]}';active++;peak=Math.max(peak,active);await delay(100);await writeFile(join(directory,'same.txt'),directory);active--;return directory;};s.store.add(['a','b','c'].map(id=>taskFromInput({id,prompt:'write',repo:s.repo,requiresApproval:false})));await s.orch.tick();await s.orch.idle();await s.orch.tick();await s.orch.idle();assert.equal(peak,2);assert.ok(s.store.tasks().every(t=>t.status==='succeeded'));for(const t of s.store.tasks())assert.equal(await readFile(join(t.worktree!,'same.txt'),'utf8'),t.worktree);}finally{await s.close();}});
test('reviewer rejection blocks dependent work',async()=>{const s=await setup();try{s.runtime.handler=async role=>role==='reviewer'?'{"approved":false,"findings":["Missing implementation"]}':'done';s.store.add([taskFromInput({id:'a',prompt:'A',repo:s.repo,requiresApproval:false}),taskFromInput({id:'b',prompt:'B',repo:s.repo,dependsOn:['a'],requiresApproval:false})]);await s.orch.tick();await s.orch.idle();await s.orch.tick();assert.equal(s.store.task('a').status,'failed');assert.match(s.store.task('a').error!,/Missing implementation/);assert.equal(s.store.task('b').status,'blocked');}finally{await s.close();}});
test('pause/resume reuses worker session and worktree',async()=>{const s=await setup();try{let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);s.runtime.handler=async(role,directory,prompt,signal)=>{if(role==='reviewer')return '{"approved":true,"findings":[]}';entered();await delay(10000,undefined,{signal});return 'done';};s.store.add([taskFromInput({id:'a',prompt:'A',repo:s.repo,requiresApproval:false})]);await s.orch.tick();await ready;await s.orch.pause('a');const tree=s.store.task('a').worktree;assert.equal(s.store.task('a').status,'paused');s.runtime.handler=undefined;s.orch.resume('a');await s.orch.tick();await s.orch.idle();assert.equal(s.store.task('a').status,'succeeded');assert.equal(s.store.task('a').worktree,tree);assert.equal(s.runtime.created.filter(s=>s.role==='sidekick').length,1);}finally{await s.close();}});
test('cancel, timeout, transient retry and persisted attempts',async()=>{const s=await setup();try{let calls=0;s.runtime.handler=async role=>{if(role==='reviewer')return '{"approved":true,"findings":[]}';if(++calls===1)throw new AppError('upstream',503);return 'ok';};s.store.add([taskFromInput({id:'a',prompt:'A',repo:s.repo,maxAttempts:2,requiresApproval:false})]);await s.orch.tick();await s.orch.idle();assert.equal(s.store.task('a').status,'queued');await s.orch.tick();await s.orch.idle();assert.equal(s.store.task('a').attempts,2);assert.equal(s.store.task('a').status,'succeeded');s.store.add([taskFromInput({id:'b',prompt:'B',repo:s.repo,timeoutMs:100,requiresApproval:false})]);s.runtime.handler=async(_r,_d,_p,signal)=>{await delay(5000,undefined,{signal});return 'late';};await s.orch.tick();await s.orch.idle();assert.equal(s.store.task('b').status,'failed');assert.match(s.store.task('b').error!,/timed out/);s.store.add([taskFromInput({id:'c',prompt:'C',repo:s.repo})]);await s.orch.cancel('c');assert.equal(s.store.task('c').status,'canceled');}finally{await s.close();}});
test('database restart pauses interrupted work and prevents a second scheduler',async()=>{const f=await repoFixture();let store=new Store(join(f.root,'db'));const runtime=new FakeRuntime(),trees=new GitWorktrees(join(f.root,'trees'));let orch=new Orchestrator(store,runtime,trees);try{assert.throws(()=>new Orchestrator(store,runtime,trees),/Another supervisor/);store.add([taskFromInput({id:'a',prompt:'A',repo:f.repo})]);store.update('a',{status:'running'});await orch.close();store.close();store=new Store(join(f.root,'db'));orch=new Orchestrator(store,runtime,trees);assert.equal(store.task('a').status,'paused');assert.ok(store.events().length);}finally{await orch.close();store.close();await f.cleanup();}});
test('worktree cleanup refuses dirty changes and traversal',async()=>{const s=await setup();try{await assert.rejects(s.worktrees.create('../oops',s.repo),/Invalid/);const tree=await s.worktrees.create('manual',s.repo);await writeFile(join(tree,'new.txt'),'keep');await assert.rejects(s.worktrees.remove(tree,s.repo),/dirty/);await assert.rejects(s.worktrees.remove(s.repo,s.repo),/Outside/);}finally{await s.close();}});
test('prepare creates both persistent sessions without running a model',async()=>{const s=await setup();try{s.store.add([taskFromInput({id:'prepare',prompt:'A',repo:s.repo})]);const result=await s.orch.prepare('prepare');assert.equal(result.task.status,'awaiting_approval');assert.equal(s.runtime.prompts.length,0);assert.equal(s.runtime.created.length,2);await s.orch.prepare('prepare');assert.equal(s.runtime.created.length,2);s.orch.approve('prepare');await s.orch.tick();await s.orch.idle();assert.equal(s.store.task('prepare').status,'succeeded');assert.equal(s.runtime.created.length,2);}finally{await s.close();}});
test('unknown runtime stop remains paused and is reconciled before session reuse',async()=>{
 const s=await setup();let stops=0;
 try{
  s.runtime.handler=async()=>{throw new RuntimeExecutionError('stop not confirmed',409,false);};
  s.runtime.abort=async()=>{stops++;};
  s.store.add([taskFromInput({id:'uncertain',prompt:'Work',repo:s.repo,requiresApproval:false,maxAttempts:3})]);
  await s.orch.tick();await s.orch.idle();const task=s.store.task('uncertain');
  assert.equal(task.status,'paused');assert.equal(task.attempts,1);assert.equal(s.store.session('sidekick',task.worktree!)!.state,'running');
  s.runtime.handler=undefined;s.orch.resume(task.id);await s.orch.tick();await s.orch.idle();
  assert.equal(stops,1);assert.equal(s.store.task(task.id).status,'succeeded');assert.equal(s.runtime.created.filter(s=>s.role==='sidekick').length,1);
 }finally{await s.close();}
});
test('a submitted runtime turn is not replayed after a transient model failure',async()=>{
 const s=await setup();let writes=0;
 try{
  s.runtime.handler=async(_role,directory)=>{await writeFile(join(directory,'write-count.txt'),String(++writes));throw new RuntimeExecutionError('model failed after a tool',503);};
  s.store.add([taskFromInput({id:'once',prompt:'Work',repo:s.repo,requiresApproval:false,maxAttempts:3})]);
  await s.orch.tick();await s.orch.idle();await s.orch.tick();await s.orch.idle();
  assert.equal(s.store.task('once').status,'failed');assert.equal(s.store.task('once').attempts,1);assert.equal(writes,1);
 }finally{await s.close();}
});
test('resume after a reviewer transport failure reuses the completed worker result without rewriting files',async()=>{
 const s=await setup();let writes=0,reviews=0;
 try{
  s.runtime.handler=async(role,directory)=>{
   if(role==='reviewer'){if(++reviews===1)throw new RuntimeExecutionError('review transport failed',422);return '{"approved":true,"findings":[]}';}
   await writeFile(join(directory,'write-count.txt'),String(++writes));return 'Worker completed';
  };
  s.store.add([taskFromInput({id:'checkpoint',prompt:'Work',repo:s.repo,requiresApproval:false})]);
  await s.orch.tick();await s.orch.idle();assert.equal(s.store.task('checkpoint').status,'failed');assert.equal(s.store.task('checkpoint').reviewPending,true);
  s.orch.resume('checkpoint');await s.orch.tick();await s.orch.idle();assert.equal(s.store.task('checkpoint').status,'succeeded');assert.equal(writes,1);assert.equal(reviews,2);assert.equal(s.store.task('checkpoint').reviewPending,false);
 }finally{await s.close();}
});
test('direct folders isolate task sessions, serialize overlapping paths and preserve existing files without initializing Git',async()=>{
 const s=await setup(),directory=join(s.root,'plain'),alias=join(s.root,'alias'),child=join(directory,'child');let release!:()=>void,started!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;}),begin=new Promise<void>(resolve=>{started=resolve;});
 try{
  await mkdir(child,{recursive:true});await symlink(directory,alias);await writeFile(join(directory,'existing.txt'),'local-only');
  s.runtime.handler=async(role,path,prompt)=>{if(role==='reviewer'){assert.match(prompt,/没有可用的 Git 历史基线/);return '{"approved":true,"findings":[]}';}if(prompt.startsWith('First')){started();await gate;}await writeFile(join(path,'result.txt'),prompt.startsWith('First')?'first':'second');return 'Changed local file';};
  s.store.add([taskFromInput({id:'direct-a',prompt:'First task',repo:directory,workspaceMode:'direct',requiresApproval:false}),taskFromInput({id:'direct-b',prompt:'Second task',repo:alias,workspaceMode:'direct',requiresApproval:false}),taskFromInput({id:'direct-child',prompt:'Child',repo:child,workspaceMode:'direct'})]);
  await s.orch.tick();await begin;assert.equal(s.store.task('direct-b').status,'queued');
  await assert.rejects(s.orch.prepare('direct-child'),{code:'workspace_busy'});release();await s.orch.idle();
  await s.orch.tick();await s.orch.idle();assert.equal(s.store.task('direct-b').status,'succeeded');assert.equal(s.store.task('direct-b').worktree,directory);
  assert.equal(await readFile(join(directory,'result.txt'),'utf8'),'second');assert.equal(await readFile(join(directory,'existing.txt'),'utf8'),'local-only');await assert.rejects(access(join(directory,'.git')));
  assert.equal(s.runtime.created.filter(session=>session.role==='sidekick').length,2);assert.equal(s.store.db.prepare('SELECT COUNT(*) AS n FROM worktrees').get()!.n,0);
 }finally{release();await s.close();}
});

test('independent review receives the worker tool evidence rather than only its report',async()=>{
 const s=await setup();
 try{
  Object.assign(s.runtime,{toolHistory:async()=>[{tool:'local_workspace_apply_patch',status:'completed',output:'only result.txt changed'},{tool:'local_workspace_run_command',status:'completed',input:{command:'fixed-test'},output:'exit_code: 0'}]});
  s.runtime.handler=async(role,directory,prompt)=>{if(role==='reviewer'){assert.match(prompt,/Observed OpenCode tool log/);assert.match(prompt,/only result.txt changed/);assert.match(prompt,/exit_code: 0/);return '{"approved":true,"findings":[]}';}await writeFile(join(directory,'result.txt'),'done');return 'Worker report';};
  s.store.add([taskFromInput({id:'evidence',prompt:'Write file',repo:s.repo,requiresApproval:false})]);await s.orch.tick();await s.orch.idle();assert.equal(s.store.task('evidence').status,'succeeded');
 }finally{await s.close();}
});
