import {randomBytes,randomUUID} from 'node:crypto';
import {AppError} from '../errors.ts';
import {accountHeaders,refreshedAccountCookies} from './http.ts';
type Credential={email:string;cookieHeader:string};
type StreamRecord={seq_num?:number;headers?:[string,string][];body?:string};
type Receipt={sessionID:string;callerSession:string;transport:'http';messageID:string;partID:string;state:string;inputSeq?:number;errorType?:string;domActions:0;startedAt:number;finishedAt?:number};
function messageUUID(){const bytes=randomBytes(16);bytes.writeUIntBE(Date.now(),0,6);bytes[6]=(bytes[6]&15)|0x70;bytes[8]=(bytes[8]&63)|0x80;const hex=bytes.toString('hex');return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');}

/** V2 assigns every completed output group to an input cursor. Never return replayed history. */
export async function readProtocolTurn(response:Response,inputSeq:number,onCursor:(cursor:string)=>void=()=>{}){
  if(!response.ok){await response.body?.cancel();throw new AppError(`Arena 输出协议 HTTP ${response.status}`,response.status);}
  if(response.headers.get('x-stream-version')!=='v2'||!response.body){await response.body?.cancel();throw new AppError('Arena 输出协议缺少 V2 输入归属，已停止',422);}
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',group:StreamRecord[]=[],bytes=0;
  try{for(;;){const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});buffer=buffer.replace(/\r\n/g,'\n');let end;
    while((end=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);const raw=block.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(!raw)continue;
      let batch:{records?:StreamRecord[]};try{batch=JSON.parse(raw);}catch{throw new AppError('Arena 输出协议包含无效事件',422);}
      for(const record of batch.records??[]){if(record.seq_num!==undefined)onCursor(String(record.seq_num));
        const headers=new Map((record.headers??[]).map(([key,value])=>[key.toLowerCase(),value]));
        if(headers.get('trigger-control')==='turn-complete'){
          const rawCursor=headers.get('session-in-event-id')??'';
          // Initial replay can end with an unowned idle marker, including old
          // model output. Discard it; only an explicitly owned cursor may return.
          if(rawCursor===''){group=[];bytes=0;continue;}
          const cursor=Number(rawCursor);if(!/^\d+$/.test(rawCursor)||!Number.isSafeInteger(cursor))throw new AppError('Arena 完成事件缺少合法输入归属',422);
          if(cursor===inputSeq)return group;if(cursor>inputSeq)throw new AppError('Arena 输出已超过本次输入，需人工确认',422);
          group=[];bytes=0;
        }else{group.push(record);bytes+=(record.body?.length??0);if(bytes>8*1024*1024)throw new AppError('Arena 单轮输出超过本地预算',413);}
      }
    }
  }throw new AppError('Arena 输出在本次输入完成前中断，禁止重发',422);
  }finally{await reader.cancel().catch(()=>{});}
}

export class ArenaProtocol{
  private queue:Promise<unknown>=Promise.resolve();private pending=0;
  private signals=new WeakMap<object,AbortSignal>();private cursors=new Map<string,string>();
  readonly receipts:Receipt[]=[];
  private credentials:{forSession(email?:string):Credential};private complete:(model:string,text:string)=>unknown;
  private parse:(raw:string)=>{text:string;nativeCalls:unknown[]};private token:(credential:Credential)=>Promise<string|null>;private maxQueue:number;
  private parseToken:(html:string)=>string;private request:typeof fetch;
  private refresh?: (credential:Credential,cookieHeader:string)=>void;
  constructor(options:{credentials:ArenaProtocol['credentials'];complete:ArenaProtocol['complete'];parse:ArenaProtocol['parse'];parseToken:ArenaProtocol['parseToken'];token?:ArenaProtocol['token'];maxQueue:number;fetch?:typeof fetch;refresh?:ArenaProtocol['refresh']}){
    this.credentials=options.credentials;this.complete=options.complete;this.parse=options.parse;this.parseToken=options.parseToken;this.token=options.token??(async()=>null);this.maxQueue=options.maxQueue;this.request=options.fetch??fetch;this.refresh=options.refresh;
  }
  attach(headers:object,response:{once:(event:string,fn:()=>void)=>unknown;writableFinished:boolean}){const controller=new AbortController();this.signals.set(headers,controller.signal);response.once('close',()=>{if(!response.writableFinished)controller.abort();});}
  converse(sessionID:string,body:{model?:string;messages?:{role:string;content:unknown}[]},options:{headers?:Record<string,unknown>;account?:Credential;accountEmail?:string;onDelta?:((text:string)=>void)|null}={}){
    if(++this.pending>this.maxQueue){this.pending--;throw new AppError('Arena 协议队列已满',503);}
    const run=this.queue.then(()=>this.turn(sessionID,body,options));this.queue=run.catch(()=>{});return run.finally(()=>{this.pending--;});
  }
  private async turn(sessionID:string,body:{model?:string;messages?:{role:string;content:unknown}[]},options:{headers?:Record<string,unknown>;account?:Credential;accountEmail?:string;onDelta?:((text:string)=>void)|null}){
    if(!/^[0-9a-f-]{36}$/i.test(sessionID))throw new AppError('协议模式需要已绑定的 Arena 会话',409);
    let account=options.account??this.credentials.forSession(options.accountEmail);const last=body.messages?.findLast(message=>message.role==='user');
    if(typeof last?.content!=='string'||!last.content)throw new AppError('Arena 协议请求缺少文本',400);
    const signal=AbortSignal.any([AbortSignal.timeout(600000),...(options.headers&&this.signals.has(options.headers)?[this.signals.get(options.headers)!]:[])]);signal.throwIfAborted();
    // Only first-party account authentication; never copy browser verification cookies.
    const headers={...accountHeaders(account.cookieHeader),accept:'text/html'};
    const page=await this.request(`https://arena.ai/agent/${sessionID}`,{headers,signal});if(!page.ok){await page.body?.cancel();throw new AppError(`Arena 会话协议 HTTP ${page.status}`,page.status);}
    const renewed=refreshedAccountCookies(account.cookieHeader,page);if(renewed!==account.cookieHeader){this.refresh?.(account,renewed);account={...account,cookieHeader:renewed};}
    const html=await page.text(),accessToken=this.parseToken(html);if(!accessToken)throw new AppError('Arena 会话未提供协议授权令牌',401);
    const snapshotResponse=await this.request('https://arena.ai/api/chat/'+sessionID+'?includeStreamToken=false&recoverRun=false',{headers:{...accountHeaders(account.cookieHeader),accept:'application/json'},signal});
    if(!snapshotResponse.ok){await snapshotResponse.body?.cancel();throw new AppError('Arena 会话历史协议 HTTP '+snapshotResponse.status,snapshotResponse.status);}
    const snapshotCookies=refreshedAccountCookies(account.cookieHeader,snapshotResponse);if(snapshotCookies!==account.cookieHeader){this.refresh?.(account,snapshotCookies);account={...account,cookieHeader:snapshotCookies};}
    const snapshot=await snapshotResponse.json() as {id?:string;triggerAddress?:string;messages?:{id?:string;role?:string;metadata?:{nodeId?:string}}[]};
    if(snapshot.id!==sessionID||!Array.isArray(snapshot.messages))throw new AppError('Arena 会话历史格式无效，未发送消息',422);
    const trigger=snapshot.triggerAddress;
    if(!trigger||trigger.length>512||/[\u0000-\u001f]/.test(trigger))throw new AppError('Arena 协议会话地址无效',422);
    const previousUser=snapshot.messages.findLast(message=>message.role==='user'),lastUserMessageId=previousUser?.metadata?.nodeId??previousUser?.id??null;
    const messageID=messageUUID(),partID=randomUUID(),receipt:Receipt={sessionID,callerSession:String(options.headers?.['x-codex-session-id']??''),transport:'http',messageID,partID,state:'authorizing',domActions:0,startedAt:Date.now()};this.receipts.push(receipt);if(this.receipts.length>100)this.receipts.shift();
    // The site's transport permits null when its optional client token is unavailable.
    // Do not open or script a verification page; server authorization errors remain final.
    const recaptchaV3Token=await this.token(account);signal.throwIfAborted();
    const endpoint=`https://arena.ai/ai-proxy/realtime/v1/sessions/${encodeURIComponent(trigger)}`;
    const auth={...accountHeaders(account.cookieHeader),authorization:`Bearer ${accessToken}`,'content-type':'application/json','x-trigger-source':'sdk'};
    let accepted=false;
    const stop=()=>{if(!accepted)return;void this.request(endpoint+'/in/append',{method:'POST',headers:{...auth,'x-part-id':randomUUID()},body:JSON.stringify({kind:'stop',targetInputId:messageID}),signal:AbortSignal.timeout(10000)}).then(async response=>{receipt.state=response.ok?'stop_accepted':'stop_unconfirmed';await response.body?.cancel();}).catch(()=>{receipt.state='stop_unconfirmed';});};
    signal.addEventListener('abort',stop,{once:true});
    try{
      receipt.state='sending';const append=await this.request(endpoint+'/in/append',{method:'POST',headers:{...auth,'x-part-id':partID},body:JSON.stringify({kind:'message',payload:{chatId:trigger,trigger:'submit-message',message:{id:messageID,role:'user',parts:[{type:'text',text:last.content}],metadata:{lastUserMessageId}},metadata:{originHost:'arena.ai',timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,timingInputId:messageID,recaptchaV3Token}}}),signal});
      if(!append.ok){await append.body?.cancel();receipt.state='rejected';throw new AppError(`Arena 发送协议 HTTP ${append.status}`,append.status);}
      const result=await append.json() as {seq?:number};if(!Number.isSafeInteger(result.seq)||result.seq!<0){receipt.state='send_unconfirmed';throw new AppError('Arena 未确认输入序号，禁止重发',422);}
      accepted=true;receipt.inputSeq=result.seq;receipt.state='accepted';
      const output=await this.request(endpoint+'/out',{headers:{...auth,accept:'text/event-stream',...(this.cursors.has(sessionID)?{'last-event-id':this.cursors.get(sessionID)!}:{})},signal});
      const records=await readProtocolTurn(output,result.seq!,cursor=>this.cursors.set(sessionID,cursor));
      const errors=records.flatMap(record=>{try{const data=JSON.parse(record.body??'{}').data;return data?.type==='error'?[data]:[];}catch{return [];}});
      if(errors.length){const messages=errors.map(error=>String(error.errorText??error.message??''));receipt.errorType=messages.includes('Message validation failed. Please refresh and try again.')?'message_validation_failed':messages.includes('recaptcha validation failed')?'verification_required':'execution_failed';receipt.state='failed';receipt.finishedAt=Date.now();throw new AppError(receipt.errorType==='message_validation_failed'?'Arena 消息格式校验失败，本轮已结束':receipt.errorType==='verification_required'?'Arena 要求正常网页验证，本轮已结束':'Arena 当前输入执行失败，本轮已结束',422);}
      const parsed=this.parse('data: '+JSON.stringify({records})+'\n\n');if(!parsed.text.trim())throw new AppError('Arena 本次输入没有文本结果，禁止重发',422);
      receipt.state='completed';receipt.finishedAt=Date.now();options.onDelta?.(parsed.text);return this.complete(body.model??sessionID,parsed.text);
    }catch(error){if(!['failed','rejected','stop_accepted','stop_unconfirmed','send_unconfirmed'].includes(receipt.state))receipt.state=accepted?'interrupted':'send_unconfirmed';throw error;}
    finally{signal.removeEventListener('abort',stop);}
  }
}
