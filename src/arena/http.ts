const authCookie=/^arena-auth-prod-v1(?:\.\d+)?$/;
export function accountHeaders(cookieHeader:string){return {cookie:cookieHeader.split(';').map(value=>value.trim()).filter(value=>authCookie.test(value.split('=')[0])).join('; '),'user-agent':'CoAgent/0.1'};}
/** Persist only account cookies refreshed by the authenticated service itself. */
export function refreshedAccountCookies(cookieHeader:string,response:Response){
  const updates=response.headers.getSetCookie().filter(value=>authCookie.test(value.slice(0,value.indexOf('='))));if(!updates.length)return cookieHeader;
  const cookies=new Map(cookieHeader.split(';').map(value=>value.trim()).filter(Boolean).map(value=>{const index=value.indexOf('=');return [value.slice(0,index),value.slice(index+1)] as const;}));
  for(const update of updates){const pair=update.split(';')[0],index=pair.indexOf('='),name=pair.slice(0,index),value=pair.slice(index+1);if(!value||/;\s*max-age=0(?:;|$)/i.test(update))cookies.delete(name);else cookies.set(name,value);}
  return [...cookies].map(([name,value])=>name+'='+value).join('; ');
}
