import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'services/mix/python'))
import fal_voice
from app import normalize, provider_pending, readiness
from api import clean_error
from credits import CreditError


class FalVoiceTests(unittest.TestCase):
    def test_default_voice_is_available_with_only_fal_key_and_secret_is_redacted(self):
        with patch.dict(os.environ, {'MIX_FAL_KEY': 'private-fal-key', 'OPENLUX_API_KEY': 'private-openlux', 'RERANK_API_KEY': 'private-rerank'}, clear=True), \
                patch('app.shutil.which', return_value='/tool'):
            self.assertTrue(readiness()['default_voice_configured'])
            spec = normalize({'text': '欢迎。', 'source': 'cloud'}, 'a' * 64)
            self.assertEqual(spec['voice_config'], {'provider': 'fal', 'voice': 'Vivian'})
            self.assertEqual(clean_error('failed private-fal-key'), 'failed [REDACTED]')
            self.assertNotIn('private-fal-key', json.dumps(spec))

    def test_metered_queue_and_download_resume_without_new_paid_submission(self):
        pending = {'request_id': '12345678-1234-4567-abcd-123456789abc', 'status': 'IN_PROGRESS'}
        done = {**pending, 'status': 'COMPLETED', 'result': {'audio': {'url': 'https://v3b.fal.media/audio.mp3'}}, 'result_status': 200}
        def download(url, path):
            path.write_bytes(b'completed-audio')
        with tempfile.TemporaryDirectory() as tmp, patch('fal_voice.metering_enabled', return_value=True), \
                patch('fal_voice.paid_post', side_effect=[pending, done]) as paid, \
                patch('fal_voice.download', side_effect=RuntimeError('download offline')), patch('fal_voice.time.sleep'):
            cache = Path(tmp) / 'voice-cache'
            cache.mkdir()
            with self.assertRaisesRegex(RuntimeError, 'download offline'):
                fal_voice.queued(fal_voice.TTS_MODEL, {'text': '全文。'}, cache, 'same-scene', '.wav', lambda _: None)
            self.assertTrue(provider_pending(tmp))
            with patch('fal_voice.download', side_effect=download), patch('fal_voice.media.duration', return_value=2):
                first = fal_voice.queued(fal_voice.TTS_MODEL, {'text': '全文。'}, cache, 'same-scene', '.wav', lambda _: None)
                second = fal_voice.queued(fal_voice.TTS_MODEL, {'text': '全文。'}, cache, 'same-scene', '.wav', lambda _: None)
            self.assertEqual(first, second)
            self.assertEqual(paid.call_count, 2, 'progress reads use the same bridge receipt; downloaded audio needs no calls')
            self.assertEqual(paid.call_args_list[0].kwargs, paid.call_args_list[1].kwargs)
            self.assertFalse(provider_pending(tmp))

    def test_confirmed_failed_task_gets_new_attempt_but_unknown_cost_keeps_original_identity(self):
        failed = {'request_id': '12345678-1234-4567-abcd-123456789abc', 'status': 'COMPLETED', 'result': {}, 'result_status': 422}
        with tempfile.TemporaryDirectory() as tmp, patch('fal_voice.metering_enabled', return_value=True), \
                patch('fal_voice.paid_post', side_effect=[failed, CreditError('费用待确认', uncertain=True), CreditError('费用待确认', uncertain=True)]) as paid:
            for _ in range(3):
                with self.assertRaises((RuntimeError, CreditError)):
                    fal_voice.queued(fal_voice.TTS_MODEL, {'text': '全文。'}, Path(tmp), 'same-scene', '.wav', lambda _: None)
            keys = [call.kwargs['call_key'] for call in paid.call_args_list]
            self.assertNotEqual(keys[0], keys[1])
            self.assertEqual(keys[1], keys[2])

    def test_legacy_lost_reply_does_not_repost(self):
        with tempfile.TemporaryDirectory() as tmp, patch('fal_voice.metering_enabled', return_value=False), \
                patch('fal_voice.paid_post', return_value=None), patch('fal_voice.headers', return_value={}), \
                patch('fal_voice.requests.post', side_effect=fal_voice.requests.Timeout('lost reply')) as post:
            for _ in range(2):
                with self.assertRaises(RuntimeError):
                    fal_voice.queued(fal_voice.TTS_MODEL, {'text': '全文。'}, Path(tmp), 'same-scene', '.wav', lambda _: None)
            self.assertEqual(post.call_count, 1)

    def test_file_download_rejects_internal_urls_before_network_access(self):
        with patch('fal_voice.requests.get') as get:
            for url in ('https://127.0.0.1/a', 'https://fal.media.evil.example/a', 'https://user:pass@v3.fal.media/a'):
                with self.assertRaises(ValueError):
                    fal_voice.download(url, Path('unused.wav'))
        get.assert_not_called()


if __name__ == '__main__':
    unittest.main()
