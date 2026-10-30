import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.ts';
import type { Task, AgentSession, TaskStatus } from '../types.ts';
import type { RequestRecord } from '../gateway/router.ts';
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path); this.db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  }
  transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  tasks(): Task[] { return (this.db.prepare('SELECT data FROM tasks ORDER BY priority DESC,created_at,id').all() as {data:string}[]).map(r => JSON.parse(r.data)); }
  task(id: string): Task { const row = this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id) as {data:string}|undefined; if (!row) throw new AppError('Task not found',404); return JSON.parse(row.data); }
  add(tasks: Task[]) {
    this.transaction(() => {
      const existing = this.tasks(); const all = new Map(existing.map(t => [t.id,t]));
      for (const t of tasks) { if (all.has(t.id)) throw new AppError('Duplicate task ID'); all.set(t.id,t); }
      const visiting = new Set<string>(), visited = new Set<string>();
      const visit = (id: string) => { if (visiting.has(id)) throw new AppError('Dependency cycle'); if (visited.has(id)) return; const t = all.get(id); if (!t) throw new AppError('Unknown dependency'); visiting.add(id); for (const dep of t.dependsOn) visit(dep); visiting.delete(id); visited.add(id); };
      for (const t of tasks) visit(t.id);
      for (const t of tasks) this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?)').run(t.id,t.title,t.prompt,t.repo,t.status,t.priority,JSON.stringify(t),t.createdAt,t.updatedAt);
      for (const t of tasks) { for (const dep of new Set(t.dependsOn)) this.db.prepare('INSERT INTO dependencies VALUES(?,?)').run(t.id,dep); this.event(t.id,'created',{}); }
    });
  }
  update(id: string, patch: Partial<Task>): Task {
    const task = { ...this.task(id), ...patch, id, updatedAt: Date.now() };
    this.db.prepare('UPDATE tasks SET status=?,priority=?,data=?,updated_at=? WHERE id=?').run(task.status,task.priority,JSON.stringify(task),task.updatedAt,id); return task;
  }
  transition(id: string, status: TaskStatus, patch: Partial<Task> = {}) {
    return this.transaction(() => { const task = this.update(id,{...patch,status}); this.event(id,status,{attempt:task.attempts}); return task; });
  }
  event(taskID: string|null, type: string, data: unknown) { this.db.prepare('INSERT INTO events(task_id,type,data,created_at) VALUES(?,?,?,?)').run(taskID,type,JSON.stringify(data),Date.now()); }
  events(after = 0) { return this.db.prepare('SELECT * FROM events WHERE id>? ORDER BY id LIMIT 500').all(after); }
  audit(action: string, taskID: string|null, data: unknown = {}) { this.db.prepare('INSERT INTO audit_log(action,task_id,data,created_at) VALUES(?,?,?,?)').run(action,taskID,JSON.stringify(data),Date.now()); }
  session(role: string, directory: string): AgentSession|undefined {
    const r = this.db.prepare('SELECT * FROM sessions WHERE role=? AND directory=?').get(role,directory) as Record<string,string>|undefined;
    return r ? {id:r.id,runtimeID:r.runtime_id,role:r.role as AgentSession['role'],directory:r.directory,model:JSON.parse(r.model),summary:r.summary,state:r.state as AgentSession['state']} : undefined;
  }
  saveSession(s: AgentSession) { this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?) ON CONFLICT(role,directory) DO UPDATE SET model=excluded.model,summary=excluded.summary,state=excluded.state').run(s.id,s.runtimeID,s.role,s.directory,JSON.stringify(s.model),s.summary,s.state); }
  execution(task: Task) { const id = randomUUID(); this.db.prepare('INSERT INTO executions VALUES(?,?,?,?,NULL,?,NULL)').run(id,task.id,task.attempts,Date.now(),'running'); return id; }
  finishExecution(id: string, status: TaskStatus, error: string|null) { this.db.prepare('UPDATE executions SET finished_at=?,status=?,error=? WHERE id=?').run(Date.now(),status,error,id); }
  record(r: RequestRecord) { this.db.prepare('INSERT INTO model_requests(model,adapter,latency_ms,status,input_tokens,output_tokens,cached_tokens,estimated,cost,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(r.model,r.adapter,r.latencyMs,r.status,r.usage?.inputTokens ?? null,r.usage?.outputTokens ?? null,r.usage?.cachedTokens ?? null,r.usage ? Number(r.usage.estimated) : null,r.usage?.cost ?? null,Date.now()); }
  metrics() { return this.db.prepare('WITH ranked AS (SELECT *,ROW_NUMBER() OVER (PARTITION BY model,adapter,status ORDER BY latency_ms) AS rn,COUNT(*) OVER (PARTITION BY model,adapter,status) AS n FROM model_requests) SELECT model,adapter,status,COUNT(*) AS requests,SUM(input_tokens) AS input_tokens,SUM(output_tokens) AS output_tokens,SUM(cost) AS known_cost,SUM(cost IS NULL) AS unknown_cost_requests,AVG(latency_ms) AS avg_latency_ms,MAX(CASE WHEN rn=(n*95+99)/100 THEN latency_ms END) AS p95_latency_ms FROM ranked GROUP BY model,adapter,status').all(); }
  acquire(owner: string) {
    this.transaction(() => {
      const lock = this.db.prepare('SELECT * FROM scheduler_lock WHERE id=1').get() as {owner:string;expires_at:number}|undefined;
      if (lock && lock.owner !== owner && lock.expires_at > Date.now()) throw new AppError('Another supervisor owns this database',409,'scheduler_locked');
      this.db.prepare('INSERT INTO scheduler_lock VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at').run(owner,Date.now()+15000);
    });
  }
  recover() { for (const t of this.tasks()) if (['running','reviewing'].includes(t.status)) this.transition(t.id,'paused',{error:'Supervisor interrupted; inspect worktree and resume explicitly'}); this.db.prepare("UPDATE executions SET status='paused',finished_at=? WHERE finished_at IS NULL").run(Date.now()); }
  release(owner: string) { this.db.prepare('DELETE FROM scheduler_lock WHERE owner=?').run(owner); }
  close() { this.db.close(); }
}
