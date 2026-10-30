import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalServices } from '../src/desktop/services.ts';
import { createConsole } from '../src/desktop/server.ts';
import { createApp } from '../src/server.ts';
import { Store } from '../src/supervisor/store.ts';
import { Orchestrator } from '../src/supervisor/orchestrator.ts';
import { GitWorktrees } from '../src/supervisor/worktree.ts';
import { ModelRouter } from '../src/gateway/router.ts';
import { ArenaAgentAdapter, MockAdapter } from '../src/gateway/adapters.ts';
import { FakeRuntime, repoFixture } from './helpers.ts';

async function listen(server:Server){server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${(server.address() as {port:number}).port}`;}
async function close(server:Server){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
test('one-click startup owns only new child processes and concurrent starts do not duplicate listeners',async()=>{
  const root=await mkdtemp(join(tmpdir(),'coagent-console-launch-'));
  async function port(){const server=createServer();const url=await listen(server);await close(server);return new URL(url).port;}
  const bridgePort=await port(),runtimePort=await port(),gatewayPort=await port();
  const services=new LocalServices(root,{...process.env,COAGENT_MODE:'arena',COAGENT_API_KEY:'fixture-launch-gateway',OPENCODE_SERVER_PASSWORD:'fixture-launch-runtime',ARENA_BRIDGE_KEY:'fixture-launch-bridge',ARENA_BRIDGE_URL:`http://127.0.0.1:${bridgePort}/v1`,OPENCODE_URL:`http://127.0.0.1:${runtimePort}`,COAGENT_PORT:gatewayPort});
  try{
    await mkdir(join(root,'arena-local-bridge/src'),{recursive:true});await mkdir(join(root,'src'));await writeFile(join(root,'package.json'),'{"type":"module"}');
    await writeFile(join(root,'arena-local-bridge/src/index.mjs'),`import {createServer} from 'node:http';createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify({ready:false,accounts:[]}));}).listen(Number(process.env.PORT),'127.0.0.1');`);
    await writeFile(join(root,'src/cli.ts'),`import {createServer} from 'node:http';const runtime=process.argv.at(-1)==='runtime';console.log(runtime?'runtime launched':'gateway launched');createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify(runtime?{healthy:true,version:'1.19.5'}:[]));}).listen(Number(runtime?new URL(process.env.OPENCODE_URL).port:process.env.COAGENT_PORT),'127.0.0.1');`);
    const [first,second]=await Promise.all([services.start(),services.start()]);assert.deepEqual(first,second);assert.ok(first.every(s=>s.running&&s.managed));assert.equal(first[0].ready,false,'login is distinct from liveness');
    await services.start();assert.equal((await readFile(join(root,'.coagent/console-services/gateway.log'),'utf8')).match(/gateway launched/g)?.length,1);
    await services.stopOwned();assert.ok((await services.snapshot()).every(s=>!s.running));
  }finally{await services.stopOwned();await rm(root,{recursive:true,force:true});}
});
test('console reuses running services, shows expired login, and never starts a second supervisor',async()=>{
  const root=await mkdtemp(join(tmpdir(),'coagent-console-services-'));const servers:Server[]=[];let logins=0,valid=false;
  const bridge=createServer(async(req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/api/accounts/login'){logins++;assert.equal(req.headers.authorization,'Bearer bridge-private');res.writeHead(502);res.end(JSON.stringify({error:{message:'private upstream cookie should not be reflected'}}));return;}res.end(JSON.stringify({version:'1.1.0',ready:valid,accounts:[{email:'test@example.invalid',disabled:!valid,cookieExpirySeconds:-1,lastError:'403 private upstream HTML',cookie:'must-not-leak'}]}));});servers.push(bridge);
  const runtime=createServer((req,res)=>{res.setHeader('content-type','application/json');assert.match(String(req.headers.authorization),/^Basic /);res.end(JSON.stringify({healthy:true,version:'1.19.5'}));});servers.push(runtime);
  const gateway=createServer((req,res)=>{res.setHeader('content-type','application/json');assert.equal(req.headers.authorization,'Bearer console-private-gateway');res.end('[]');});servers.push(gateway);
  let consoleServer:Server|undefined;
  try{
    const bridgeURL=await listen(bridge),runtimeURL=await listen(runtime),gatewayURL=await listen(gateway);
    const services=new LocalServices(root,{COAGENT_MODE:'arena',COAGENT_API_KEY:'console-private-gateway',OPENCODE_SERVER_PASSWORD:'runtime-private',ARENA_BRIDGE_KEY:'bridge-private',ARENA_BRIDGE_URL:bridgeURL+'/v1',OPENCODE_URL:runtimeURL,COAGENT_PORT:new URL(gatewayURL).port});
    const states=await services.start();assert.ok(states.every(s=>s.running&&!s.managed));assert.equal(states.find(s=>s.name==='bridge')?.ready,false);assert.match(states.find(s=>s.name==='bridge')!.message,/403/);
    consoleServer=createConsole(services);const base=await listen(consoleServer),page=await fetch(base);const cookie=page.headers.get('set-cookie')!.split(';')[0];const headers={'x-coagent-console':'1',cookie,'content-type':'application/json'};
    const overview=await fetch(base+'/api/overview',{headers}).then(r=>r.json()) as any;const text=JSON.stringify(overview);assert.doesNotMatch(text,/must-not-leak|private upstream HTML|console-private-gateway|runtime-private|bridge-private/);
    assert.equal((await fetch(base+'/api/services/start',{method:'POST',headers})).status,200);assert.equal((await fetch(base+'/api/services/start',{method:'POST',headers})).status,200);
    const login=await fetch(base+'/api/bridge/login',{method:'POST',headers,body:JSON.stringify({email:'test@example.invalid',password:'user-secret'})});assert.equal(login.status,422);assert.doesNotMatch(await login.text(),/private upstream cookie|user-secret/);assert.equal(logins,1,'no automatic login retry');
    valid=true;assert.ok((await services.start()).every(s=>s.ready));await services.stopOwned();assert.equal((await services.state('gateway')).ready,true,'existing services are not stopped');
  }finally{if(consoleServer)await close(consoleServer);for(const server of servers)await close(server);await rm(root,{recursive:true,force:true});}
});

test('startup restores an existing account with one history sync and no password login',async()=>{
  let restored=false,syncs=0,logins=0;
  const bridge=createServer((req,res)=>{if(req.url?.includes('login'))logins++;res.setHeader('content-type','application/json');res.end(JSON.stringify({ready:restored,accounts:[{email:'saved@example.invalid',disabled:false,cookieExpirySeconds:restored?3600:-60}]}));});
  const runtime=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({healthy:true,version:'1.19.5'}));});
  const gateway=createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/arena/pool'&&req.method==='POST'){syncs++;restored=true;res.end('{"sessions":[]}');}else res.end('[]');});
  try{
    const bridgeURL=await listen(bridge),runtimeURL=await listen(runtime),gatewayURL=await listen(gateway);
    const services=new LocalServices(process.cwd(),{COAGENT_MODE:'arena',COAGENT_API_KEY:'restore-fixture',OPENCODE_SERVER_PASSWORD:'restore-native',ARENA_BRIDGE_URL:bridgeURL+'/v1',OPENCODE_URL:runtimeURL,COAGENT_PORT:new URL(gatewayURL).port});
    assert.ok((await services.start()).every(s=>s.ready));await services.start();assert.equal(syncs,1);assert.equal(logins,0);await services.stopOwned();assert.ok((await services.snapshot()).every(s=>s.running));
  }finally{await Promise.all([bridge,runtime,gateway].map(close));}
});

test('console creates real worktree, binds URLs, approves task, exposes diff and scopes one-time tool approval',async()=>{
  const fixture=await repoFixture(),runtime=new FakeRuntime(),store=new Store(':memory:');
  const orchestrator=new Orchestrator(store,runtime,new GitWorktrees(join(fixture.root,'worktrees')));
  const mapPath=join(fixture.root,'bindings.json'),arena=new ArenaAgentAdapter('http://127.0.0.1:1/v1','fixture',mapPath);
  const gateway=createApp({key:'console-gateway-private-key',router:new ModelRouter().register('mock',{adapter:new MockAdapter(),model:'mock'}),store,orchestrator,runtime,arena});
  const pending:any[]=[];let permissionReplies=0;
  const native=createServer(async(req,res)=>{res.setHeader('content-type','application/json');const path=new URL(req.url!,'http://localhost').pathname;if(path==='/global/health'){res.end(JSON.stringify({healthy:true,version:'1.19.5'}));return;}if(path==='/permission'){res.end(JSON.stringify(pending));return;}if(path==='/permission/req_worker/reply'){let raw='';for await(const chunk of req)raw+=chunk;assert.deepEqual(JSON.parse(raw),{reply:'once'});permissionReplies++;pending.splice(0,1);res.end('true');return;}res.writeHead(404);res.end('{}');});
  const bridge=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({ready:true,accounts:[]}));});
  let consoleServer:Server|undefined;
  try{
    const gatewayURL=await listen(gateway),runtimeURL=await listen(native),bridgeURL=await listen(bridge);
    const services=new LocalServices(fixture.root,{COAGENT_MODE:'arena',COAGENT_API_KEY:'console-gateway-private-key',OPENCODE_SERVER_PASSWORD:'private-runtime',ARENA_BRIDGE_URL:bridgeURL+'/v1',ARENA_SESSION_BINDINGS:mapPath,OPENCODE_URL:runtimeURL,COAGENT_PORT:new URL(gatewayURL).port});
    consoleServer=createConsole(services);const base=await listen(consoleServer),page=await fetch(base),cookie=page.headers.get('set-cookie')!.split(';')[0];
    assert.match(await page.text(),/本地编程工作台/);const headers={cookie,'x-coagent-console':'1','content-type':'application/json'};
    const request=(path:string,body?:unknown)=>fetch(base+path,{headers,method:body===undefined?'GET':'POST',body:body===undefined?undefined:JSON.stringify(body)});
    assert.equal((await fetch(base+'/api/overview')).status,403);
    assert.equal((await fetch(base+'/api/services/start',{method:'POST',headers:{...headers,origin:'https://foreign.invalid'}})).status,403);
    const foreignHost=await new Promise<number>((done,reject)=>{const request=httpRequest(base+'/api/overview',{headers:{...headers,host:'foreign.invalid:1234'}},response=>{response.resume();done(response.statusCode!);});request.once('error',reject);request.end();});assert.equal(foreignHost,403);
    const directories=await request('/api/directories?path='+encodeURIComponent(fixture.root)).then(r=>r.json()) as any;assert.ok(directories.directories.includes('repo'));
    const created=await request('/api/tasks',{repo:fixture.repo,workspaceMode:'worktree',prompt:'Write proof locally',acceptance:[process.execPath,'-e',"require('node:assert/strict').equal(require('node:fs').readFileSync('proof.txt','utf8'),'verified')"]});assert.equal(created.status,201);const {task}=await created.json() as any;assert.equal(task.status,'awaiting_approval');assert.ok(task.worktree);
    const detail=await request(`/api/tasks/${task.id}/details`).then(r=>r.json()) as any;assert.equal(detail.sessions.length,2);
    assert.equal((await request(`/api/tasks/${task.id}/approve`,{})).status,409,'unbound task does not run');
    const worker='00000000-0000-0000-0000-000000000041',reviewer='00000000-0000-0000-0000-000000000042';
    assert.equal((await request(`/api/tasks/${task.id}/bind`,{worker:`https://arena.ai/agent/${worker}`,reviewer:worker})).status,400);
    assert.equal((await request(`/api/tasks/${task.id}/bind`,{worker:`https://foreign.invalid/agent/${worker}`,reviewer})).status,400);
    assert.equal((await request(`/api/tasks/${task.id}/bind`,{worker:`https://arena.ai/agent/${worker}`,reviewer:`https://arena.ai/agent/${reviewer}`})).status,200);
    assert.equal(Object.keys(JSON.parse(await readFile(mapPath,'utf8'))).length,2);
    const workerSession=detail.sessions.find((s:any)=>s.role==='sidekick'),reviewerSession=detail.sessions.find((s:any)=>s.role==='reviewer');
    pending.push({id:'req_worker',sessionID:workerSession.runtimeID,permission:'bash',patterns:['node --test'],metadata:{command:'node --test'}},{id:'req_reviewer',sessionID:reviewerSession.runtimeID,permission:'bash'});
    assert.equal((await request(`/api/tasks/${task.id}/permissions/req_worker`,{reply:'once'})).status,409,'inactive task cannot approve a reused session');
    store.update(task.id,{status:'running'});
    const requests=await request(`/api/tasks/${task.id}/details`).then(r=>r.json()) as any;assert.equal(requests.permissions.length,1);
    assert.equal((await request(`/api/tasks/${task.id}/permissions/req_reviewer`,{reply:'once'})).status,409);
    assert.equal((await request(`/api/tasks/${task.id}/permissions/req_worker`,{reply:'always'})).status,400);
    assert.equal((await request(`/api/tasks/${task.id}/permissions/req_worker`,{reply:'once'})).status,200);assert.equal(permissionReplies,1);
    assert.equal((await request(`/api/tasks/${task.id}/permissions/req_worker`,{reply:'once'})).status,409,'stale approval cannot be replayed');
    runtime.handler=async(role,directory)=>{if(role==='reviewer')return '{"approved":true,"findings":[]}';await writeFile(join(directory,'proof.txt'),'verified');return 'Wrote proof.txt';};
    store.update(task.id,{status:'awaiting_approval'});assert.equal((await request(`/api/tasks/${task.id}/approve`,{})).status,200);await orchestrator.idle();assert.equal(store.task(task.id).status,'succeeded');
    const diff=await request(`/api/tasks/${task.id}/diff`).then(r=>r.json()) as any;assert.match(diff.untracked,/proof.txt/);assert.equal(await readFile(join(task.worktree,'proof.txt'),'utf8'),'verified');
    const local=join(fixture.root,'plain-project');await mkdir(local);await writeFile(join(local,'existing.txt'),'uncommitted local content');
    const direct=await request('/api/tasks',{repo:local,prompt:'Write proof directly',acceptance:[process.execPath,'-e',"require('node:assert/strict').equal(require('node:fs').readFileSync('proof.txt','utf8'),'verified')"]}).then(r=>r.json()) as any;
    assert.equal(direct.task.workspaceMode,'direct');assert.equal(direct.task.worktree,local);
    assert.equal((await request(`/api/tasks/${direct.task.id}/bind`,{worker:'00000000-0000-0000-0000-000000000043',reviewer:'00000000-0000-0000-0000-000000000044'})).status,200);
    assert.equal((await request(`/api/tasks/${direct.task.id}/approve`,{})).status,200);await orchestrator.idle();assert.equal(store.task(direct.task.id).status,'succeeded');
    assert.equal(await readFile(join(local,'proof.txt'),'utf8'),'verified');assert.equal(await readFile(join(local,'existing.txt'),'utf8'),'uncommitted local content');await assert.rejects(access(join(local,'.git')));
    const directDiff=await request(`/api/tasks/${direct.task.id}/diff`).then(r=>r.json()) as any;assert.match(directDiff.message,/没有可用的 Git 历史基线/);
    const again=await request('/api/tasks',{repo:local,prompt:'Continue in the same local project'}).then(r=>r.json()) as any;
    const firstSessions=await request(`/api/tasks/${direct.task.id}/details`).then(r=>r.json()) as any,againSessions=await request(`/api/tasks/${again.task.id}/details`).then(r=>r.json()) as any;
    assert.notEqual(againSessions.sessions[0].runtimeID,firstSessions.sessions[0].runtimeID,'new task owns separate Agent sessions even in the same folder');assert.ok(againSessions.sessions.every((s:any)=>s.arenaUUID===null));
    const assets=await request('/app.js').then(r=>r.text());assert.doesNotMatch(assets,/console-gateway-private-key|private-runtime/);
  }finally{await orchestrator.close();if(consoleServer)await close(consoleServer);await close(gateway);await close(native);await close(bridge);store.close();await fixture.cleanup();}
});
