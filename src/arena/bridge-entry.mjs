// CoAgent integration around the installed bridge. Third-party source is kept untouched.
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {discoverSessions} from './discover.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),source=join(root,'arena-local-bridge/src');
const module=async name=>import(pathToFileURL(join(source,name)).href);
const [{loadConfig},{CredentialStore},{ArenaBrowser,PAGE_PURPOSES},{Bridge},{RecaptchaBroker},{createServer}]=await Promise.all(['config.mjs','credentials.mjs','arena-login.mjs','bridge.mjs','recaptcha.mjs','server.mjs'].map(module));
const state=resolve(process.env.COAGENT_ARENA_DATA_DIR??join(root,'.coagent/arena-bridge'));
await mkdir(state,{recursive:true,mode:0o700});
// Explicit user preference: local test/account data remains plaintext, owner-only.
class Accounts extends CredentialStore{
  upsert({email,cookieHeader,password,priority=1}){
    this.assertWritable();const previous=this.accounts.find(a=>a.email.toLowerCase()===email.toLowerCase());
    const entry={email,cookieHeader,loginSecret:JSON.stringify({email,password}),priority,updatedAt:new Date().toISOString(),disabled:false,lastError:null};
    if(previous)Object.assign(previous,entry);else this.accounts.push(entry);this.save();return entry;
  }
}
// Ordinary login, one attempt. Access/verification failures return to the user.
class LoginBrowser extends ArenaBrowser{
  async launch(){if(!this.browser)this.browser=await this.pw.chromium.launch({headless:process.env.ARENA_HEADED!=='1',...(this.chromePath?{executablePath:this.chromePath}:{}),...(this.proxy?{proxy:{server:this.proxy}}:{})});return this.browser;}
  async login(email,password){
    const browser=await this.launch(),context=await browser.newContext(),page=await context.newPage();
    try{
      const initial=await page.goto('https://arena.ai/',{waitUntil:'domcontentloaded',timeout:45000});
      if([401,403,429].includes(initial?.status()))throw Object.assign(new Error('Arena 网页暂不可用'),{status:initial.status()});
      const status=await page.evaluate(async({email,password})=>(await fetch('/nextjs-api/sign-in/email',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password})})).status,{email,password});
      if(status!==200)throw Object.assign(new Error('Arena 登录未成功'),{status});
      const cookies=await context.cookies('https://arena.ai');
      if(!cookies.some(c=>c.name.startsWith('arena-auth-prod-v1'))||!await this.sessionIsUsable(page,email))throw Object.assign(new Error('Arena 会话未通过登录检查'),{status:401});
      return {email,password,cookieHeader:cookies.filter(c=>c.domain.endsWith('arena.ai')).map(c=>`${c.name}=${c.value}`).join('; ')};
    }finally{await context.close();}
  }
}
PAGE_PURPOSES['coagent-catalog']={probe:false};
process.env.ARENA_DEPLOYMENT_PIN='none';
const config=loadConfig({...process.env,DATA_DIR:state,ARENA_ARCHIVE_DIR:join(state,'archive')});
const credentials=new Accounts({filePath:config.credentialsFile,secret:randomBytes(32).toString('hex')}).load();
const bridge=new Bridge({config,credentials,recaptcha:null,startedAt:Date.now()});
bridge.browser=new LoginBrowser({chromePath:config.chromePath,proxy:config.proxy});
bridge.recaptcha=new RecaptchaBroker({browser:bridge.browser,siteKey:config.recaptchaSiteKey,ttlMs:config.recaptchaTtlMs});
const health=bridge.healthPayload.bind(bridge);
bridge.healthPayload=()=>({...health(),ready:credentials.list().some(a=>!a.disabled&&!(typeof a.cookieExpirySeconds==='number'&&a.cookieExpirySeconds<=0)&&bridge.readyAccounts.has(a.email.toLowerCase()))});
const server=createServer({bridge,config}),original=server.listeners('request')[0];server.removeAllListeners('request');
let catalog={accounts:[],sessions:[],syncedAt:null};
try{catalog=JSON.parse(await readFile(join(state,'catalog.json'),'utf8'));}catch{}
let busy=false;const interactive=new Map();
async function atomic(path,data){await mkdir(dirname(path),{recursive:true,mode:0o700});const temporary=path+'.tmp';await writeFile(temporary,JSON.stringify(data,null,2)+'\n',{mode:0o600});await rename(temporary,path);}
const respond=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data));};
async function body(req){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>16384)throw new Error('body too large');}return JSON.parse(raw||'{}');}
server.on('request',async(req,res)=>{
  const path=new URL(req.url??'/','http://localhost').pathname;
  if(!['/coagent/sessions','/coagent/login/start','/coagent/login/status','/coagent/login/complete','/api/accounts/login'].includes(path))return original(req,res);
  try{
    const host=String(req.headers.host??''),origin=req.headers.origin,a=Buffer.from(String(req.headers.authorization??'')),b=Buffer.from('Bearer '+config.bridgeKey);
    if(!/^(127\.0\.0\.1|localhost):\d+$/.test(host)||(origin&&origin!==`http://${host}`)||a.length!==b.length||!timingSafeEqual(a,b))return respond(res,403,{error:{message:'本机桥接鉴权失败'}});
    if(path==='/coagent/login/status'&&req.method==='GET'){respond(res,200,{pending:[...interactive].map(([id,entry])=>({id,email:entry.email}))});return;}
    if(req.method==='POST'&&path==='/coagent/login/start'){
      if(interactive.size){const [id,entry]=[...interactive][0];await entry.page.bringToFront();return respond(res,200,{id,email:entry.email});}const input=await body(req);if(typeof input.email!=='string'||!/^\S+@\S+\.\S+$/.test(input.email))return respond(res,400,{error:{message:'请先填写登录邮箱'}});
      const visible=await bridge.browser.pw.chromium.launch({headless:false,...(config.chromePath?{executablePath:config.chromePath}:{}),...(config.proxy?{proxy:{server:config.proxy}}:{})});
      const context=await visible.newContext(),page=await context.newPage(),id=randomBytes(16).toString('hex');interactive.set(id,{email:input.email,visible,context,page});visible.once('disconnected',()=>interactive.delete(id));await page.goto('https://arena.ai/',{waitUntil:'domcontentloaded',timeout:45000}).catch(()=>{});respond(res,200,{id,email:input.email});return;
    }
    if(req.method==='POST'&&path==='/coagent/login/complete'){
      const input=await body(req),pending=interactive.get(input.id);if(!pending)return respond(res,409,{error:{message:'登录窗口已关闭，请重新打开'}});
      if(!await bridge.browser.sessionIsUsable(pending.page,pending.email))return respond(res,422,{error:{message:'请先在打开的窗口完成正确账号的网页登录和验证'}});
      const cookies=await pending.context.cookies('https://arena.ai');if(!cookies.some(c=>c.name.startsWith('arena-auth-prod-v1')))return respond(res,422,{error:{message:'未取得有效的网页登录状态'}});
      credentials.upsert({email:pending.email,password:'',cookieHeader:cookies.filter(c=>c.domain.endsWith('arena.ai')).map(c=>`${c.name}=${c.value}`).join('; ')});bridge.readyAccounts.add(pending.email.toLowerCase());await pending.visible.close();respond(res,200,{ok:true});return;
    }
    if(path==='/api/accounts/login'&&req.method==='POST'){
      if(busy)return respond(res,409,{error:{message:'正在执行登录或同步，请稍候'}});const input=await body(req);
      if(typeof input.email!=='string'||!/^\S+@\S+\.\S+$/.test(input.email)||typeof input.password!=='string'||!input.password)return respond(res,400,{error:{message:'请填写邮箱和密码'}});
      busy=true;
      try{const account=await bridge.browser.login(input.email,input.password);credentials.upsert(account);bridge.readyAccounts.add(account.email.toLowerCase());respond(res,200,{ok:true});}
      catch(error){respond(res,422,{error:{message:'Arena 登录被拒绝或需要在网页完成验证',upstreamStatus:typeof error.status==='number'?error.status:null}});}finally{busy=false;}return;
    }
    if(req.method==='GET')return respond(res,200,catalog);
    if(req.method!=='POST')return respond(res,405,{error:{message:'不支持的操作'}});
    if(busy)return respond(res,409,{error:{message:'正在执行登录或同步，请稍候'}});busy=true;
    try{
      const results=[],sessions=[];
      for(const account of credentials.list()){
        if(account.disabled||(typeof account.cookieExpirySeconds==='number'&&account.cookieExpirySeconds<=0)){bridge.readyAccounts.delete(account.email.toLowerCase());results.push({email:account.email,available:false,error:'请重新登录'});continue;}
        try{const found=await discoverSessions(bridge.browser,credentials.forSession(account.email));bridge.readyAccounts.add(account.email.toLowerCase());sessions.push(...found.map(s=>({...s,accountEmail:account.email,available:true})));results.push({email:account.email,available:true,count:found.length});}
        catch(error){bridge.readyAccounts.delete(account.email.toLowerCase());results.push({email:account.email,available:false,error:'会话读取失败，请正常处理登录或网页验证',upstreamStatus:error.status??null});}
      }
      catalog={accounts:results,sessions,syncedAt:Date.now()};await atomic(join(state,'catalog.json'),catalog);
      let entries=[];try{entries=JSON.parse(await readFile(join(config.archiveDir,'记录.json'),'utf8'));}catch{}
      const merged=new Map(entries.map(e=>[e.Id,e]));for(const s of sessions)merged.set(s.id.replaceAll('-',''),{Id:s.id.replaceAll('-',''),Title:s.title,Url:s.url,Email:s.accountEmail,Model:'',CoAgentDiscovered:true});await atomic(join(config.archiveDir,'记录.json'),[...merged.values()]);
      respond(res,200,catalog);
    }finally{busy=false;}
  }catch{if(!res.headersSent)respond(res,500,{error:{message:'本机会话同步未完成'}});}
});
server.listen(config.port,config.host,()=>console.log(`CoAgent Arena bridge http://${config.host}:${config.port}`));
async function stop(){server.closeAllConnections();server.close();for(const entry of interactive.values())await entry.visible.close();await bridge.browser.close();}
process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());
