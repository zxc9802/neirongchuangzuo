"""Audio choices use owned IDs; real FFmpeg verifies selected original sound."""
import hashlib
import inspect
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'services/mix/python'))
import app as service
import captions
import finish
import media
import music
import quality
import voice
from audio_library import AudioLibrary, COS_ENV
from matcher import file_stamp, write_json


class MemoryCOS:
    def __init__(self):
        self.objects = {}
        self.signatures = []

    def put_object(self, **args):
        self.objects[args['Key']] = args['Body'].read()

    def delete_object(self, **args):
        del self.objects[args['Key']]

    def download_file(self, **args):
        Path(args['DestFilePath']).write_bytes(self.objects[args['Key']])

    def get_presigned_url(self, **args):
        self.signatures.append(args)
        return 'https://audio.example.com/reference.wav?signature=' + str(len(self.signatures))


def tone(path, frequency, seconds):
    media.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i',
               f'sine=frequency={frequency}:sample_rate=48000', '-t', str(seconds),
               '-c:a', 'pcm_s16le', str(path)])


def audio_samples(path):
    raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(path), '-map', '0:a:0',
                                   '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'])
    return np.frombuffer(raw, dtype=np.float32)


def amplitude(samples, frequency, start, length=.2):
    chunk = samples[round(start * 48000):round((start + length) * 48000)]
    return abs(np.mean(chunk * np.exp(-2j * np.pi * frequency * np.arange(len(chunk)) / 48000))) * 2


class AudioContractTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.owner = 'a' * 64
        self.cos = MemoryCOS()
        self.library = AudioLibrary(self.root / 'server', self.cos, {key: 'test' for key in COS_ENV})
        self.assertIn('audio_library', inspect.signature(service.create_app).parameters,
                      'the service must bind an injectable owned audio library')
        self.app = service.create_app(self.root / 'server', 'x' * 40, start_worker=False,
                                      audio_library=self.library)
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)
        self.headers = {'Authorization': 'Bearer ' + 'x' * 40, 'X-Material-Owner': self.owner,
                        'Idempotency-Key': 'audio-job'}
        self.device = self.client.post('/v1/browser-materials/connect', headers=self.headers,
            json={'folder_key': 'd' * 64, 'name': '素材'}).json()['device_id']
        self.body = {'text': '散步。', 'device_id': self.device, 'voice_mode': 'original',
                     'voice_id': None, 'music_id': None, 'music': False}

    def upload(self, kind, owner=None):
        source = self.root / (kind + '.wav')
        tone(source, 440 if kind == 'voice' else 220, 1)
        return self.library.upload(owner or self.owner, kind, source.name, source)['id']

    def submit(self, **changes):
        return self.client.post('/v1/mix/jobs', headers=self.headers, json={**self.body, **changes})

    def test_health_separates_base_voice_and_independent_audio_configuration(self):
        with patch.dict(os.environ, {'OPENLUX_API_KEY': 'test', 'RERANK_API_KEY': 'test'}, clear=True), \
                patch('app.shutil.which', return_value='/tool'):
            health = self.client.get('/health', headers=self.headers).json()
        self.assertTrue(health['configured'])
        self.assertEqual(health['missing'], [])
        self.assertFalse(health['voice_configured'])
        self.assertEqual(health['voice_missing'], ['INDEXTTS_302_API_KEY'])
        self.assertFalse(health['default_voice_configured'])
        self.assertEqual(health['audio_library'], {'configured': True, 'missing': []})

    def test_valid_audio_ids_persist_snapshots_without_signed_urls_and_submission_holds_lock(self):
        selected_voice, selected_music = self.upload('voice'), self.upload('music')
        original_submit = self.app.state.jobs.submit
        observed = []

        def submit(key, spec):
            observed.append(self.library.lock._is_owned())
            return original_submit(key, spec)

        with patch.object(self.app.state.jobs, 'submit', side_effect=submit):
            response = self.submit(voice_mode='synthesized', voice_id=selected_voice,
                                   music_id=selected_music, music=True)
        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(observed, [True])
        with self.app.state.jobs.connect() as db:
            spec = json.loads(db.execute('SELECT spec FROM jobs').fetchone()[0])
        self.assertEqual(spec['voice_sha256'], self.library.get(self.owner, selected_voice)['sha256'])
        self.assertEqual((spec['voice_id'], spec['music_id'], spec['music']),
                         (selected_voice, selected_music, True))
        self.assertNotIn('signature=', json.dumps(spec))
        self.assertEqual(self.cos.signatures, [])

    def test_selected_voice_idempotency_does_not_depend_on_global_default_speaker(self):
        selected = self.upload('voice')
        first = self.submit(voice_mode='synthesized', voice_id=selected)
        self.assertEqual(first.status_code, 202, first.text)
        with patch.dict(os.environ, {'INDEXTTS_SPEAKER_AUDIO_URL': 'https://example.com/new-default.wav'}):
            second = self.submit(voice_mode='synthesized', voice_id=selected)
        self.assertEqual(second.status_code, 202, second.text)
        self.assertEqual(first.json()['id'], second.json()['id'])

    def test_legacy_default_job_retry_reuses_id_after_audio_fields_upgrade(self):
        body = {'text': '散步。', 'device_id': self.device, 'music': False}
        legacy = service.normalize(body, self.owner)
        for field in ('voice_mode', 'voice_id', 'music_id'):
            del legacy[field]
        ident = self.app.state.jobs.submit('legacy-job', legacy)
        self.assertEqual(self.app.state.jobs.submit('legacy-job', legacy), ident,
                         'an identical saved legacy spec remains idempotent')
        headers = {**self.headers, 'Idempotency-Key': 'legacy-job'}
        response = self.client.post('/v1/mix/jobs', headers=headers, json=body)
        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(response.json()['id'], ident)
        selected_voice, selected_music = self.upload('voice'), self.upload('music')
        for changes in ({'text': '换文案。'}, {'voice_mode': 'original'},
                        {'voice_id': selected_voice}, {'music_id': selected_music, 'music': True}):
            with self.subTest(changes=changes):
                changed = self.client.post('/v1/mix/jobs', headers=headers, json={**body, **changes})
                self.assertEqual(changed.status_code, 409, changed.text)
        self.assertEqual(len(self.app.state.jobs.list(self.owner)), 1)

    def test_rejects_contradictions_types_external_urls_foreign_and_wrong_kind_before_queue(self):
        selected_voice, selected_music = self.upload('voice'), self.upload('music')
        foreign = self.upload('voice', 'b' * 64)
        for changes, status in [({'voice_mode': 'bad'}, 400), ({'voice_mode': True}, 400),
            ({'voice_id': selected_voice}, 400), ({'music_id': selected_music}, 400),
            ({'music': True}, 400), ({'music': 'false'}, 400), ({'voice_id': 4}, 400),
            ({'voice_mode': 'synthesized', 'voice_id': 'https://example.com/voice.wav'}, 400),
            ({'voice_mode': 'synthesized', 'voice_id': selected_music}, 404),
            ({'voice_mode': 'synthesized', 'voice_id': foreign}, 404),
            ({'music': True, 'music_id': selected_voice}, 404),
            ({'count': True}, 400), ({'duration': 2}, 400)]:
            with self.subTest(changes=changes):
                self.assertEqual(self.submit(**changes).status_code, status)
        self.assertEqual(self.app.state.jobs.list(self.owner), [])

    def test_delete_blocks_resumable_jobs_only_for_own_references(self):
        selected = self.upload('music')
        response = self.submit(music_id=selected, music=True)
        self.assertEqual(response.status_code, 202, response.text)
        ident = response.json()['id']
        for state in ('queued', 'running', 'waiting_materials', 'interrupted', 'failed'):
            with self.app.state.jobs.connect() as db:
                db.execute('UPDATE jobs SET state=? WHERE id=?', (state, ident))
            self.assertTrue(self.app.state.jobs.audio_in_use(self.owner, selected))
            self.assertFalse(self.app.state.jobs.audio_in_use('b' * 64, selected))
            self.assertEqual(self.client.delete('/v1/mix/audio/' + selected, headers=self.headers).status_code, 409)
        with self.app.state.jobs.connect() as db:
            db.execute("UPDATE jobs SET state='done' WHERE id=?", (ident,))
        self.assertEqual(self.client.delete('/v1/mix/audio/' + selected, headers=self.headers).status_code, 200)

    def test_browser_source_cut_preserves_exact_original_audio_but_analysis_proxy_stays_silent(self):
        source = self.root / 'source.mp4'
        media.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=25',
                   '-f', 'lavfi', '-i', r'aevalsrc=if(lt(t\,1)\,sin(2*PI*330*t)\,sin(2*PI*660*t))*0.125:s=48000',
                   '-t', '3', '-c:v', 'libx264', '-crf', '0', '-c:a', 'aac', str(source)])
        before = source.read_bytes()
        clip = {'id': 'b' * 64, 'asset_id': 'c' * 64, 'name': 'source.mp4', 'start': 1.2, 'end': 2}
        base = '/v1/browser-materials/devices/' + self.device
        self.assertEqual(self.client.post(base + '/clips', headers=self.headers, json={'clips': [clip]}).status_code, 200)
        with self.app.state.materials.connect() as db:
            db.execute("UPDATE clips SET state='indexed' WHERE id=?", (clip['id'],))
        requested = self.app.state.materials.request_clip(self.device, clip['id'], 'source', '1' * 32)
        self.app.state.browser_materials.fulfill_sources(self.device, clip['asset_id'], source)
        segment = self.app.state.materials.wait_clip(requested['id'])
        self.assertTrue(media.has_audio(segment), 'HD source cut must preserve optional original sound')
        samples = audio_samples(segment)
        self.assertGreater(amplitude(samples, 660, .2), .09)
        self.assertLess(amplitude(samples, 330, .2), .002)
        self.assertEqual(source.read_bytes(), before)
        media.proxy(source, 1.2, .8, self.root / 'proxy.mp4')
        self.assertFalse(media.has_audio(self.root / 'proxy.mp4'))

    def test_browser_source_cut_keeps_delayed_audio_at_its_original_video_time(self):
        source = self.root / 'delayed-source.mp4'
        media.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=25:d=3',
                   '-itsoffset', '1', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=2',
                   '-c:v', 'libx264', '-c:a', 'aac', str(source)])
        clip = {'id': 'b' * 64, 'asset_id': 'c' * 64, 'name': 'source.mp4', 'start': .2, 'end': 1.8}
        base = '/v1/browser-materials/devices/' + self.device
        self.assertEqual(self.client.post(base + '/clips', headers=self.headers, json={'clips': [clip]}).status_code, 200)
        with self.app.state.materials.connect() as db:
            db.execute("UPDATE clips SET state='indexed' WHERE id=?", (clip['id'],))
        requested = self.app.state.materials.request_clip(self.device, clip['id'], 'source', '1' * 32)
        self.app.state.browser_materials.fulfill_sources(self.device, clip['asset_id'], source)
        segment = self.app.state.materials.wait_clip(requested['id'])
        samples = audio_samples(segment)
        self.assertLess(np.max(np.abs(samples[7200:31200])), .002, 'audio must not move into the first silent interval')
        self.assertGreater(amplitude(samples, 660, 1.05), .09)
        self.assertAlmostEqual(media.duration(segment), 1.6, delta=.04)

    def saved_job(self, **changes):
        response = self.submit(**changes)
        self.assertEqual(response.status_code, 202, response.text)
        ident = response.json()['id']
        source = self.root / 'job-source.mp4'
        media.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=25',
                   '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000', '-t', '2',
                   '-c:v', 'libx264', '-c:a', 'aac', str(source)])
        folder = self.root / 'server/outputs' / ident
        selected = {'id': 1, 'path': str(source), 'stamp': file_stamp(source),
                    'source_start': 0, 'verified_start': 0, 'verified_end': 2}
        write_json(folder / 'plan.json', {'script': '散步。', 'fps': 25, 'seed': 1,
            'scenes': [{'text': '散步。', 'query': '散步', 'match': {'selected': selected}, 'start': 0, 'end': 1}]})
        with self.app.state.jobs.connect() as db:
            spec = json.loads(db.execute('SELECT spec FROM jobs WHERE id=?', (ident,)).fetchone()[0])
            spec.update(width=64, height=64)
            db.execute('UPDATE jobs SET spec=? WHERE id=?', (json.dumps(spec), ident))
        return ident, folder

    @staticmethod
    def checked_report(video, plan, folder, *args, **kwargs):
        technical = quality.inspect_media(video, plan)
        report = {'passed': not technical['issues'], 'technical': technical,
                  'sha256': hashlib.sha256(Path(video).read_bytes()).hexdigest(), 'segments': []}
        write_json(folder / 'quality-report.json', report)
        return report

    def test_original_job_needs_no_tts_or_cos_and_downloads_timed_captions(self):
        self.library.env = {}
        ident, folder = self.saved_job()
        with patch.dict(os.environ, {'OPENLUX_API_KEY': 'test', 'RERANK_API_KEY': 'test',
                                    'PATH': os.environ['PATH'], 'SystemRoot': os.environ.get('SystemRoot', '')}, clear=True), \
                patch('voice.synthesize_plan') as synthesize, patch('finish.Models'), \
                patch('app.shutil.which', return_value='/tool'), \
                patch('quality.review', side_effect=self.checked_report):
            self.app.state.jobs.run_one(self.app.state.runner)
        job = self.app.state.jobs.get(ident)
        self.assertEqual(job['state'], 'done', job['error'])
        synthesize.assert_not_called()
        plan = json.loads((folder / 'plan.json').read_text(encoding='utf-8'))
        self.assertEqual(plan['voice_mode'], 'original')
        self.assertEqual(plan['scenes'][0]['timing'], 'estimated')
        self.assertNotIn('narration', plan)
        samples = audio_samples(folder / job['result'])
        self.assertGreater(amplitude(samples, 660, .2), .05)
        captions_response = self.client.get('/v1/mix/jobs/' + ident + '/captions', headers=self.headers)
        self.assertEqual(captions_response.status_code, 200)
        self.assertIn('00:00:01,000', captions_response.text)
        public_plan = self.client.get('/v1/mix/jobs/' + ident + '/plan', headers=self.headers).json()
        self.assertEqual(public_plan.get('voice_mode'), 'original')

    def test_original_job_can_download_owned_music_and_keep_source_sound_without_tts(self):
        selected_music = self.upload('music')
        ident, folder = self.saved_job(music_id=selected_music, music=True)
        with patch.dict(os.environ, {'OPENLUX_API_KEY': 'test', 'RERANK_API_KEY': 'test',
                                    'PATH': os.environ['PATH'], 'SystemRoot': os.environ.get('SystemRoot', '')}, clear=True), \
                patch('voice.synthesize_plan') as synthesize, patch('finish.Models'), \
                patch('app.shutil.which', return_value='/tool'), \
                patch('quality.review', side_effect=self.checked_report):
            self.app.state.jobs.run_one(self.app.state.runner)
        job = self.app.state.jobs.get(ident)
        self.assertEqual(job['state'], 'done', job['error'])
        synthesize.assert_not_called()
        self.assertEqual(job['result'], 'video-music.mp4')
        samples = audio_samples(folder / job['result'])
        self.assertGreater(amplitude(samples, 660, .3), .04)
        self.assertGreater(amplitude(samples, 220, .3), .001)

    def test_selected_synthesized_voice_music_job_resumes_paid_audio_without_default_voice(self):
        selected_voice, selected_music = self.upload('voice'), self.upload('music')
        ident, folder = self.saved_job(voice_mode='synthesized', voice_id=selected_voice,
                                       music_id=selected_music, music=True)
        calls, reviews = [], []

        def synthesize(text, speaker, emotion_url, emotion_hash, alpha, cache, log, **kwargs):
            calls.append((speaker, kwargs['speaker_cache_key']))
            path = cache / 'paid.wav'
            path.parent.mkdir(parents=True, exist_ok=True)
            tone(path, 880, 1)
            return path

        def review(video, plan, output, *args, **kwargs):
            reviews.append(Path(video).name)
            if len(reviews) == 1:
                return {'passed': False, 'segments': [{'passed': False, 'issues': [
                    {'type': 'audio_cutoff', 'severity': 'error', 'problem': 'test review failure'}]}]}
            return self.checked_report(video, plan, output)

        with patch.dict(os.environ, {'OPENLUX_API_KEY': 'test', 'RERANK_API_KEY': 'test',
                                    'INDEXTTS_302_API_KEY': 'test', 'PATH': os.environ['PATH'],
                                    'SystemRoot': os.environ.get('SystemRoot', '')}, clear=True), \
                patch('voice.synthesize', side_effect=synthesize), patch('finish.Models'), \
                patch('app.shutil.which', return_value='/tool'), \
                patch('quality.review', side_effect=review):
            self.app.state.jobs.run_one(self.app.state.runner)
            self.assertEqual(self.app.state.jobs.get(ident)['state'], 'failed')
            self.app.state.jobs.resume(ident, self.owner)
            self.app.state.jobs.run_one(self.app.state.runner)
        job = self.app.state.jobs.get(ident)
        self.assertEqual(job['state'], 'done', job['error'])
        self.assertEqual(len(calls), 1, 'completed paid narration must survive review failure')
        self.assertIn(self.library.get(self.owner, selected_voice)['sha256'], calls[0][1])
        self.assertEqual(reviews, ['video-music.mp4', 'video-music.mp4'])
        self.assertEqual(len(self.cos.signatures), 1)
        samples = audio_samples(folder / job['result'])
        self.assertGreater(amplitude(samples, 880, .3), .04)
        self.assertGreater(amplitude(samples, 220, .3), .001)


class OriginalSoundTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def source(self, name, audio=True):
        path = self.root / name
        args = ['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=25']
        if audio:
            # Three distinct seconds make a wrong seek or earlier audio obvious.
            args += ['-f', 'lavfi', '-i',
                     r'aevalsrc=if(lt(t\,1)\,sin(2*PI*330*t)\,if(lt(t\,2)\,sin(2*PI*660*t)\,sin(2*PI*990*t)))*0.125:s=48000',
                     '-c:a', 'aac']
        args += ['-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(path)]
        media.run(args)
        return path

    def plan(self, audio=True):
        source, silent = self.source('source.mp4', audio), self.source('silent.mp4', False)
        def selected(path, start):
            return {'id': str(start), 'path': str(path), 'stamp': file_stamp(path),
                    'source_start': start, 'verified_start': 0, 'verified_end': .8}
        shots = [selected(source, 1.1), selected(silent, 0), selected(source, 2.1)]
        return {'fps': 25, 'seed': 3, 'voice_mode': 'original', 'subtitles': False,
                'scenes': [{'text': '只作画面匹配', 'start': 0, 'end': 2.4,
                            'match': {'selected': shots[0]},
                            'shots': [{'selected': item, 'duration': .8} for item in shots]}]}

    def test_exact_selected_original_shots_silent_gap_and_caption_repair_keep_audio(self):
        plan = self.plan()
        source = Path(plan['scenes'][0]['shots'][0]['selected']['path'])
        before = source.read_bytes()
        output = self.root / 'out'
        video = media.render(plan, output, 64, 64, log=lambda _: None)
        self.assertIn('original_audio', plan, 'original mode must create a reusable audio stem')
        samples = audio_samples(video)
        self.assertGreater(amplitude(samples, 660, .2), .09)
        self.assertLess(amplitude(samples, 330, .2), .002)
        self.assertLess(np.max(np.abs(samples[48000:65000])), .002)
        self.assertGreater(amplitude(samples, 990, 1.8), .09)
        self.assertAlmostEqual(media.duration(video), 2.4, delta=.04)
        self.assertTrue((output / 'captions.srt').is_file())
        self.assertNotIn('narration', plan)
        stem = Path(plan['original_audio'])
        stem_before = stem.read_bytes()
        source.unlink()
        revised = captions.rebuild(plan, output, 64, 64)
        self.assertEqual(stem.read_bytes(), stem_before)
        self.assertTrue(np.allclose(audio_samples(revised), samples, atol=1e-6))
        self.assertEqual(quality.inspect_media(revised, plan)['issues'], [])
        self.assertTrue(before)

    def test_short_and_long_music_remain_audible_beneath_original_and_in_silent_gap(self):
        for duration in (.4, 5):
            with self.subTest(duration=duration):
                plan = self.plan()
                output = self.root / ('out' + str(duration))
                video = media.render(plan, output, 64, 64, log=lambda _: None)
                self.assertIn('original_audio', plan)
                bgm = self.root / 'music.wav'
                tone(bgm, 220, duration)
                result = music.mix(video, plan['original_audio'], bgm, output, 2.4)
                samples = audio_samples(result)
                self.assertGreater(amplitude(samples, 660, .2), .05)
                self.assertGreater(amplitude(samples, 220, 1.05), .008)
                self.assertAlmostEqual(media.duration(result), 2.4, delta=.04)

    def test_music_only_and_completely_silent_original_are_valid_full_length_tracks(self):
        plan = self.plan(audio=False)
        output = self.root / 'out'
        video = media.render(plan, output, 64, 64, log=lambda _: None)
        self.assertIn('original_audio', plan)
        bgm = self.root / 'music.wav'
        tone(bgm, 220, .4)
        for stem in (plan['original_audio'], None):
            result = music.mix(video, stem, bgm, output, 2.4)
            samples = audio_samples(result)
            self.assertGreater(amplitude(samples, 220, 1.05), .008)
            self.assertAlmostEqual(media.duration(result), 2.4, delta=.04)

    def test_short_original_audio_ends_in_silence_and_later_seek_never_restarts_it(self):
        source = self.root / 'short-audio.mp4'
        media.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=25:d=2',
                   '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=0.3',
                   '-c:v', 'libx264', '-c:a', 'aac', str(source)])
        selected = [{'id': index, 'path': str(source), 'stamp': file_stamp(source),
                     'source_start': start, 'verified_start': 0, 'verified_end': .8}
                    for index, start in enumerate((0, 1))]
        plan = {'voice_mode': 'original', 'fps': 25, 'seed': 1, 'subtitles': False,
                'scenes': [{'text': '', 'start': 0, 'end': 1.6, 'match': {'selected': selected[0]},
                            'shots': [{'selected': item, 'duration': .8} for item in selected]}]}
        video = media.render(plan, self.root / 'out', 64, 64, log=lambda _: None)
        samples = audio_samples(video)
        self.assertGreater(amplitude(samples, 660, .05), .09)
        self.assertLess(np.max(np.abs(samples[24000:74000])), .002)
        self.assertAlmostEqual(media.duration(video), 1.6, delta=.04)
        cuts = json.loads((self.root / 'out/cuts.json').read_text(encoding='utf-8'))
        self.assertEqual([cut['audio_present'] for cut in cuts], [True, False],
                         'quality must allow a cut whose source audio has already ended')

    def test_delayed_original_audio_keeps_silence_before_its_video_timestamp(self):
        source = self.root / 'delayed.mp4'
        media.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=25:d=3',
                   '-itsoffset', '1', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=2',
                   '-c:v', 'libx264', '-c:a', 'aac', str(source)])
        selected = {'path': str(source), 'stamp': file_stamp(source),
                    'source_start': 0, 'verified_start': 0, 'verified_end': 2}
        plan = {'voice_mode': 'original', 'fps': 25, 'seed': 1, 'subtitles': False,
                'scenes': [{'text': '', 'start': 0, 'end': 2, 'match': {'selected': selected}}]}
        video = media.render(plan, self.root / 'out', 64, 64, log=lambda _: None)
        samples = audio_samples(video)
        self.assertLess(np.max(np.abs(samples[4800:36000])), .002, 'audio PTS must retain the initial silent second')
        self.assertGreater(amplitude(samples, 660, 1.25), .09)

    def test_original_quality_reviews_actual_sound_without_requiring_script_as_speech(self):
        plan = self.plan()
        output = self.root / 'out'
        video = media.render(plan, output, 64, 64, log=lambda _: None)
        prompts = []

        class Reviewer:
            def json(self, prompt, videos):
                prompts.append(prompt)
                return {'passed': True, 'watched_until': 2.4, 'audio_present': True,
                        'speech_clear': False, 'issues': []}

        report = quality.review(video, plan, output, Reviewer(), log=lambda _: None)
        self.assertTrue(report['passed'])
        self.assertEqual(report['sha256'], hashlib.sha256(video.read_bytes()).hexdigest())
        self.assertIn('文案仅用于画面匹配', prompts[0])
        self.assertNotIn('最后一段必须听到最后一句完整结束', prompts[0])
        self.assertNotIn('口播是否截断或缺字', prompts[0])
        info = quality.inspect_media(video, plan)
        self.assertIn('audio', info['stream_seconds'])
        missing_audio = output / 'without-audio.mp4'
        media.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', str(video), '-an', '-c:v', 'copy', str(missing_audio)])
        self.assertTrue(quality.inspect_media(missing_audio, plan)['issues'])

    def test_review_boundary_allows_original_audio_that_ended_inside_previous_segment(self):
        silent, brief = self.root / 'silent-38s.mp4', self.root / 'brief-3s.mp4'
        media.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i',
                   'testsrc2=s=64x64:r=25:d=38', '-c:v', 'libx264', '-preset', 'ultrafast', str(silent)])
        media.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i',
                   'testsrc2=s=64x64:r=25:d=3', '-f', 'lavfi', '-i',
                   'sine=frequency=660:sample_rate=48000:duration=0.3',
                   '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', str(brief)])
        plan = {'voice_mode': 'original', 'fps': 25, 'seed': 1, 'subtitles': False, 'scenes': []}
        for path, start, end in ((silent, 0, 38), (brief, 38, 41)):
            selected = {'path': str(path), 'stamp': file_stamp(path), 'source_start': 0,
                        'verified_start': 0, 'verified_end': end - start}
            plan['scenes'].append({'text': '', 'start': start, 'end': end, 'match': {'selected': selected}})
        output = self.root / 'out'
        video = media.render(plan, output, 64, 64, log=lambda _: None)
        expected, heard, prompts = [], [], []

        class Reviewer:
            def json(self, prompt, videos):
                metadata = json.loads(next(line for line in prompt.splitlines() if line.startswith('{"segment_start"')))
                audible = bool(np.max(np.abs(audio_samples(videos[0][1]))) > .002)
                expected.append(metadata['original_audio_expected'])
                heard.append(audible)
                prompts.append(prompt)
                return {'passed': True, 'watched_until': metadata['segment_duration'],
                        'audio_present': audible, 'issues': []}

        report = quality.review(video, plan, output, Reviewer(), log=lambda _: None)
        self.assertEqual(report['technical']['issues'], [])
        self.assertEqual(heard, [True, False], 'actual exported second review segment is silent')
        self.assertEqual(expected, [True, False], 'original expectations must reflect this interval, not the whole shot')
        self.assertTrue(report['passed'], report)
        self.assertNotIn('最后一段画面和所选原片音轨必须持续到时间轴结束', prompts[-1])
        self.assertIn('原片音频已经结束或无声的区间', prompts[-1])
        self.assertEqual(report['sha256'], hashlib.sha256(video.read_bytes()).hexdigest())


class VoiceCacheTests(unittest.TestCase):
    def test_renewed_signed_voice_url_reuses_same_paid_checkpoint(self):
        self.assertIn('speaker_cache_key', inspect.signature(voice.synthesize_plan).parameters)
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            paid = output / 'paid.wav'
            tone(paid, 880, 1)
            payload = paid.read_bytes()
            stable = 'library:' + 'a' * 32 + ':' + 'b' * 64
            submissions = []

            class Response:
                status_code = 200
                content = payload
                text = ''

                def __init__(self, body):
                    self.body = body

                def json(self):
                    return self.body

            def post(url, **kwargs):
                submissions.append(kwargs['json'])
                return Response({'task_id': 'paid-task'})

            def get(url, **kwargs):
                return Response({'state': 'SUCCESS', 'audio_url': 'https://provider.example.com/paid.wav'})

            plan = {'fps': 25, 'scenes': [{'text': '散步。'}]}
            with patch('voice.headers', return_value={}), patch('voice.requests.post', side_effect=post), \
                    patch('voice.requests.get', side_effect=get), \
                    patch.dict(os.environ, {'INDEXTTS_DOWNLOAD_HOSTS': 'provider.example.com',
                                           'PATH': os.environ['PATH'], 'SystemRoot': os.environ.get('SystemRoot', '')}, clear=True):
                for signature in (1, 2):
                    voice.synthesize_plan(plan, output, speaker_url='https://audio.example.com/ref?sig=' + str(signature),
                                          speaker_cache_key=stable, emotion_file=None, emotion_url=None, log=lambda _: None)
            self.assertEqual(len(submissions), 1)
            self.assertTrue(submissions[0]['speaker_audio_url'].endswith('sig=1'))


if __name__ == '__main__':
    unittest.main()
