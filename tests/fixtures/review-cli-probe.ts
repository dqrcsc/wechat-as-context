import "../support/isolation.ts";
import {mock,spyOn} from 'bun:test';
import * as os from 'node:os';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const root=mkdtempSync(join(os.tmpdir(),'wx-review-cli-')),home=join(root,'home');mkdirSync(home);
mock.module('node:os',()=>({...os,homedir:()=>home}));
const {runCliSubagent}=await import('../../src/agent/subagent_cli.ts');
const [backend,mode]=process.argv[2].split(':'),bin=join(root,'fake-cli');writeFileSync(bin,'mock');process.env[backend.toUpperCase()+'_BIN']=bin;
let calls=0;const stream=(s:string)=>new Response(s).body;
spyOn(Bun,'spawn').mockImplementation((()=>{
 calls++;
 const first=calls===1, timeout=first&&mode==='timeout', fail=first&&mode!=='success';
 const artifact=join(root,'artifact.md');writeFileSync(artifact,'# Partial artifact');
 let resolveExit:(n:number)=>void=()=>{};
 return {stdout:stream(first?`Starting task... ${artifact}`:'Success'),stderr:stream(fail?'fatal: synthetic failure':''),exited:timeout?new Promise<number>(resolve=>{resolveExit=resolve}):Promise.resolve(fail?1:0),kill(){resolveExit(0);}};
}) as any);
const config:any={projectRoot:root,dataDir:root,vaultRoot:root,llm:{allowCodexFallback:true,cliRoutingChain:[backend,'success'],customCliAgents:[{id:'custom',binaryPath:bin,argsTemplate:'{{PROMPT}}'},{id:'success',binaryPath:bin,argsTemplate:'{{PROMPT}}'}]}};
try {const result=await runCliSubagent({config,backend,prompt:'fixture',timeoutMs:20});console.log(JSON.stringify({ok:true,result,calls}));}catch(e:any){console.log(JSON.stringify({ok:false,error:e.message,calls}));}
