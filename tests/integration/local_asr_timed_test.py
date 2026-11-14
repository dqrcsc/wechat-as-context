"""No models, application data or network required."""
import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[2]/'scripts/local_asr_timed.py'
spec = importlib.util.spec_from_file_location('timed', path)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class TimingTests(unittest.TestCase):
    def test_silence_is_not_a_missing_speech_interval(self):
        r = m.payload(10000, m.intervals([[1000,2000],[8000,9000]],10000),lambda a,b:[{'text': f'原词{a}'}])
        self.assertEqual(r['timing']['vadSegments'],[{'startMs':1000,'endMs':2000},{'startMs':8000,'endMs':9000}])
        self.assertEqual(r['text'],'原词1000\n原词8000')

    def test_failed_and_empty_segments_keep_their_positions(self):
        def recognize(a,b):
            if a==1000:raise RuntimeError('private error')
            return [{'text': '' if a==2000 else '原词 Zorpex'}]
        r=m.payload(3000,m.intervals([[0,1000],[1000,2000],[2000,3000]],3000),recognize)
        self.assertEqual([s['status'] for s in r['segments']],['ok','failed','empty'])
        self.assertNotIn('private error',str(r))
        self.assertEqual(r['text'],'原词 Zorpex')

    def test_invalid_vad_must_not_silently_drop_regions(self):
        for v in [None,[[1,0]],[[-1,5]],[[0,100],[50,150]],[[0,1011]],[[0,float('nan')]],[[False,5]],[[0,1.5]],[[1000,1001]]]:
            with self.subTest(v=v), self.assertRaises(ValueError):m.intervals(v,1000)
        self.assertEqual(m.intervals([[0,1010]],1000),[{'startMs':0,'endMs':1000}])

    def test_empty_scan_has_no_invented_text(self):
        r=m.payload(1000,[],lambda a,b:self.fail('no speech'))
        self.assertEqual(r['text'],'');self.assertEqual(r['segments'],[])

    def test_tags_only_are_not_usable_transcription(self):
        r=m.payload(1000,m.intervals([[0,1000]],1000),lambda a,b:[{'text':'<|zh|><|Speech|>'}])
        self.assertEqual(r['segments'][0]['status'],'empty')

if __name__=='__main__':unittest.main()
