import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Only the conventional managed install is adapted; explicit/custom CLIs stay authoritative. */
export function localAsrCommand(binary: string, audio: string, out: string,
  home = homedir(), override = process.env.LOCAL_ASR_BIN,
  script = resolve(import.meta.dir, '../../scripts/local_asr_timed.py')): {command: string; args: string[]; timed: boolean} {
  const args = [audio, '--out-dir', out, '--format', 'json,txt', '--quiet'];
  const managed = join(home, '.local/share/local-asr');
  const python = join(managed, 'venv/bin/python');
  const cache = join(managed, 'model-cache');
  if (!override?.trim() && resolve(binary) === join(home, '.local/bin/local-asr') && audio.endsWith('.wav')) {
    try {
      if (!statSync(python).isFile() || !statSync(script).isFile()) throw Error('missing');
      accessSync(python, constants.X_OK);
      for (const model of ['SenseVoiceSmall','speech_fsmn_vad_zh-cn-16k-common-pytorch','punc_ct-transformer_zh-cn-common-vocab272727-pytorch']) {
        if (!statSync(join(cache,'modelscope/models/iic',model)).isDirectory()) throw Error('missing');
      }
      return {command: python,args:[script,...args,'--cache-dir',cache],timed:true};
    } catch { /* Legacy local-asr still works without verified time coverage. */ }
  }
  return {command:binary,args,timed:false};
}
