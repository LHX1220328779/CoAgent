import {readFile} from 'node:fs/promises';
import {AppError} from '../errors.ts';
import type {Task} from '../types.ts';
import type {Store} from '../supervisor/store.ts';
import type {ArenaAgentAdapter} from '../gateway/adapters.ts';
type CatalogSession={id:string;title:string;accountEmail:string;available:boolean};
/** Durable task reservations; completion keeps a reservation until explicit release. */
export class ArenaPool{
  private queue:Promise<unknown>=Promise.resolve();
  private store:Store;private adapter:ArenaAgentAdapter;
  constructor(store:Store,adapter:ArenaAgentAdapter){this.store=store;this.adapter=adapter;}
  async refresh(){
    const response=await fetch(this.adapter.baseURL.replace(/\/v1\/?$/,'')+'/coagent/sessions',{method:'POST',redirect:'error',headers:{authorization:`Bearer ${this.adapter.apiKey}`,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(180000)});
    if(!response.ok){await response.body?.cancel();throw new AppError(response.status===404?'请通过 CoAgent 重新启动支持会话同步的桥接':'会话同步失败，请检查账号登录和桥接状态',422);}
    const data=await response.json() as {sessions:CatalogSession[];accounts:unknown[];syncedAt:number};
    if(!Array.isArray(data.sessions))throw new AppError('桥接返回的会话清单格式无效',422);
    this.store.transaction(()=>{this.store.db.exec('UPDATE arena_catalog SET available=0');for(const s of data.sessions){if(!/^[0-9a-f-]{36}$/i.test(s.id)||typeof s.title!=='string'||typeof s.accountEmail!=='string')throw new AppError('会话元数据无效',422);this.store.db.prepare('INSERT INTO arena_catalog VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET account_email=excluded.account_email,title=excluded.title,available=excluded.available,updated_at=excluded.updated_at').run(s.id.toLowerCase(),s.accountEmail,s.title,Number(s.available),data.syncedAt??Date.now());}
      // A partial history listing does not invalidate an existing task's reservation.
      for(const account of data.accounts as {email?:string;available?:boolean}[])if(account.available&&account.email)this.store.db.prepare('UPDATE arena_catalog SET available=1 WHERE account_email=? AND id IN (SELECT arena_id FROM arena_leases)').run(account.email);
    });
    let bindings:Record<string,string>={};try{bindings=JSON.parse(await readFile(this.adapter.bindingsPath,'utf8'));}catch{}
    this.store.transaction(()=>{for(const [runtimeID,uuid] of Object.entries(bindings)){const session=this.store.db.prepare('SELECT task_id,role FROM task_agent_sessions WHERE runtime_id=?').get(runtimeID) as any;if(session)this.store.db.prepare('INSERT OR IGNORE INTO arena_leases VALUES(?,?,?,?,?)').run(uuid,session.task_id,session.role,runtimeID,Date.now());}});
    return {...this.snapshot(),accounts:data.accounts};
  }
  snapshot(){return {sessions:this.store.db.prepare('SELECT c.*,l.task_id,l.role,t.title AS task_title,h.last_success_at FROM arena_catalog c LEFT JOIN arena_leases l ON l.arena_id=c.id LEFT JOIN tasks t ON t.id=l.task_id LEFT JOIN arena_successful_sessions h ON h.arena_id=c.id ORDER BY c.account_email,c.title,c.id').all(),leases:this.store.db.prepare('SELECT * FROM arena_leases ORDER BY reserved_at').all()};}
  private serial<T>(fn:()=>Promise<T>){const result=this.queue.then(fn);this.queue=result.catch(()=>{});return result;}
  private stopped(task:Task){if(['running','reviewing','queued'].includes(task.status))throw new AppError('请先暂停任务再调整会话',409);const busy=this.store.db.prepare("SELECT id FROM task_agent_sessions WHERE task_id=? AND state='running'").get(task.id);if(busy)throw new AppError('Agent 停止尚未确认，请先准备或恢复检查该任务',409);}
  assignments(id:string){return this.store.db.prepare('SELECT l.*,c.title,c.account_email FROM arena_leases l LEFT JOIN arena_catalog c ON c.id=l.arena_id WHERE l.task_id=? ORDER BY l.role').all(id);}
  ready(id:string){if(this.store.db.prepare('SELECT l.arena_id FROM arena_leases l JOIN arena_catalog c ON c.id=l.arena_id WHERE l.task_id=? AND c.available=1').all(id).length!==2)throw new AppError('请先分配两个可用会话；已有会话不可用时请处理对应账号登录并同步',409);}
  assign(id:string){return this.serial(async()=>{
    const task=this.store.task(id);this.stopped(task);
    const native=[this.store.session(task.role,task.worktree!,id),this.store.session('reviewer',task.worktree!,id)];if(native.some(s=>!s))throw new AppError('请先准备任务工作区',409);
    let old:Record<string,string>={};try{old=JSON.parse(await readFile(this.adapter.bindingsPath,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const external=new Set(Object.values(old).map(value=>value.toLowerCase()));
    const pairs=this.store.transaction(()=>{
      const assigned=[];const usedAccounts=new Set<string>();
      for(const session of native){
        const existing=this.store.db.prepare('SELECT * FROM arena_leases WHERE task_id=? AND role=?').get(id,session!.role) as any;
        if(existing){assigned.push({sessionID:session!.runtimeID,arenaSessionID:existing.arena_id});continue;}
        const free=this.store.db.prepare('SELECT c.*,h.last_success_at FROM arena_catalog c LEFT JOIN arena_successful_sessions h ON h.arena_id=c.id WHERE available=1 AND NOT EXISTS (SELECT 1 FROM arena_leases l WHERE l.arena_id=c.id) ORDER BY h.last_success_at DESC,c.updated_at DESC,c.id').all() as any[];
        const candidates=free.filter(s=>!external.has(s.id)),experienced=candidates.filter(s=>s.last_success_at!==null),preferred=experienced.length?experienced:candidates;const chosen=preferred.find(s=>!usedAccounts.has(s.account_email))??preferred[0];
        if(!chosen)throw new AppError('可用的未占用会话不足，需要两条。请登录并同步会话，或先解绑旧任务的会话',409,'arena_sessions_unavailable');
        this.store.db.prepare('INSERT INTO arena_leases VALUES(?,?,?,?,?)').run(chosen.id,id,session!.role,session!.runtimeID,Date.now());usedAccounts.add(chosen.account_email);assigned.push({sessionID:session!.runtimeID,arenaSessionID:chosen.id});
      }return assigned;
    });
    // A crash here retains reservations; explicit retry repairs the mapping without reallocating.
    await this.adapter.bindMany(pairs);this.store.audit('arena_assign',id,{roles:pairs.length});return this.assignments(id);
  });}
  release(id:string){return this.serial(async()=>{const task=this.store.task(id);this.stopped(task);const leases=this.assignments(id) as any[];await this.adapter.bindMany([],leases.map(l=>l.runtime_id));this.store.transaction(()=>{if(task.status==='succeeded')for(const lease of leases)this.store.db.prepare('INSERT INTO arena_successful_sessions VALUES(?,?,?) ON CONFLICT(arena_id) DO UPDATE SET task_id=excluded.task_id,last_success_at=excluded.last_success_at').run(lease.arena_id,id,Date.now());this.store.db.prepare('DELETE FROM arena_leases WHERE task_id=?').run(id);});this.store.audit('arena_release',id);return {released:leases.length};});}
}
