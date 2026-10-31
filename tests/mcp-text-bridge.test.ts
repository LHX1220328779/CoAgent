import {test} from 'node:test';
import assert from 'node:assert/strict';
import {McpTextBridge} from '../src/runtime/mcp-text-bridge.ts';
import {createServer} from 'node:http';
import {once} from 'node:events';

test('opt-in MCP text transport preserves permissions and actual text errors without claiming structured output',async()=>{
  const messages:any[]=[],inputSchema={type:'object',properties:{path:{type:'string'}}},outputSchema={type:'object'},content=[{type:'text',text:'PATH_OUTSIDE_WORKSPACE'}];
  const bridge=new McpTextBridge('https://fixture.invalid/mcp',async(_url,options)=>{
    assert.equal(options?.redirect,'error');const request=JSON.parse(String(options?.body)),headers=options?.headers as Record<string,string>;
    if(request.method==='initialize')return Response.json({jsonrpc:'2.0',id:request.id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}}}},{headers:{'mcp-session-id':'fixture-session'}});
    assert.equal(headers['mcp-session-id'],'fixture-session');assert.equal(headers['mcp-protocol-version'],'2025-06-18');
    return Response.json({jsonrpc:'2.0',id:request.id,result:request.method==='tools/list'?{tools:[{name:'read_files',inputSchema,outputSchema,annotations:{readOnlyHint:true}}]}:{content,isError:true}});
  });
  await bridge.forward({jsonrpc:'2.0',id:1,method:'initialize'},message=>messages.push(message));
  await bridge.forward({jsonrpc:'2.0',id:2,method:'tools/list'},message=>messages.push(message));
  await bridge.forward({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'read_files',arguments:{path:'/denied'}}},message=>messages.push(message));
  assert.equal(messages[1].result.tools[0].outputSchema,undefined);assert.deepEqual(messages[1].result.tools[0].inputSchema,inputSchema);assert.equal(messages[1].result.tools[0].annotations.readOnlyHint,true);assert.deepEqual(messages[2].result,{content,isError:true});
});
test('MCP redirects cannot forward a tool request or session header to another destination',async()=>{
  let forwarded=0;const destination=createServer((_req,res)=>{forwarded++;res.end('{}');});destination.listen(0,'127.0.0.1');await once(destination,'listening');
  const target=`http://127.0.0.1:${(destination.address() as {port:number}).port}/unapproved`;
  const origin=createServer((_req,res)=>{res.writeHead(307,{location:target});res.end();});origin.listen(0,'127.0.0.1');await once(origin,'listening');
  try{
    const bridge=new McpTextBridge(`http://127.0.0.1:${(origin.address() as {port:number}).port}/mcp`),replies:any[]=[];
    await bridge.forward({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'read_files',arguments:{path:'private-project-file'}}},reply=>replies.push(reply));
    assert.equal(forwarded,0);assert.equal(replies[0].error.message,'MCP transport failed');assert.doesNotMatch(JSON.stringify(replies),/private-project-file|unapproved/);
  }finally{await Promise.all([origin,destination].map(server=>{server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()));}));}
});
test('MCP text transport reads split SSE frames and returns transport failures without exposing the capability URL',async()=>{
  const replies:any[]=[],raw='data: '+JSON.stringify({jsonrpc:'2.0',id:4,result:{content:[{type:'text',text:'真实文件'}]}})+'\r\n\r\n';
  const bridge=new McpTextBridge('https://fixture.invalid/private-capability',async()=>new Response(new ReadableStream({start(controller){for(const byte of new TextEncoder().encode(raw))controller.enqueue(new Uint8Array([byte]));controller.close();}}),{headers:{'content-type':'text/event-stream'}}));
  await bridge.forward({jsonrpc:'2.0',id:4,method:'tools/call'},message=>replies.push(message));assert.equal(replies[0].result.content[0].text,'真实文件');
  const failed=new McpTextBridge('https://fixture.invalid/private-capability',async()=>{throw new Error('https://fixture.invalid/private-capability');});await failed.forward({jsonrpc:'2.0',id:5,method:'tools/call'},message=>replies.push(message));assert.equal(replies.length,2);assert.doesNotMatch(JSON.stringify(replies),/private-capability/);
});
