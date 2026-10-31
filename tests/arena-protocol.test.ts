import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ArenaProtocol,readProtocolTurn} from '../src/arena/protocol.ts';
import {accountHeaders,refreshedAccountCookies} from '../src/arena/http.ts';
import {discoverSessions} from '../src/arena/discover.ts';
const text=(value:string)=>({body:JSON.stringify({data:{type:'text-delta',delta:value}})});
const done=(value:string)=>({headers:[['trigger-control','turn-complete'],['session-in-event-id',value]] as [string,string][]});
test('HTTP protocol assigns output by input cursor and discards replayed history across split UTF-8 chunks',async()=>{
  const raw='event: batch\r\ndata: '+JSON.stringify({records:[text('old'),done('3'),text('本地文件'),done('4')]})+'\r\n\r\n',bytes=new TextEncoder().encode(raw);
  const response=new Response(new ReadableStream({start(controller){for(const byte of bytes)controller.enqueue(new Uint8Array([byte]));controller.close();}}),{headers:{'x-stream-version':'v2'}});
  const records=await readProtocolTurn(response,4);assert.equal(records.length,1);assert.match(records[0].body!,/本地文件/);assert.doesNotMatch(records[0].body!,/old/);
});
test('HTTP protocol rejects an unowned or incomplete response instead of reporting stale success',async()=>{
  await assert.rejects(readProtocolTurn(new Response('data: '+JSON.stringify({records:[text('old'),done('')]})+'\n\n',{headers:{'x-stream-version':'v2'}}),4));
  await assert.rejects(readProtocolTurn(new Response('data: '+JSON.stringify({records:[text('unfinished')]})+'\n\n',{headers:{'x-stream-version':'v2'}}),4));
});
test('a fresh input zero ignores the initial unowned history marker and returns only its owned output',async()=>{
  const records=[text('old history'),{headers:[['trigger-control','turn-complete']]},text('new input zero'),done('0')];
  const result=await readProtocolTurn(new Response('data: '+JSON.stringify({records})+'\n\n',{headers:{'x-stream-version':'v2'}}),0);assert.equal(result.length,1);assert.match(result[0].body!,/new input zero/);assert.doesNotMatch(result[0].body!,/old history/);
});
test('a rejected protocol send is attempted once and does not rotate accounts or fall back to DOM',async()=>{
  let appends=0;const credential={email:'fixture@example.invalid',cookieHeader:'arena-auth-prod-v1=fixture; cf_clearance=not-forwarded'};
  const protocol=new ArenaProtocol({credentials:{forSession(){return credential;}},complete:()=>({}),parse:()=>({text:'',nativeCalls:[]}),token:async()=> 'fixture-captcha',maxQueue:2,fetch:async(url,options)=>{
    if(String(url).endsWith('/trigger-token'))return Response.json({token:'fixture-token'});
    if(String(url).includes('/api/chat/'))return Response.json({id:'00000000-0000-0000-0000-000000000001',triggerAddress:'chat:fixture',messages:[{id:'previous-message',role:'user',metadata:{nodeId:'previous-node'}}]});
    if(String(url).endsWith('/in/append')){appends++;assert.match(String(url),/chat%3Afixture/);assert.doesNotMatch(String((options?.headers as Record<string,string>).cookie),/cf_clearance/);const payload=JSON.parse(String(options?.body)).payload;assert.equal(payload.message.id[14],'7');assert.ok(Math.abs(parseInt(payload.message.id.replaceAll('-','').slice(0,12),16)-Date.now())<1000);assert.equal(payload.message.metadata.lastUserMessageId,'previous-node');assert.equal(payload.metadata.timingInputId,payload.message.id);return new Response('{}',{status:429});}
    return new Response('{"triggerAddress":"chat:fixture"}');
  }});
  await assert.rejects(protocol.converse('00000000-0000-0000-0000-000000000001',{messages:[{role:'user',content:'fixture request'}]}),{status:429});assert.equal(appends,1);assert.equal(protocol.receipts[0].domActions,0);
});
test('a completed validation error stays terminal and distinct from an interrupted or verification turn',async()=>{
  let appends=0;const protocol=new ArenaProtocol({credentials:{forSession:()=>({email:'fixture@example.invalid',cookieHeader:''})},complete:()=>({}),parse:()=>({text:'',nativeCalls:[]}),maxQueue:1,fetch:async url=>{
    if(String(url).endsWith('/trigger-token'))return Response.json({token:'fixture-token'});
    if(String(url).includes('/api/chat/'))return Response.json({id:'00000000-0000-0000-0000-000000000001',triggerAddress:'fixture',messages:[]});
    if(String(url).endsWith('/in/append')){appends++;return Response.json({seq:7});}
    if(String(url).endsWith('/out'))return new Response('data: '+JSON.stringify({records:[{body:JSON.stringify({data:{type:'error',errorText:'Message validation failed. Please refresh and try again.'}})},done('7')]})+'\n\n',{headers:{'x-stream-version':'v2'}});
    return new Response('fixture page');
  }});
  await assert.rejects(protocol.converse('00000000-0000-0000-0000-000000000001',{messages:[{role:'user',content:'fixture'}]}),/消息格式校验失败/);assert.equal(appends,1);assert.equal(protocol.receipts[0].state,'failed');assert.equal(protocol.receipts[0].errorType,'message_validation_failed');assert.ok(protocol.receipts[0].finishedAt);
});
test('account renewal preserves only service updates and never sends verification cookies',()=>{
  const response=new Response();response.headers.append('set-cookie','arena-auth-prod-v1.0=new-part; Path=/; Max-Age=3600');response.headers.append('set-cookie','arena-auth-prod-v1.1=; Path=/; Max-Age=0');
  const renewed=refreshedAccountCookies('arena-auth-prod-v1.0=old; arena-auth-prod-v1.1=old-tail; cf_clearance=private',response);
  assert.equal(accountHeaders(renewed).cookie,'arena-auth-prod-v1.0=new-part');assert.match(renewed,/cf_clearance=private/);
});
test('history discovery follows protocol cursors and uses refreshed account cookies on the next page',async t=>{
  let calls=0,renewed='';t.mock.method(globalThis,'fetch',async(url:URL,options:RequestInit)=>{
    calls++;assert.equal(options.redirect,'error');assert.equal(url.pathname,'/api/history/unified');assert.equal(url.searchParams.get('type'),'agentic');
    if(calls===2){assert.equal(url.searchParams.get('cursor'),'next page');assert.equal((options.headers as Record<string,string>).cookie,'arena-auth-prod-v1=new');}
    const response=Response.json({entries:[{type:'agentic',id:`00000000-0000-0000-0000-00000000000${calls}`,title:'原始标题 '+calls}],pagination:{hasMore:calls===1,cursor:calls===1?'next page':null}});if(calls===1)response.headers.append('set-cookie','arena-auth-prod-v1=new; Path=/');return response;
  });
  const sessions=await discoverSessions({email:'owner@example.invalid',cookieHeader:'arena-auth-prod-v1=old'},cookie=>{renewed=cookie;});assert.equal(calls,2);assert.equal(sessions.length,2);assert.equal(sessions[1].title,'原始标题 2');assert.equal(renewed,'arena-auth-prod-v1=new');
});

test('consecutive protocol tool rounds reuse authorization and send only append plus owned SSE reads',async()=>{
  const id='00000000-0000-0000-0000-000000000001',requests:string[]=[],inputs:any[]=[];let seq=0;
  const protocol=new ArenaProtocol({credentials:{forSession:()=>({email:'owner@example.invalid',cookieHeader:'arena-auth-prod-v1=fixture'})},maxQueue:4,parse:()=>({text:'ok',nativeCalls:[]}),complete:(_model,text)=>text,fetch:async(url,options)=>{
    assert.equal(options?.redirect,'error');assert.equal(new URL(String(url)).origin,'https://arena.ai');const path=new URL(String(url)).pathname;requests.push(path);
    if(path.endsWith('/trigger-token'))return Response.json({token:'fixture-token'});
    if(path.startsWith('/api/chat/'))return Response.json({id,triggerAddress:'chat:fixture',messages:[]});
    if(path.endsWith('/in/append')){inputs.push(JSON.parse(String(options?.body)));return Response.json({seq:++seq});}
    return new Response('data: '+JSON.stringify({records:[text('ok'),done(String(seq))]})+'\n\n',{headers:{'x-stream-version':'v2'}});
  }});
  for(let n=0;n<2;n++)assert.equal(await protocol.converse(id,{messages:[{role:'user',content:'turn '+n}]},{headers:{'x-codex-session-id':'ses_same'}}),'ok');
  assert.equal(requests.filter(p=>p.startsWith('/api/chat/')).length,2);assert.equal(requests.length,6);assert.equal(inputs[1].payload.message.metadata.lastUserMessageId,inputs[0].payload.message.id);
  assert.deepEqual(protocol.receipts.map(r=>({authorization:r.authorizationRequests,http:r.transportRequests})),[{authorization:2,http:4},{authorization:0,http:2}]);assert.ok(requests.every(p=>!p.startsWith('/agent/')));
});
test('different account transports can overlap while each account retains one active turn',async()=>{
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;}),active=new Map<string,number>();let global=0,peak=0,count=0;const owners:string[]=[];
  const protocol=new ArenaProtocol({credentials:{forSession:email=>({email:email!,cookieHeader:'arena-auth-prod-v1='+email})},maxQueue:4,parse:()=>({text:'ok',nativeCalls:[]}),complete:()=>({}),fetch:async(url,options)=>{
    const path=new URL(String(url)).pathname;if(path.endsWith('/trigger-token'))return Response.json({token:'fixture-token'});if(path.startsWith('/api/chat/')){const id=path.split('/').at(-1);return Response.json({id,triggerAddress:id,messages:[]});}
    if(path.endsWith('/in/append')){const owner=(options?.headers as any).cookie;owners.push(owner);active.set(owner,(active.get(owner)??0)+1);assert.equal(active.get(owner),1);peak=Math.max(peak,++global);if(++count===2)entered();if(count<=2)await gate;active.set(owner,active.get(owner)!-1);global--;return Response.json({seq:0});}
    return new Response('data: '+JSON.stringify({records:[text('ok'),done('0')]})+'\n\n',{headers:{'x-stream-version':'v2'}});
  }});
  const body={messages:[{role:'user',content:'work'}]},run=Promise.all([protocol.converse('00000000-0000-0000-0000-000000000001',body,{accountEmail:'a@example.invalid'}),protocol.converse('00000000-0000-0000-0000-000000000002',body,{accountEmail:'a@example.invalid'}),protocol.converse('00000000-0000-0000-0000-000000000003',body,{accountEmail:'b@example.invalid'})]);
  try{await started;assert.equal(owners.length,2);assert.equal(new Set(owners).size,2);}finally{release();}await run;assert.equal(peak,2);assert.equal(owners.length,3);
});
