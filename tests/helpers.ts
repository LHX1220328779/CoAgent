import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/supervisor/worktree.ts';
import type { AgentRuntime, AgentRole, ModelRef, RuntimeResult } from '../src/types.ts';
export async function repoFixture(){const root=await mkdtemp(join(tmpdir(),'coagent-test-'));const repo=join(root,'repo');const {mkdir}=await import('node:fs/promises');await mkdir(repo);await git(repo,'init');await git(repo,'config','user.email','test@example.invalid');await git(repo,'config','user.name','CoAgent Test');await writeFile(join(repo,'README.md'),'fixture\n');await git(repo,'add','.');await git(repo,'commit','-m','fixture');return {root,repo,cleanup:()=>rm(root,{recursive:true,force:true})};}
export class FakeRuntime implements AgentRuntime {
  created:{role:AgentRole;directory:string;model:ModelRef;id:string}[]=[];prompts:{id:string;role:AgentRole;prompt:string}[]=[];
  handler?:(role:AgentRole,directory:string,prompt:string,signal:AbortSignal)=>Promise<string>;
  async create(role:AgentRole,directory:string,model:ModelRef){const id=`ses_${this.created.length}`;this.created.push({role,directory,model,id});return id;}
  async prompt(id:string,role:AgentRole,directory:string,model:ModelRef,prompt:string,signal:AbortSignal):Promise<RuntimeResult>{this.prompts.push({id,role,prompt});signal.throwIfAborted();const text=this.handler?await this.handler(role,directory,prompt,signal):role==='reviewer'?'{"approved":true,"findings":[]}':'Implemented';return {text,parts:[],usage:{inputTokens:1,outputTokens:1,cachedTokens:0,cost:0,estimated:true}};}
  async abort(){}
}
