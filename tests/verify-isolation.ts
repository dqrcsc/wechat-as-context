// Outer-process audit: all configuration and database sentinels below are synthetic.
import {createTestWorkspace} from './support/workspace.ts';
import {Database} from 'bun:sqlite';
import {join,resolve} from 'node:path';
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
const source=resolve(import.meta.dir,'..');
const stage=createTestWorkspace(source), sentinel=join(stage.root,'sentinel.db');
const db=new Database(sentinel);
db.exec("CREATE TABLE reply_outbox(id TEXT,status TEXT,attempts INTEGER); INSERT INTO reply_outbox VALUES ('failed1','failed',3),('failed2','failed',3),('failed3','failed',3)");db.close();
const projectEnv=join(stage.project,'.env'),homeEnv=join(stage.env.HOME,'.env');
writeFileSync(projectEnv,`WECHAT_CONTEXT_DATA_DIR=${stage.root}\nOPENAI_API_KEY=project-sentinel-key\n`);
writeFileSync(homeEnv,`WECHAT_CONTEXT_DATA_DIR=${stage.root}\nOPENAI_API_KEY=home-sentinel-key\n`);
const files=[sentinel,sentinel+'-wal',sentinel+'-shm',projectEnv,homeEnv];
const snapshot=()=>files.map(p=>existsSync(p)?readFileSync(p).toString('base64'):null);
const before=snapshot();
const result=Bun.spawnSync([process.execPath,'--no-env-file',join(stage.project,'tests/run.ts'),'tests/isolation.test.ts'],{
 cwd:stage.project,env:{HOME:stage.env.HOME,PATH:'/usr/bin:/bin',WECHAT_CONTEXT_DATA_DIR:stage.root,OPENAI_API_KEY:'inherited-key-canary',HTTPS_PROXY:'http://127.0.0.1:1'},stdout:'pipe',stderr:'pipe'});
console.log(result.stderr.toString());
if(result.exitCode!==0 || JSON.stringify(snapshot())!==JSON.stringify(before)) throw new Error('Isolation regression');
console.log(JSON.stringify({exit:result.exitCode,sentinelAndSidecarsUnchanged:true,projectAndHomeEnvUnchanged:true}));
const direct=Bun.spawnSync([process.execPath,'--no-env-file','test','tests/isolation.test.ts'],{cwd:stage.project,env:{HOME:stage.env.HOME,PATH:'/usr/bin:/bin'}});
if(direct.exitCode===0 || !direct.stderr.toString().includes('Test isolation is required')) throw new Error('Direct test was not rejected');
if(JSON.stringify(snapshot())!==JSON.stringify(before)) throw new Error('Direct test mutated sentinel');
console.log(JSON.stringify({directTestRejected:true,sentinelUnchanged:true}));
// ATTACH must not bypass the constructor's path check, even against a valid database.
const attached=Bun.spawnSync([process.execPath,'--no-env-file','--preload',join(stage.project,'tests/support/isolation.ts'),'-e',
  `import {Database} from 'bun:sqlite'; const db=new Database(':memory:'); db.exec(${JSON.stringify("ATTACH DATABASE '"+sentinel+"' AS outside")});`],{cwd:stage.project,env:stage.env});
if(attached.exitCode===0 || !attached.stderr.toString().includes('SQL file access blocked')) throw new Error('ATTACH not rejected');
if(JSON.stringify(snapshot())!==JSON.stringify(before)) throw new Error('ATTACH modified sentinel');
console.log(JSON.stringify({attachRejected:true,sentinelUnchanged:true}));
