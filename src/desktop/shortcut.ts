import { mkdir, writeFile, chmod, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile);
/** Desktop entry only; no system installation or administrator privileges. */
export async function installShortcut(root:string){
  const entry=`[Desktop Entry]\nType=Application\nName=CoAgent\nComment=本地多 Agent 编程工作台\nExec="${join(root,'启动CoAgent.sh').replace(/[\\"`$]/g,'\\$&')}"\nIcon=${join(root,'src/desktop/public/icon.svg')}\nTerminal=false\nCategories=Development;\nStartupNotify=false\n`;
  const menu=join(homedir(),'.local/share/applications');await mkdir(menu,{recursive:true});await writeFile(join(menu,'coagent.desktop'),entry,{mode:0o755});
  const desktop=await exec('xdg-user-dir',['DESKTOP'],{timeout:2000}).then(r=>r.stdout.trim()).catch(()=>'');
  if(desktop&&desktop!==homedir()&&(await stat(desktop).catch(()=>null))?.isDirectory()){
    const path=join(desktop,'CoAgent.desktop');await writeFile(path,entry,{mode:0o755});await chmod(path,0o755);await exec('gio',['set',path,'metadata::trusted','true'],{timeout:2000}).catch(()=>{});
  }
}
