import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, realpath } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { AppError } from '../errors.ts';
import type { WorktreeManager } from '../types.ts';
const exec = promisify(execFile);
export async function git(directory: string, ...args: string[]) { return (await exec('git',args,{cwd:directory,maxBuffer:8*1024*1024,timeout:30000})).stdout.trim(); }
export class GitWorktrees implements WorktreeManager {
  root: string;
  constructor(root: string) { this.root = resolve(root); }
  async create(taskID: string, repo: string) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(taskID)) throw new AppError('Invalid worktree ID');
    const path = join(this.root,taskID); await mkdir(this.root,{recursive:true,mode:0o700});
    const canonical = await realpath(repo); const top = await git(canonical,'rev-parse','--show-toplevel');
    if (canonical !== await realpath(top)) throw new AppError('repo must be the Git root');
    await git(repo,'worktree','add','-b',`coagent/${taskID}`,path,'HEAD'); return path;
  }
  async diff(directory: string) {
    const tracked = await git(directory,'diff','HEAD','--');
    const untracked = await git(directory,'ls-files','--others','--exclude-standard');
    return `${tracked}\nUntracked files:\n${untracked}`;
  }
  async remove(directory: string, repo: string) {
    const path = await realpath(directory), root = await realpath(this.root);
    if (!path.startsWith(root + sep)) throw new AppError('Outside managed worktrees');
    if (await git(path,'status','--porcelain')) throw new AppError('Refusing to remove dirty worktree',409);
    await git(repo,'worktree','remove',path); // No --force, branch remains recoverable.
  }
}
export async function acceptance(directory: string, argv: string[], signal: AbortSignal) {
  if (!argv.length || argv.some(x=>typeof x !== 'string') || argv[0].startsWith('-')) throw new AppError('Invalid acceptance command');
  const result = await exec(argv[0],argv.slice(1),{cwd:directory,signal,timeout:120000,maxBuffer:1024*1024});
  return {stdout:result.stdout,stderr:result.stderr};
}
