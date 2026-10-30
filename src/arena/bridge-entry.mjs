// CoAgent integration around the installed bridge. Third-party source is kept untouched.
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {setGlobalProxyFromEnv} from 'node:http';
import {discoverSessions} from './discover.ts';
import {browserNetwork,browserHeadless} from './network.ts';
import {ArenaProtocol} from './protocol.ts';
setGlobalProxyFromEnv();
const network=browserNetwork(process.env);
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),source=join(root,'arena-local-bridge/src');
const module=async name=>import(pathToFileURL(join(source,name)).href);
const [{loadConfig},{CredentialStore},{ArenaBrowser,PAGE_PURPOSES},{Bridge},{RecaptchaBroker},{createServer},{cookieHeaderToObjects},{parseAgentOutput,parsePublicToken}]=await Promise.all(['config.mjs','credentials.mjs','arena-login.mjs','bridge.mjs','recaptcha.mjs','server.mjs','cookie.mjs','parser.mjs'].map(module));
const state=resolve(process.env.COAGENT_ARENA_DATA_DIR??join(root,'.coagent/arena-bridge'));
await mkdir(state,{recursive:true,mode:0o700});
// Explicit user preference: local test/account data remains plaintext, owner-only.
class Accounts extends CredentialStore{
  upsert({email,cookieHeader,password,priority=1}){
    this.assertWritable();const previous=this.accounts.find(a=>a.email.toLowerCase()===email.toLowerCase());
    const entry={email,cookieHeader,loginSecret:password?JSON.stringify({email,password}):previous?.loginSecret??'',priority,updatedAt:new Date().toISOString(),disabled:false,lastError:null};
    if(previous)Object.assign(previous,entry);else this.accounts.push(entry);this.save();return entry;
  }
}
// Ordinary login, one attempt. Access/verification failures return to the user.
class LoginBrowser extends ArenaBrowser{
  async launch(){if(!this.browser){const browser=await this.pw.chromium.launch({headless:browserHeadless(),...(this.chromePath?{executablePath:this.chromePath}:{}),...(network.proxy?{proxy:network.proxy}:{})});this.browser=browser;browser.once('disconnected',()=>{if(this.browser===browser){this.browser=null;for(const entry of this.contexts.values()){entry.context=null;entry.pages.clear();}}});}return this.browser;}
  // Plain account contexts. Do not inherit third-party fingerprint scripts or deployment pins.
  async getPage(credential=null,purpose){
    if(!PAGE_PURPOSES[purpose])throw new Error('未知的浏览器页面用途');
    const email=String(credential?.email??''),signature=String(credential?.cookieHeader??'');
    let entry=this.contexts.get(email);if(!entry){entry={context:null,pages:new Map(),signature:'',staleSince:0,warned:false,leases:0};this.contexts.set(email,entry);}
    if(entry.context&&entry.signature!==signature){
      entry.staleSince=Date.now();if(entry.leases<=1){await entry.context.close();entry.context=null;entry.pages.clear();}
    }
    if(!entry.context){entry.context=await(await this.launch()).newContext();try{if(signature)await entry.context.addCookies(cookieHeaderToObjects(signature));}catch(error){await entry.context.close();entry.context=null;throw error;}entry.signature=signature;entry.staleSince=0;}
    let page=entry.pages.get(purpose);if(!page||page.isClosed()){page=await entry.context.newPage();entry.pages.set(purpose,page);}return page;
  }
  async login(email,password){
    const previous=this.contexts.get(email);if(previous?.leases)throw Object.assign(new Error('该账号正在执行任务，请先暂停'),{status:409,stage:'session'});
    const browser=await this.launch(),context=await browser.newContext(),page=await context.newPage();let retained=false;
    try{
      const initial=await page.goto('https://arena.ai/',{waitUntil:'domcontentloaded',timeout:45000});
      if([401,403,429].includes(initial?.status()))throw Object.assign(new Error('Arena 网页暂不可用'),{status:initial.status(),stage:'page',verificationRequired:initial.headers()['cf-mitigated']==='challenge'});
      const status=await page.evaluate(async({email,password})=>(await fetch('/nextjs-api/sign-in/email',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password})})).status,{email,password});
      if(status!==200)throw Object.assign(new Error('Arena 登录未成功'),{status,stage:'credentials'});
      const cookies=await context.cookies('https://arena.ai');
      if(!cookies.some(c=>c.name.startsWith('arena-auth-prod-v1'))||!await this.sessionIsUsable(page,email))throw Object.assign(new Error('Arena 会话未通过登录检查'),{status:401,stage:'session'});
      const cookieHeader=cookies.filter(c=>c.domain.endsWith('arena.ai')).map(c=>`${c.name}=${c.value}`).join('; ');
      await previous?.context?.close();this.contexts.set(email,{context,pages:new Map([['coagent-catalog',page]]),signature:cookieHeader,staleSince:0,warned:false,leases:0});retained=true;
      return {email,password,cookieHeader};
    }finally{if(!retained)await context.close();}
  }
}
PAGE_PURPOSES['coagent-catalog']={probe:false};
PAGE_PURPOSES['coagent-login']={probe:false};
process.env.ARENA_DEPLOYMENT_PIN='none';
const config=loadConfig({...process.env,ARENA_AGENT_PROXY:network.proxy?.server??'none',DATA_DIR:state,ARENA_ARCHIVE_DIR:join(state,'archive')});
const credentials=new Accounts({filePath:config.credentialsFile,secret:randomBytes(32).toString('hex')}).load();
const bridge=new Bridge({config,credentials,recaptcha:null,startedAt:Date.now()});
bridge.browser=new LoginBrowser({chromePath:config.chromePath,proxy:config.proxy});
bridge.recaptcha=new RecaptchaBroker({browser:bridge.browser,siteKey:config.recaptchaSiteKey,ttlMs:config.recaptchaTtlMs});
const renew=(account,cookieHeader)=>credentials.upsert({email:account.email,cookieHeader,password:'',priority:account.priority??1});
const protocol=new ArenaProtocol({credentials,parse:parseAgentOutput,parseToken:parsePublicToken,complete:(model,text)=>bridge.makeCompletion(model,text,null,''),maxQueue:config.maxQueue,refresh:renew});
bridge.converse=protocol.converse.bind(protocol);
bridge.runAgent=async()=>{throw Object.assign(new Error('协议模式需要先为任务分配现有会话'),{status:409});};
const health=bridge.healthPayload.bind(bridge);
bridge.healthPayload=()=>({...health(),transport:'http',protocolTurns:protocol.receipts.map(({sessionID,callerSession,state,inputSeq,errorType,domActions,startedAt,finishedAt})=>({sessionID,callerSession,state,inputSeq,errorType,domActions,startedAt,finishedAt})),network:{proxyConfigured:Boolean(network.proxy),proxySource:network.source},ready:credentials.list().some(a=>!a.disabled&&!(typeof a.cookieExpirySeconds==='number'&&a.cookieExpirySeconds<=0)&&bridge.readyAccounts.has(a.email.toLowerCase()))});
const server=createServer({bridge,config}),original=server.listeners('request')[0];server.removeAllListeners('request');
let catalog={accounts:[],sessions:[],syncedAt:null};
try{catalog=JSON.parse(await readFile(join(state,'catalog.json'),'utf8'));}catch{}
let busy=false;const interactive=new Map();
async function atomic(path,data){await mkdir(dirname(path),{recursive:true,mode:0o700});const temporary=path+'.tmp';await writeFile(temporary,JSON.stringify(data,null,2)+'\n',{mode:0o600});await rename(temporary,path);}
const respond=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data));};
async function body(req){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>16384)throw new Error('body too large');}return JSON.parse(raw||'{}');}
server.on('request',async(req,res)=>{
  const path=new URL(req.url??'/','http://localhost').pathname;
  if(path==='/v1/chat/completions')protocol.attach(req.headers,res);
  if(!['/coagent/sessions','/coagent/login/start','/coagent/login/status','/coagent/login/complete','/api/accounts/login'].includes(path))return original(req,res);
  try{
    const host=String(req.headers.host??''),origin=req.headers.origin,a=Buffer.from(String(req.headers.authorization??'')),b=Buffer.from('Bearer '+config.bridgeKey);
    if(!/^(127\.0\.0\.1|localhost):\d+$/.test(host)||(origin&&origin!==`http://${host}`)||a.length!==b.length||!timingSafeEqual(a,b))return respond(res,403,{error:{message:'本机桥接鉴权失败'}});
    if(path==='/coagent/login/status'&&req.method==='GET'){respond(res,200,{pending:[...interactive].map(([id,entry])=>({id,email:entry.email,failures:entry.failures}))});return;}
    if(req.method==='POST'&&path==='/coagent/login/start'){
      if(interactive.size){const [id,entry]=[...interactive][0];await entry.page.bringToFront();return respond(res,200,{id,email:entry.email});}const input=await body(req);if(typeof input.email!=='string'||!/^\S+@\S+\.\S+$/.test(input.email))return respond(res,400,{error:{message:'请先填写登录邮箱'}});
      if(browserHeadless())return respond(res,409,{error:{message:'网页登录需要桌面可见浏览器；请移除 ARENA_HEADED=0 后重启桥接'}});
      const saved=credentials.accounts.find(a=>a.email.toLowerCase()===input.email.toLowerCase()&&!a.disabled),credential=saved?credentials.forSession(saved.email):{email:input.email,cookieHeader:''};
      const page=await bridge.browser.getPage(credential,'coagent-login'),context=page.context(),visible=await bridge.browser.launch(),id=randomBytes(16).toString('hex'),failures=[];
      page.on('response',response=>{const url=new URL(response.url());if(url.hostname==='arena.ai'&&response.status()>=400){failures.push({path:url.pathname,status:response.status(),verificationRequired:response.headers()['cf-mitigated']==='challenge'});if(failures.length>8)failures.shift();}});
      const disconnected=()=>interactive.delete(id);interactive.set(id,{email:credential.email,visible,context,page,failures,disconnected});visible.once('disconnected',disconnected);await page.goto('https://arena.ai/',{waitUntil:'domcontentloaded',timeout:45000}).catch(()=>{});await page.bringToFront();respond(res,200,{id,email:credential.email});return;
    }
    if(req.method==='POST'&&path==='/coagent/login/complete'){
      const input=await body(req),pending=interactive.get(input.id);if(!pending)return respond(res,409,{error:{message:'登录窗口已关闭，请重新打开'}});
      if(!await bridge.browser.sessionIsUsable(pending.page,pending.email))return respond(res,422,{error:{message:'请先在打开的窗口完成正确账号的网页登录和验证'}});
      const cookies=await pending.context.cookies('https://arena.ai');if(!cookies.some(c=>c.name.startsWith('arena-auth-prod-v1')))return respond(res,422,{error:{message:'未取得有效的网页登录状态'}});
      const cookieHeader=cookies.filter(c=>c.domain.endsWith('arena.ai')).map(c=>`${c.name}=${c.value}`).join('; ');credentials.upsert({email:pending.email,password:'',cookieHeader});const entry=bridge.browser.contexts.get(pending.email);if(entry?.context===pending.context)entry.signature=cookieHeader;
      bridge.readyAccounts.add(pending.email.toLowerCase());interactive.delete(input.id);pending.visible.off('disconnected',pending.disconnected);await pending.page.close();respond(res,200,{ok:true});return;
    }
    if(path==='/api/accounts/login'&&req.method==='POST'){
      if(busy)return respond(res,409,{error:{message:'正在执行登录或同步，请稍候'}});const input=await body(req);
      if(typeof input.email!=='string'||!/^\S+@\S+\.\S+$/.test(input.email)||typeof input.password!=='string'||!input.password)return respond(res,400,{error:{message:'请填写邮箱和密码'}});
      busy=true;
      try{const account=await bridge.browser.login(input.email,input.password);credentials.upsert(account);bridge.readyAccounts.add(account.email.toLowerCase());respond(res,200,{ok:true});}
      catch(error){respond(res,422,{error:{message:'Arena 登录被拒绝或需要在网页完成验证',upstreamStatus:typeof error.status==='number'?error.status:null,stage:error.stage??'network',verificationRequired:error.verificationRequired??false}});}finally{busy=false;}return;
    }
    if(req.method==='GET')return respond(res,200,catalog);
    if(req.method!=='POST')return respond(res,405,{error:{message:'不支持的操作'}});
    if(busy)return respond(res,409,{error:{message:'正在执行登录或同步，请稍候'}});busy=true;
    try{
      const results=[],sessions=[];
      for(const account of credentials.list()){
        if(account.disabled){bridge.readyAccounts.delete(account.email.toLowerCase());results.push({email:account.email,available:false,error:'请重新登录'});continue;}
        try{const credential=credentials.forSession(account.email),found=await discoverSessions(credential,cookie=>renew(credential,cookie));bridge.readyAccounts.add(account.email.toLowerCase());sessions.push(...found.map(s=>({...s,accountEmail:account.email,available:true})));results.push({email:account.email,available:true,count:found.length});}
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
async function stop(){server.closeAllConnections();server.close();for(const entry of interactive.values())await entry.page.close().catch(()=>{});interactive.clear();await bridge.browser.close();}
process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());
