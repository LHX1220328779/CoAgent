import {join} from 'node:path';
import {RpcPeer} from './rpc.ts';
import {ConsoleBackend} from './backend.ts';
import {AcpSessions} from './sessions.ts';
import {CoAgentAcp} from './agent.ts';
export function runAcp(root:string,env:NodeJS.ProcessEnv){
  const peer=new RpcPeer(process.stdout),agent=new CoAgentAcp(peer,new ConsoleBackend(root,env),new AcpSessions(join(root,'.coagent/acp')));
  const connection=peer.listen(process.stdin,(method,params)=>agent.handle(method,params),()=>agent.close());
  process.once('SIGTERM',()=>void connection.stop().then(()=>connection.lines.close()));process.once('SIGINT',()=>void connection.stop().then(()=>connection.lines.close()));
}
