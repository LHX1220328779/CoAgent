import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,dirname} from 'node:path';
export async function registerDevin(root:string,path=join(homedir(),'.windsurf/acp/registry.json')){
  let registry:any={version:'1.0.0',agents:[],extensions:[]};try{registry=JSON.parse(await readFile(path,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(registry.version!=='1.0.0'||!Array.isArray(registry.agents))throw new Error('现有 ACP registry 格式不受支持，未修改');
  const binary={archive:'',cmd:'/bin/bash',args:[join(root,'启动CoAgentACP.sh')]},agent={id:'coagent',name:'CoAgent',version:'0.1.0',description:'Arena 账号池与任务协作；OpenCode 执行内核',authors:['CoAgent'],license:'UNLICENSED',distribution:{binary:{'linux-x86_64':binary,'linux-aarch64':binary}}};
  registry={...registry,agents:[...registry.agents.filter((a:any)=>a.id!=='coagent'),agent]};await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path+'.coagent.tmp',JSON.stringify(registry,null,2)+'\n',{mode:0o600});await rename(path+'.coagent.tmp',path);return {path,agent:'coagent',next:'在 Devin User Settings → Agents 启用 CoAgent，然后重启客户端'};
}
