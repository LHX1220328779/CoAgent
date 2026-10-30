import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.ts';
export function authorized(request:IncomingMessage,key:string) { const expected=Buffer.from(`Bearer ${key}`),actual=Buffer.from(request.headers.authorization ?? ''); return actual.length===expected.length && timingSafeEqual(expected,actual); }
export async function readJSON(request:IncomingMessage):Promise<unknown> {
  let bytes=0;const chunks:Buffer[]=[];
  for await(const chunk of request){bytes+=chunk.length;if(bytes>2*1024*1024)throw new AppError('Request body too large',413);chunks.push(Buffer.from(chunk));}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new AppError('Invalid JSON');}
}
export function json(response:ServerResponse,status:number,body:unknown){response.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});response.end(JSON.stringify(body));}
export function streamHeaders(response:ServerResponse){response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','x-accel-buffering':'no'});}
export async function write(response:ServerResponse,data:string,signal:AbortSignal){
  signal.throwIfAborted();if(response.destroyed)throw new Error('Client disconnected');
  if(response.write(data))return;
  await new Promise<void>((resolve,reject)=>{const clean=()=>{response.off('drain',drain);response.off('close',close);signal.removeEventListener('abort',abort);};const drain=()=>{clean();resolve();};const close=()=>{clean();reject(new Error('Client disconnected'));};const abort=()=>{clean();reject(signal.reason);};response.once('drain',drain);response.once('close',close);signal.addEventListener('abort',abort,{once:true});});
}
