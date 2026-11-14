import './support/isolation.ts';
import {expect,test} from 'bun:test';
import {mkdirSync,mkdtempSync,writeFileSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {localAsrCommand} from '../src/extractor/asr_local_command.ts';
test('only a complete managed default installation uses the bundled offline adapter',()=>{
 const home=mkdtempSync(join(tmpdir(),'timed-command-')), managed=join(home,'.local/share/local-asr');
 const python=join(managed,'venv/bin/python'),script=join(home,'adapter.py'),binary=join(home,'.local/bin/local-asr');
 mkdirSync(join(managed,'venv/bin'),{recursive:true});writeFileSync(python,'fixture');chmodSync(python,0o700);writeFileSync(script,'fixture');
 const invoke=(override='',audio='audio.wav',bin=binary)=>localAsrCommand(bin,audio,'out',home,override,script);
 expect(invoke().timed).toBe(false);
 for(const model of ['SenseVoiceSmall','speech_fsmn_vad_zh-cn-16k-common-pytorch','punc_ct-transformer_zh-cn-common-vocab272727-pytorch'])mkdirSync(join(managed,'model-cache/modelscope/models/iic',model),{recursive:true});
 const r=invoke();expect(r.timed).toBe(true);expect(r.command).toBe(python);expect(r.args).toEqual([script,'audio.wav','--out-dir','out','--format','json,txt','--quiet','--cache-dir',join(managed,'model-cache')]);
 expect(invoke(binary).timed).toBe(false);expect(invoke('','audio.mp3').timed).toBe(false);expect(invoke('','audio.wav','/custom/local-asr').timed).toBe(false);
 chmodSync(python,0o600);expect(invoke().timed).toBe(false);
});
