import hashlib
import json
import sys
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch, Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'services/mix/python'))
import voice


class VoiceTests(unittest.TestCase):
    def setUp(self):
        config = patch.dict('voice.os.environ', {'INDEXTTS_DOWNLOAD_HOSTS': 'example.com,302.ai,302ai.cn'})
        config.start()
        self.addCleanup(config.stop)

    def save_task(self, folder, text, state, task_id, audio=None, speaker='https://example.com/speaker.wav'):
        spec = {'text': text, 'speaker': speaker, 'emotion_hash': 'hash', 'alpha': .8}
        digest = hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest()[:24]
        record = Path(folder) / (digest + '.json')
        record.write_text(json.dumps({'task_id': task_id, 'state': state, 'spec': spec,
                                     'result': {'state': state}}), encoding='utf-8')
        if audio:
            record.with_suffix('.wav').write_bytes(audio)
        return record

    def test_failed_segment_is_resubmitted_once_and_previous_attempt_is_preserved(self):
        created = Mock(status_code=200)
        created.json.return_value = {'task_id': 'retry-task'}
        success = Mock(status_code=200)
        success.json.return_value = {'state': 'SUCCESS', 'audio_url': 'https://example.com/audio.wav'}
        with tempfile.TemporaryDirectory() as tmp, patch('voice.headers', return_value={}), \
             patch('voice.requests.post', return_value=created) as post, \
             patch('voice.requests.get', side_effect=[success, Mock(status_code=200, content=b'retried-audio')]), \
             patch('voice.media.duration', return_value=1):
            record = self.save_task(tmp, '第二段', 'FAILURE', 'failed-task')
            audio = voice.synthesize('第二段', 'https://example.com/speaker.wav',
                                    'https://example.com/emotion.wav', 'hash', .8, tmp, log=lambda _: None)
            self.assertEqual(audio.read_bytes(), b'retried-audio')
            self.assertEqual(post.call_count, 1)
            saved = json.loads(record.read_text(encoding='utf-8'))
            self.assertEqual(saved['task_id'], 'retry-task')
            self.assertEqual(saved['state'], 'SUCCESS')
            self.assertEqual(saved['attempts'][0]['task_id'], 'failed-task')

    def test_retry_failure_stops_until_next_resume(self):
        created = Mock(status_code=200)
        created.json.return_value = {'task_id': 'retry-task'}
        failed = Mock(status_code=200)
        failed.json.return_value = {'state': 'FAILURE', 'error': {'message': 'provider failure'}}
        with tempfile.TemporaryDirectory() as tmp, patch('voice.headers', return_value={}), \
             patch('voice.requests.post', return_value=created) as post, \
             patch('voice.requests.get', return_value=failed):
            self.save_task(tmp, '第二段', 'FAILURE', 'failed-task')
            with self.assertRaisesRegex(RuntimeError, 'TTS 任务失败'):
                voice.synthesize('第二段', 'https://example.com/speaker.wav',
                                 'https://example.com/emotion.wav', 'hash', .8, tmp, log=lambda _: None)
            self.assertEqual(post.call_count, 1)

    def test_existing_pending_task_is_polled_without_resubmission(self):
        success = Mock(status_code=200)
        success.json.return_value = {'state': 'SUCCESS', 'audio_url': 'https://example.com/audio.wav'}
        with tempfile.TemporaryDirectory() as tmp, patch('voice.headers', return_value={}), \
             patch('voice.requests.post') as post, \
             patch('voice.requests.get', side_effect=[success, Mock(status_code=200, content=b'existing-audio')]) as get, \
             patch('voice.media.duration', return_value=1):
            self.save_task(tmp, '第二段', 'STARTED', 'running-task')
            voice.synthesize('第二段', 'https://example.com/speaker.wav',
                             'https://example.com/emotion.wav', 'hash', .8, tmp, log=lambda _: None)
            post.assert_not_called()
            self.assertEqual(get.call_args_list[0].kwargs['params'], {'task_id': 'running-task'})

    def test_uncertain_submission_is_not_repeated_on_resume(self):
        import requests
        with tempfile.TemporaryDirectory() as tmp, patch('voice.headers', return_value={}), \
             patch('voice.requests.post', side_effect=requests.Timeout('reply lost')) as post:
            args = ('第二段', 'https://example.com/speaker.wav',
                    'https://example.com/emotion.wav', 'hash', .8, tmp)
            self.save_task(tmp, '第二段', 'FAILURE', 'failed-task')
            with self.assertRaisesRegex(RuntimeError, '提交结果不确定'):
                voice.synthesize(*args, log=lambda _: None)
            with self.assertRaisesRegex(RuntimeError, '提交结果不确定'):
                voice.synthesize(*args, log=lambda _: None)
            self.assertEqual(post.call_count, 1)

    def test_server_error_submission_is_not_repeated_but_rejection_can_retry(self):
        for status, can_retry in ((502, False), (429, True)):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as tmp, \
                 patch('voice.headers', return_value={}), \
                 patch('voice.requests.post', return_value=Mock(status_code=status, text='unavailable')) as post:
                args = ('第二段', 'https://example.com/speaker.wav',
                        'https://example.com/emotion.wav', 'hash', .8, tmp)
                with self.assertRaisesRegex(RuntimeError, f'HTTP {status}'):
                    voice.synthesize(*args, log=lambda _: None)
                with self.assertRaisesRegex(RuntimeError, f'HTTP {status}' if can_retry else '提交结果不确定'):
                    voice.synthesize(*args, log=lambda _: None)
                self.assertEqual(post.call_count, 2 if can_retry else 1)

    def test_expired_speaker_link_keeps_successful_legacy_segment_cache(self):
        with tempfile.TemporaryDirectory() as tmp, patch('voice.headers', return_value={}), \
             patch('voice.media.run'), patch('voice.media.duration', return_value=1):
            root = Path(tmp)
            speaker, emotion = root/'speaker.wav', root/'emotion.wav'
            speaker.write_bytes(b'speaker')
            emotion.write_bytes(b'emotion')
            cache = root/'voice-cache'
            cache.mkdir()
            speaker_hash = hashlib.sha256(speaker.read_bytes()).hexdigest()
            old_url = 'https://example.com/speaker.wav'
            reference = cache/f'speaker-{speaker_hash[:16]}.json'
            reference.write_text(json.dumps({'url': old_url, 'uploaded_at': 0,
                                            'source_sha256': speaker_hash}))
            (cache/f'speaker-{speaker_hash[:16]}-15s.wav').write_bytes(b'prepared speaker')
            record = self.save_task(cache, '第一段', 'SUCCESS', 'paid-task', audio=b'paid-audio')
            uploaded = Mock(status_code=200)
            uploaded.json.return_value = {'data': 'https://example.com/refreshed-speaker.wav'}
            plan = {'fps': 25, 'scenes': [{'text': '第一段', 'start': 0, 'end': 1}]}
            with patch('voice.requests.post', return_value=uploaded) as post, \
                 patch('voice.requests.get') as get, \
                 patch('voice.upload_emotion', return_value=('https://example.com/emotion.wav', 'hash')):
                voice.synthesize_plan(plan, root, speaker_file=speaker, emotion_file=emotion, log=lambda _: None)
            self.assertEqual(post.call_count, 1)
            self.assertIn('files', post.call_args.kwargs)
            get.assert_not_called()
            self.assertEqual(record.with_suffix('.wav').read_bytes(), b'paid-audio')
            self.assertEqual(plan['voice_settings']['speaker_url'], 'https://example.com/refreshed-speaker.wav')

    def test_emotion_default_and_boundaries(self):
        self.assertEqual(voice.validate_emotion(), .8)
        for value in (.1, .15, .8, .85):
            self.assertEqual(voice.validate_emotion(value), value)

    def test_server_rejects_out_of_range_nonfinite_and_wrong_step(self):
        for value in (0, .09, .86, 1, .82, float('nan'), float('inf'), True, None, 'oops'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                voice.validate_emotion(value)

    def test_invalid_emotion_cannot_trigger_network(self):
        with patch('voice.requests.post') as post:
            with self.assertRaises(ValueError):
                voice.synthesize_plan({'scenes': []}, 'unused', emotion_alpha=.9)
            post.assert_not_called()

    def test_main_voice_and_emotion_use_separate_references(self):
        with tempfile.TemporaryDirectory() as tmp:
            speaker=Path(tmp)/'user-voice.mp3'
            emotion=Path(tmp)/'emotion.wav'
            plan={'fps':25,'scenes':[{'text':'测试文案','start':0,'end':1}]}
            def upload(path,folder,kind):
                return f'https://example.com/{kind}.wav',f'{kind}-hash'
            with patch('voice.upload_reference',side_effect=upload) as uploads, \
                 patch('voice.synthesize',return_value=Path(tmp)/'tts.wav') as synth, \
                 patch('voice.media.duration',return_value=1),patch('voice.media.run'):
                voice.synthesize_plan(plan,tmp,emotion_file=emotion,speaker_file=speaker,log=lambda m:None)
            self.assertEqual(synth.call_args.args[1:3],('https://example.com/speaker.wav','https://example.com/emotion.wav'))
            self.assertEqual(plan['voice_settings']['speaker_source'],str(speaker))
            self.assertEqual(plan['voice_settings']['speaker_sha256'],'speaker-hash')
            self.assertEqual(plan['voice_settings']['emotion_sha256'],'emotion-hash')

    def test_polling_server_error_retries_same_task_without_resubmitting(self):
        created=Mock(status_code=200)
        created.json.return_value={'task_id':'existing-job'}
        busy=Mock(status_code=500)
        success=Mock(status_code=200)
        success.json.return_value={'state':'SUCCESS','audio_url':'https://example.com/audio.wav'}
        download=Mock(status_code=200,content=b'test-audio')
        with tempfile.TemporaryDirectory() as tmp, \
             patch('voice.headers',return_value={}), \
             patch('voice.requests.post',return_value=created) as post, \
             patch('voice.requests.get',side_effect=[busy,success,download]) as get, \
             patch('voice.time.sleep'), patch('voice.media.duration',return_value=1):
            path=voice.synthesize('测试','https://example.com/speaker.wav',
                                  'https://example.com/emotion.wav','hash',.8,tmp,log=lambda m:None)
            self.assertEqual(path.read_bytes(),b'test-audio')
            self.assertEqual(post.call_count,1)
            self.assertEqual(get.call_args_list[0].kwargs['params'],{'task_id':'existing-job'})
            self.assertEqual(get.call_args_list[1].kwargs['params'],{'task_id':'existing-job'})

    def test_domestic_download_recovers_existing_paid_task(self):
        import requests
        created=Mock(status_code=200)
        created.json.return_value={'task_id':'already-paid'}
        success=Mock(status_code=200)
        success.json.return_value={'state':'SUCCESS','audio_url':'https://file.302.ai/gpt/audio/a.wav?x=1'}
        downloaded=Mock(status_code=200,content=b'recovered-audio')
        with tempfile.TemporaryDirectory() as tmp, \
             patch('voice.headers',return_value={}), \
             patch('voice.requests.post',return_value=created) as post, \
             patch('voice.time.sleep'), patch('voice.media.duration',return_value=1):
            args=('测试','https://example.com/speaker.wav','https://example.com/emotion.wav','hash',.8,tmp)
            with patch('voice.requests.get',side_effect=[success]+[requests.ConnectionError('offline')]*4):
                with self.assertRaisesRegex(RuntimeError,'已合成但下载'):
                    voice.synthesize(*args,log=lambda m:None)
            with patch('voice.TTS_BASE_URL','https://api.302ai.cn'), \
                 patch('voice.requests.get',side_effect=[success,downloaded]) as get:
                result=voice.synthesize(*args,log=lambda m:None)
                self.assertEqual(result.read_bytes(),b'recovered-audio')
                self.assertEqual(get.call_args_list[0].kwargs['params'],{'task_id':'already-paid'})
                self.assertEqual(get.call_args_list[1].args[0],'https://file.302ai.cn/gpt/audio/a.wav?x=1')
                self.assertNotIn('headers',get.call_args_list[1].kwargs)
            self.assertEqual(post.call_count,1)


if __name__ == '__main__':
    unittest.main()
