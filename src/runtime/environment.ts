import { mkdir, copyFile, symlink } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
/** Isolate CoAgent from the user's OpenCode config and preinstall the pinned hook dependency. */
export async function runtimeEnvironment(stateDirectory:string, config:string, base:NodeJS.ProcessEnv=process.env):Promise<NodeJS.ProcessEnv>{
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');const state=resolve(stateDirectory);const configHome=join(state,'config');const packageDir=join(configHome,'opencode');
  await mkdir(packageDir,{recursive:true,mode:0o700});
  await copyFile(join(root,'package.json'),join(packageDir,'package.json'));await copyFile(join(root,'package-lock.json'),join(packageDir,'package-lock.json'));
  try{await symlink(join(root,'node_modules'),join(packageDir,'node_modules'),'junction');}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  const noProxy=[base.NO_PROXY ?? base.no_proxy ?? '', '127.0.0.1','localhost','::1'].filter(Boolean).join(',');
  return {...base,OPENCODE_CONFIG:resolve(config),OPENCODE_DISABLE_DEFAULT_PLUGINS:'true',OPENCODE_DISABLE_AUTOUPDATE:'true',XDG_CONFIG_HOME:configHome,XDG_DATA_HOME:join(state,'data'),XDG_CACHE_HOME:join(state,'cache'),XDG_STATE_HOME:join(state,'state'),NO_PROXY:noProxy,no_proxy:noProxy};
}
