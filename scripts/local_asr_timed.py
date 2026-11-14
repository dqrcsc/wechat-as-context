#!/usr/bin/env python3
"""Offline managed-local-asr adapter. Timestamps describe VAD regions, not words."""
import argparse
import contextlib
import json
import math
import os
from pathlib import Path
import re
import socket
import sys
import wave

SCHEMA = 'wxctx-vad-v1'
MODELS = {'vad': 'speech_fsmn_vad_zh-cn-16k-common-pytorch', 'asr': 'SenseVoiceSmall',
          'punc': 'punc_ct-transformer_zh-cn-common-vocab272727-pytorch'}


def intervals(value, duration_ms):
    if not isinstance(value, list) or len(value) > 2000:
        raise ValueError('invalid_vad_intervals')
    result = []
    previous = 0
    for item in value:
        if not isinstance(item, (list, tuple)) or len(item) != 2:
            raise ValueError('invalid_vad_interval')
        start, end = item
        if any(isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) or int(x) != x for x in item):
            raise ValueError('invalid_vad_timestamp')
        # VAD uses 10ms frames; only the final frame may extend past decoded samples.
        if start < previous or end <= start or end > duration_ms + 10 or start >= duration_ms:
            raise ValueError('invalid_vad_bounds')
        end = min(int(end), duration_ms)
        result.append({'startMs': int(start), 'endMs': end})
        previous = end
    return result


def transcribe_regions(regions, recognize):
    result = []
    for region in regions:
        try:
            output = recognize(region['startMs'], region['endMs'])
            if not isinstance(output, list) or len(output) != 1 or not isinstance(output[0].get('text'), str):
                raise ValueError('invalid_asr_output')
            raw = output[0]['text']
            text = re.sub(r'<\|[^|]+?\|>', '', raw).strip()
            text = re.sub(r'。{2,}', '。', text)
            result.append({**region, 'status': 'ok' if text else 'empty', 'text': text})
        except Exception:
            result.append({**region, 'status': 'failed', 'text': ''})
    return result


def payload(duration_ms, regions, recognize):
    segments = transcribe_regions(regions, recognize)
    return {'text': '\n'.join(x['text'] for x in segments if x['status'] == 'ok'),
            'segments': segments, 'timing': {'schema': SCHEMA, 'audioDurationMs': duration_ms,
            'scanComplete': True, 'vadSegments': regions, 'segments': segments}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('audio')
    parser.add_argument('--out-dir', required=True)
    parser.add_argument('--cache-dir', required=True)
    parser.add_argument('--format', default='json,txt')
    parser.add_argument('--quiet', action='store_true')
    args = parser.parse_args()
    cache = Path(args.cache_dir).resolve()
    models = {k: cache/'modelscope/models/iic'/v for k, v in MODELS.items()}
    if not all(p.is_dir() for p in models.values()):
        raise ValueError('local_models_missing')
    audio = Path(args.audio).resolve()
    with wave.open(str(audio), 'rb') as wav:
        if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getcomptype()) != (1, 2, 16000, 'NONE'):
            raise ValueError('expected_16k_mono_pcm16')
        frames = wav.getnframes()
        if frames <= 0 or frames > 16000 * 4 * 3600:
            raise ValueError('audio_duration_limit')
        pcm = wav.readframes(frames)
        if len(pcm) != frames * 2:
            raise ValueError('incomplete_pcm')
    duration_ms = math.ceil(frames * 1000 / 16000)
    # Existing local model directories only. No hidden model downloads/telemetry.
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', MODELSCOPE_CACHE=str(cache/'modelscope'))
    def no_network(*_args, **_kwargs):
        raise RuntimeError('offline_adapter_network_disabled')
    socket.socket.connect_ex = no_network
    socket.socket.connect = no_network
    socket.create_connection = no_network
    with open(os.devnull, 'w') as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        import numpy as np
        from funasr import AutoModel
        samples = np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768.0
        vad = AutoModel(model=str(models['vad']), device='cpu', disable_update=True)
        detected = vad.generate(input=samples, fs=16000)
        if not isinstance(detected, list) or len(detected) != 1:
            raise ValueError('invalid_vad_result')
        regions = intervals(detected[0].get('value'), duration_ms)
        asr = AutoModel(model=str(models['asr']), punc_model=str(models['punc']), device='cpu', disable_update=True) if regions else None
        def recognize(start, end):
            return asr.generate(input=samples[start * 16:min(end * 16, frames)], cache={}, language='auto', use_itn=True, fs=16000)
        result = payload(duration_ms, regions, recognize)
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out/(audio.stem+'.json')).write_text(json.dumps(result, ensure_ascii=False), encoding='utf8')
    (out/(audio.stem+'.txt')).write_text(result['text'], encoding='utf8')
    print(json.dumps({'ok': True, 'segmentCount': len(regions)}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('local_asr_timed_failed', file=sys.stderr)
        sys.exit(1)
