import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'services/mix/python'))
import api
import voice
from app import generate, readiness


class ConfigTests(unittest.TestCase):
    def test_blank_endpoint_overrides_use_provider_defaults(self):
        with patch.dict(os.environ, {'EMBEDDING_URL': '', 'LLM_URL': '', 'RERANK_URL': ''}):
            models = api.Models()
        self.assertEqual((models.embed_url, models.llm_url, models.rerank_url),
                         (api.EMBED_URL, api.LLM_URL, api.RERANK_URL))

    def test_provider_errors_redact_index_tts_credential_alias(self):
        with patch.dict(os.environ, {'INDEXTTS_302_API_KEY': 'test-index-tts-private-key'}):
            self.assertEqual(api.clean_error('provider failed: test-index-tts-private-key'),
                             'provider failed: [REDACTED]')

    def test_errors_redact_separate_audio_cos_credentials(self):
        with patch.dict(os.environ, {'MIX_AUDIO_COS_SECRET_ID': 'audio-secret-id',
                                    'MIX_AUDIO_COS_SECRET_KEY': 'audio-secret-key'}):
            self.assertEqual(api.clean_error('failed: audio-secret-id audio-secret-key'),
                             'failed: [REDACTED] [REDACTED]')

    def test_indexing_does_not_require_rerank_or_tts_configuration(self):
        with patch.dict(os.environ, {'OPENLUX_API_KEY': 'test'}, clear=True), patch('app.shutil.which', return_value='/bin/tool'):
            health = readiness()
        self.assertTrue(health['indexing_configured'])
        self.assertFalse(health['configured'])
        self.assertEqual(health['missing'], ['RERANK_API_KEY'])
        self.assertEqual(health['voice_missing'], ['INDEXTTS_302_API_KEY'])
        self.assertFalse(health['voice_configured'])
        self.assertFalse(health['default_voice_configured'])

    def test_generic_tts_uses_configured_speaker_and_no_private_reference_files(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {
                'INDEXTTS_SPEAKER_AUDIO_URL': 'https://example.com/generic.wav',
                'INDEXTTS_EMOTION_AUDIO_URL': '', 'INDEXTTS_EMOTION_AUDIO_PATH': ''}), \
                patch('voice.synthesize', return_value=Path(folder) / 'audio.wav') as synthesize, \
                patch('voice.media.duration', return_value=1), patch('voice.media.run'), patch('voice.upload_reference') as upload:
            plan = {'fps': 25, 'scenes': [{'text': '完整文案。'}]}
            voice.synthesize_plan(plan, folder, log=lambda _: None)
        upload.assert_not_called()
        self.assertEqual(synthesize.call_args.args[1:4],
                         ('https://example.com/generic.wav', None, 'general-emotion-vector-v1'))
        self.assertIsNone(plan['voice_settings']['speaker_source'])

    def test_unknown_audio_host_cannot_be_downloaded(self):
        created = Mock(status_code=200)
        created.json.return_value = {'task_id': 'already-paid'}
        done = Mock(status_code=200)
        done.json.return_value = {'state': 'SUCCESS', 'audio_url': 'https://127.0.0.1/private.wav'}
        with tempfile.TemporaryDirectory() as folder, patch('voice.headers', return_value={}), \
                patch('voice.requests.post', return_value=created), patch('voice.requests.get', return_value=done) as get, \
                patch.dict(os.environ, {'INDEXTTS_DOWNLOAD_HOSTS': '302.ai'}):
            with self.assertRaisesRegex(ValueError, 'INDEXTTS_DOWNLOAD_HOSTS'):
                voice.synthesize('完整文案。', 'https://example.com/speaker.wav', None,
                                 'generic', .8, folder, log=lambda _: None)
        self.assertEqual(get.call_count, 1, 'Only provider task polling is allowed; no internal audio URL download')

    def test_unconfigured_generation_stops_before_paid_model_work(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {}, clear=True), \
                patch('app.shutil.which', return_value='/bin/tool'), patch('matcher.create_plan') as planner:
            with self.assertRaisesRegex(ValueError, 'OPENLUX_API_KEY'):
                generate({}, Path(folder), lambda _: None)
        planner.assert_not_called()

    def test_explicit_job_voice_config_does_not_change_when_server_defaults_change(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {
                'INDEXTTS_EMOTION_AUDIO_URL': 'https://example.com/new-default.wav',
                'INDEXTTS_EMOTION_AUDIO_PATH': '/new/reference.wav'}), \
                patch('voice.synthesize', return_value=Path(folder) / 'audio.wav') as synthesize, \
                patch('voice.media.duration', return_value=1), patch('voice.media.run'), patch('voice.upload_reference') as upload:
            plan = {'fps': 25, 'scenes': [{'text': '完整文案。'}]}
            voice.synthesize_plan(plan, folder, speaker_url='https://example.com/job-speaker.wav',
                                  emotion_url=None, emotion_file=None, log=lambda _: None)
        upload.assert_not_called()
        self.assertIsNone(synthesize.call_args.args[2])


if __name__ == '__main__':
    unittest.main()
