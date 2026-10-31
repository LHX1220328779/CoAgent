import {accountHeaders,refreshedAccountCookies} from './http.ts';
type Credential={email:string;cookieHeader:string};
/** Read the same paginated history API as Arena's own client. No page or model turn. */
export async function discoverSessions(credential:Credential,refresh:(cookieHeader:string)=>void){
  const found=new Map<string,{id:string;title:string;url:string}>(),visited=new Set<string>();let cursor:string|null=null;
  for(;;){
    const url=new URL('https://arena.ai/api/history/unified');url.searchParams.set('type','agentic');url.searchParams.set('limit','20');url.searchParams.set('includeArchived','false');if(cursor)url.searchParams.set('cursor',cursor);
    const response=await fetch(url,{redirect:'error',headers:{...accountHeaders(credential.cookieHeader),accept:'application/json'},signal:AbortSignal.timeout(45000)});
    if(!response.ok){await response.body?.cancel();throw Object.assign(new Error('Arena 历史协议读取失败'),{status:response.status});}
    const cookies=refreshedAccountCookies(credential.cookieHeader,response);if(cookies!==credential.cookieHeader){refresh(cookies);credential={...credential,cookieHeader:cookies};}
    const data=await response.json() as {entries?:{type:string;id:string;title:string|null;archivedAt?:string|null}[];pagination?:{hasMore:boolean;cursor:string|null};partial?:boolean};
    if(!Array.isArray(data.entries)||!data.pagination||data.partial)throw new Error('Arena 历史清单不完整');
    for(const entry of data.entries){if(entry.type!=='agentic'||entry.archivedAt||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.id))continue;const id=entry.id.toLowerCase();found.set(id,{id,title:entry.title??'',url:'https://arena.ai/agent/'+id});}
    if(!data.pagination.hasMore)return [...found.values()];cursor=data.pagination.cursor;if(!cursor||visited.has(cursor))throw new Error('Arena 历史分页未完成');visited.add(cursor);
  }
}
