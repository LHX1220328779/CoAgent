import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalServices } from './services.ts';
import { createConsole } from './server.ts';
import { installShortcut } from './shortcut.ts';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
process.chdir(root);
const port=Number(process.env.COAGENT_CONSOLE_PORT??4312);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('COAGENT_CONSOLE_PORT 必须是有效端口');
const url=`http://127.0.0.1:${port}`;
function openBrowser(){
  if(process.env.COAGENT_NO_OPEN==='1')return;
  const child=spawn('xdg-open',[url],{stdio:'ignore',detached:true});child.on('error',()=>console.log(`请打开 ${url}`));child.unref();
}
const services=new LocalServices(root,process.env),server=createConsole(services);
server.once('error',async(error:NodeJS.ErrnoException)=>{
  if(error.code==='EADDRINUSE'){
    const existing=await fetch(url+'/health',{signal:AbortSignal.timeout(2000)}).then(r=>r.json()).catch(()=>null) as any;
    if(existing?.app==='coagent-console'&&existing.root===root){console.log(`控制台已经运行，已复用 ${url}`);openBrowser();return;}
  }
  console.error(`控制台端口 ${port} 不可用，未停止其他程序。可在 .env 设置 COAGENT_CONSOLE_PORT。`);process.exitCode=1;
});
server.listen(port,'127.0.0.1',()=>{
  console.log(`CoAgent 控制台 ${url}`);openBrowser();
  if(process.env.COAGENT_NO_SHORTCUT!=='1')void installShortcut(root).catch(()=>console.error('快捷方式未安装，可使用根目录启动CoAgent.sh'));
  void services.start().catch(()=>console.error('组件未全部启动，请查看控制台状态'));
});
let stopping=false;
async function stop(){if(stopping)return;stopping=true;server.closeAllConnections();server.close();try{await services.stopOwned();}catch(error){console.error(error instanceof Error?error.message:'部分组件尚未停止');process.exitCode=1;}}
process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());
