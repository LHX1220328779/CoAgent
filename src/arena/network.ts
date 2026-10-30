// Chromium needs an explicit proxy; shell HTTP(S)_PROXY alone does not configure it.
export function browserHeadless(env:NodeJS.ProcessEnv=process.env){
  if(env.ARENA_HEADED==='1')return false;
  if(env.ARENA_HEADED==='0')return true;
  return !(env.DISPLAY||env.WAYLAND_DISPLAY);
}
export function browserNetwork(env:NodeJS.ProcessEnv=process.env){
  const keys=['ARENA_AGENT_PROXY','https_proxy','HTTPS_PROXY','all_proxy','ALL_PROXY','http_proxy','HTTP_PROXY'];
  const source=keys.find(key=>typeof env[key]==='string'&&env[key].trim());
  const value=source?(env[source]??'').trim():'';
  if(!value||value==='none')return {source:source??null,proxy:undefined};
  let url;try{url=new URL(value);}catch{throw new Error('Arena 浏览器代理配置无效，请填写完整代理地址');}
  if(!['http:','https:','socks5:','socks4:'].includes(url.protocol)||!url.hostname)throw new Error('Arena 浏览器代理协议无效');
  const proxy:{server:string;username?:string;password?:string}={server:`${url.protocol}//${url.host}`};
  if(url.username)proxy.username=decodeURIComponent(url.username);
  if(url.password)proxy.password=decodeURIComponent(url.password);
  return {source,proxy};
}
