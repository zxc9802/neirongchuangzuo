import hashlib
import json
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'services/mix/python'))
try:
    import audio_library
except ModuleNotFoundError:
    audio_library = None

ENV = {'MIX_AUDIO_COS_SECRET_ID': 'test-id', 'MIX_AUDIO_COS_SECRET_KEY': 'test-key',
       'MIX_AUDIO_COS_BUCKET': 'test-bucket', 'MIX_AUDIO_COS_REGION': 'test-region'}


class FakeCos:
    def __init__(self):
        self.objects = {}
        self.puts = []
        self.signs = []
        self.downloads = []
        self.deletes = []
        self.failure = None
        self.signed_scheme = 'https'

    def put_object(self, **kwargs):
        self.puts.append(kwargs.copy())
        self.objects[kwargs['Key']] = kwargs['Body'].read()
        return {}

    def get_presigned_url(self, **kwargs):
        self.signs.append(kwargs)
        return f'{self.signed_scheme}://cos.test/{kwargs["Key"]}?signature={len(self.signs)}'

    def download_file(self, **kwargs):
        self.downloads.append(kwargs)
        Path(kwargs['DestFilePath']).write_bytes(self.objects[kwargs['Key']])
        if self.failure == 'download':
            raise RuntimeError('test-key private provider error')

    def delete_object(self, **kwargs):
        self.deletes.append(kwargs)
        if self.failure == 'delete':
            raise RuntimeError('test-key private provider error')
        self.objects.pop(kwargs['Key'], None)
        return {}


class AudioLibraryTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixtures = tempfile.TemporaryDirectory()
        cls.source = Path(cls.fixtures.name) / 'sample.wav'
        subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'lavfi',
                        '-i', 'sine=frequency=440:duration=17', '-ar', '44100', '-ac', '2',
                        str(cls.source)], check=True, capture_output=True)
        cls.music = Path(cls.fixtures.name) / 'music.mp3'
        subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', str(cls.source),
                        '-t', '0.5', str(cls.music)], check=True, capture_output=True)
        cls.m4a = Path(cls.fixtures.name) / 'music.m4a'
        subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', str(cls.music),
                        '-c:a', 'aac', str(cls.m4a)], check=True, capture_output=True)
        cover = Path(cls.fixtures.name) / 'cover.jpg'
        subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'lavfi',
                        '-i', 'color=blue:s=32x32', '-frames:v', '1', str(cover)],
                       check=True, capture_output=True)
        cls.covered = Path(cls.fixtures.name) / 'covered.mp3'
        subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', str(cls.music),
                        '-i', str(cover), '-map', '0:a', '-map', '1:v', '-c', 'copy',
                        '-disposition:v', 'attached_pic', str(cls.covered)],
                       check=True, capture_output=True)
        cls.video = Path(cls.fixtures.name) / 'video.m4a'
        subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'lavfi',
                        '-i', 'color=blue:s=32x32:d=0.3', '-i', str(cls.music), '-shortest',
                        '-c:v', 'mpeg4', '-c:a', 'aac', '-f', 'mp4', str(cls.video)],
                       check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        cls.fixtures.cleanup()

    def setUp(self):
        self.assertIsNotNone(audio_library, 'audio_library module must implement the private audio library')
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.cos = FakeCos()
        self.library = audio_library.AudioLibrary(self.root, client=self.cos, env=ENV)


class AudioLibraryTests(AudioLibraryTestCase):
    def test_config_is_isolated_and_missing_names_are_public(self):
        other = audio_library.AudioLibrary(self.root / 'other', client=self.cos,
                                          env={'COS_SECRET_ID': 'unrelated-secret', 'COS_BUCKET': 'other'})
        self.assertEqual(other.status(), {'configured': False, 'missing': list(ENV)})
        self.assertEqual(other.list('owner', 'voice'), [])
        with self.assertRaisesRegex(RuntimeError, 'MIX_AUDIO_COS'):
            other.upload('owner', 'music', 'music.mp3', self.music)
        self.assertEqual(self.cos.puts, [])

    def test_voice_reference_is_private_mono_22050_and_first_15_seconds(self):
        item = self.library.upload('../owner', 'voice', '我的声线.wav', self.source)
        self.assertEqual(set(item), {'id', 'kind', 'name', 'duration', 'bytes', 'url'})
        self.assertEqual(item['url'], '/api/mix/audio/' + item['id'] + '/stream')
        self.assertAlmostEqual(item['duration'], 15, places=3)
        meta = self.library.get('../owner', item['id'], 'voice')
        self.assertRegex(meta['key'], r'^mix-audio/[a-f0-9]{64}/voice/[a-f0-9]{32}\.wav$')
        self.assertEqual(self.cos.puts[0]['ACL'], 'private')
        self.assertEqual(meta['sha256'], hashlib.sha256(self.cos.objects[meta['key']]).hexdigest())
        downloaded = self.library.download('../owner', item['id'], self.root / 'job')
        info = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-of', 'json',
                                         str(downloaded)], check=True, capture_output=True).stdout)
        self.assertEqual(info['streams'][0]['sample_rate'], '22050')
        self.assertEqual(info['streams'][0]['channels'], 1)
        self.assertEqual(list(self.library.temp_dir.iterdir()), [])

    def test_music_preserves_original_bytes_and_retry_deduplicates_only_same_owner_and_kind(self):
        item = self.library.upload('one', 'music', 'song.mp3', self.music)
        same = self.library.upload('one', 'music', 'renamed.mp3', self.music)
        other = self.library.upload('two', 'music', 'song.mp3', self.music)
        voice = self.library.upload('one', 'voice', 'voice.mp3', self.music)
        self.assertEqual(item['id'], same['id'])
        self.assertNotEqual(item['id'], other['id'])
        self.assertNotEqual(item['id'], voice['id'])
        self.assertEqual(len(self.cos.puts), 3)
        meta = self.library.get('one', item['id'])
        self.assertEqual(self.cos.objects[meta['key']], self.music.read_bytes())
        self.assertEqual(self.library.list('one', 'music'), [item])
        self.assertEqual(audio_library.AudioLibrary(self.root, client=self.cos, env=ENV).get('one', item['id']), meta)

    def test_inaccessible_ids_and_wrong_kind_never_reach_cos(self):
        item = self.library.upload('one', 'music', 'song.mp3', self.music)
        for owner, ident, kind in [('two', item['id'], None), ('one', '../escape', None),
                                   ('one', item['id'], 'voice')]:
            with self.subTest(owner=owner, ident=ident, kind=kind), self.assertRaises(KeyError):
                self.library.get(owner, ident, kind)
        for action in (self.library.signed_url, self.library.delete):
            with self.assertRaises(KeyError):
                action('two', item['id'])
        with self.assertRaises(KeyError):
            self.library.download('two', item['id'], self.root / 'job')
        self.assertEqual(self.cos.signs + self.cos.downloads + self.cos.deletes, [])

    def test_fake_empty_and_ordinary_video_files_are_rejected(self):
        for name, data in [('fake.mp3', b'not audio'), ('empty.wav', b''),
                           ('playlist.mp3', b'#EXTM3U\nhttps://external.test/audio.mp3\n')]:
            file = self.root / name
            file.write_bytes(data)
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.library.upload('one', 'music', name, file)
        with self.assertRaises(ValueError):
            self.library.upload('one', 'music', 'video.m4a', self.video)
        with self.assertRaises(ValueError):
            self.library.upload('one', 'music', 'song.ogg', self.music)
        with self.assertRaises(ValueError):
            self.library.upload('one', 'music', 'folder.wav', self.root)
        self.assertEqual(self.cos.puts, [])
        self.assertEqual(list(self.library.temp_dir.iterdir()), [])

    def test_format_disguised_as_mp3_is_rejected(self):
        with self.assertRaises(ValueError):
            self.library.upload('one', 'music', 'disguised.mp3', self.source)

    def test_real_m4a_and_attached_cover_art_are_accepted(self):
        for file in (self.m4a, self.covered):
            with self.subTest(file=file.name):
                item = self.library.upload('one', 'music', file.name, file)
                meta = self.library.get('one', item['id'])
                self.assertEqual(self.cos.objects[meta['key']], file.read_bytes())
                self.assertGreater(item['duration'], 0)

    def test_nonfinite_zero_and_excessive_duration_are_rejected(self):
        for duration in ('nan', 'inf', '-1', '0', str(24 * 3600 + 1)):
            data = {'format': {'format_name': 'mp3', 'duration': duration},
                    'streams': [{'codec_type': 'audio'}]}
            with self.subTest(duration=duration), patch.object(audio_library, 'decode',
                                                              return_value=json.dumps(data).encode()):
                with self.assertRaises(ValueError):
                    self.library.upload('one', 'music', 'song.mp3', self.music)
        self.assertEqual(self.cos.puts, [])

    def test_oversize_inputs_are_rejected_before_decoding(self):
        for kind, size in [('voice', 32 * 1024 * 1024), ('music', 128 * 1024 * 1024)]:
            file = self.root / (kind + '.wav')
            with file.open('wb') as target:
                target.truncate(size + 1)
            with self.subTest(kind=kind), patch.object(audio_library.subprocess, 'run') as decode:
                with self.assertRaises(ValueError):
                    self.library.upload('one', kind, file.name, file)
                decode.assert_not_called()
        self.assertEqual(self.cos.puts, [])

    def test_sanitized_display_name_is_bounded_and_keeps_extension(self):
        item = self.library.upload('one', 'music', '../\x00' + '名' * 150 + '.mp3', self.music)
        self.assertLessEqual(len(item['name']), 100)
        self.assertNotIn('\x00', item['name'])
        self.assertNotIn('/', item['name'])
        self.assertTrue(item['name'].endswith('.mp3'))

    def test_signing_is_fresh_https_and_bounded(self):
        item = self.library.upload('one', 'music', 'song.mp3', self.music)
        first = self.library.signed_url('one', item['id'])
        second = self.library.signed_url('one', item['id'], expires=120)
        self.assertNotEqual(first, second)
        self.assertTrue(first.startswith('https://'))
        self.assertEqual(self.cos.signs[-1]['Expired'], 120)
        self.assertEqual(self.cos.signs[-1]['Method'], 'GET')
        self.library.signed_url('one', item['id'], method='HEAD')
        self.assertEqual(self.cos.signs[-1]['Method'], 'HEAD')
        for method in ('POST', 'get', '', None):
            with self.subTest(method=method), self.assertRaises(ValueError):
                self.library.signed_url('one', item['id'], method=method)
        for value in (0, -1, 3601, '3600'):
            with self.subTest(expires=value), self.assertRaises(ValueError):
                self.library.signed_url('one', item['id'], expires=value)
        self.cos.signed_scheme = 'http'
        with self.assertRaises(RuntimeError):
            self.library.signed_url('one', item['id'])

    def test_download_checks_cached_and_remote_content_hash_and_removes_partial_files(self):
        item = self.library.upload('one', 'music', 'song.mp3', self.music)
        job = self.root / 'job'
        target = self.library.download('one', item['id'], job)
        self.assertEqual(self.library.download('one', item['id'], job), target)
        self.assertEqual(len(self.cos.downloads), 1)
        target.write_bytes(b'corrupted cached audio')
        self.library.download('one', item['id'], job)
        self.assertEqual(target.read_bytes(), self.music.read_bytes())
        self.assertEqual(len(self.cos.downloads), 2)
        target.unlink()
        self.cos.failure = 'download'
        with self.assertRaises(RuntimeError):
            self.library.download('one', item['id'], job)
        self.assertEqual(list(job.iterdir()), [])
        self.cos.failure = None
        self.cos.objects[self.library.get('one', item['id'])['key']] = b'wrong remote contents'
        with self.assertRaises(RuntimeError):
            self.library.download('one', item['id'], job)
        self.assertEqual(list(job.iterdir()), [])

    def test_delete_removes_metadata_only_after_cloud_success(self):
        item = self.library.upload('one', 'music', 'song.mp3', self.music)
        self.cos.failure = 'delete'
        with self.assertRaises(RuntimeError) as caught:
            self.library.delete('one', item['id'])
        self.assertNotIn('test-key', str(caught.exception))
        self.assertEqual(self.library.list('one', 'music'), [item])
        self.cos.failure = None
        self.library.delete('one', item['id'])
        self.assertEqual(self.library.list('one', 'music'), [])
        self.assertEqual(self.cos.objects, {})

    def test_registration_failure_cleans_up_uploaded_object(self):
        with self.library.connect() as db:
            db.execute("CREATE TRIGGER fail_registration BEFORE INSERT ON audio BEGIN SELECT RAISE(ABORT, 'failure'); END")
        with self.assertRaises(RuntimeError):
            self.library.upload('one', 'music', 'song.mp3', self.music)
        self.assertEqual(self.cos.objects, {})
        self.assertEqual(len(self.cos.deletes), 1)
        self.assertEqual(self.library.list('one', 'music'), [])


class AudioLibraryRouteTests(AudioLibraryTestCase):
    def setUp(self):
        super().setUp()
        self.app = FastAPI()
        def owner(request: Request):
            value = request.headers.get('x-owner')
            if not value:
                raise HTTPException(401, '需要账号')
            return value
        self.in_use = set()
        audio_library.attach_audio_library(self.app, self.library, owner,
                                           in_use=lambda account, ident: ident in self.in_use)
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)
        self.headers = {'x-owner': 'one'}

    def test_raw_upload_list_authenticated_get_head_and_delete_contract(self):
        self.assertEqual(self.client.post('/v1/mix/audio?kind=music&name=song.mp3',
                                          content=self.music.read_bytes()).status_code, 401)
        result = self.client.post('/v1/mix/audio?kind=music&name=song.mp3',
                                  content=self.music.read_bytes(), headers=self.headers)
        self.assertEqual(result.status_code, 200, result.text)
        item = result.json()['item']
        listing = self.client.get('/v1/mix/audio?kind=music', headers=self.headers).json()
        self.assertEqual(listing, {'configured': True, 'missing': [], 'items': [item]})
        self.assertNotIn('signature', json.dumps(listing))
        self.assertNotIn('mix-audio/', json.dumps(listing))
        stream = '/v1/mix/audio/' + item['id'] + '/stream'
        for method in ('get', 'head'):
            response = getattr(self.client, method)(stream, headers=self.headers, follow_redirects=False)
            self.assertEqual(response.status_code, 307)
            self.assertTrue(response.headers['location'].startswith('https://'))
            self.assertEqual(self.cos.signs[-1]['Method'], method.upper())
        self.assertEqual(self.client.get(stream, headers={'x-owner': 'two'},
                                         follow_redirects=False).status_code, 404)
        self.in_use.add(item['id'])
        endpoint = '/v1/mix/audio/' + item['id']
        self.assertEqual(self.client.delete(endpoint, headers=self.headers).status_code, 409)
        self.in_use.clear()
        self.assertEqual(self.client.delete(endpoint, headers={'x-owner': 'two'}).status_code, 404)
        self.assertEqual(self.client.delete(endpoint, headers=self.headers).status_code, 200)

    def test_missing_configuration_lists_and_fails_upload_cleanly(self):
        self.library.env = {}
        response = self.client.get('/v1/mix/audio?kind=voice', headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'configured': False, 'missing': list(ENV), 'items': []})
        response = self.client.post('/v1/mix/audio?kind=music&name=song.mp3',
                                    content=self.music.read_bytes(), headers=self.headers)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(list(self.library.temp_dir.iterdir()), [])

    def test_streaming_upload_size_limits_and_bad_kind_are_clean(self):
        with patch.dict(audio_library.LIMITS, {'music': 10}):
            response = self.client.post('/v1/mix/audio?kind=music&name=song.mp3',
                                        content=(chunk for chunk in [b'123456', b'789012']), headers=self.headers)
        self.assertEqual(response.status_code, 413)
        self.assertEqual(list(self.library.temp_dir.iterdir()), [])
        self.assertEqual(self.client.get('/v1/mix/audio?kind=other', headers=self.headers).status_code, 400)
        self.assertEqual(self.cos.puts, [])

    def test_decoder_and_sdk_operations_run_outside_event_loop_thread(self):
        threads = []
        real_upload = self.library.upload
        def upload(*args):
            threads.append(threading.current_thread().name)
            return real_upload(*args)
        with patch.object(self.library, 'upload', side_effect=upload):
            result = self.client.post('/v1/mix/audio?kind=music&name=song.mp3',
                                      content=self.music.read_bytes(), headers=self.headers)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertTrue(threads)
        self.assertTrue(all('AnyIO worker' in value for value in threads), threads)

    def test_deletion_holds_shared_lock_through_in_use_check_and_cloud_delete(self):
        item = self.library.upload('one', 'music', 'song.mp3', self.music)
        checked, finish_check, submit_started, submit_checked = [threading.Event() for _ in range(4)]
        results = {}
        def in_use(account, ident):
            checked.set()
            if not finish_check.wait(5):
                raise RuntimeError('test synchronization timed out')
            return False
        app = FastAPI()
        audio_library.attach_audio_library(app, self.library, lambda: 'one', in_use=in_use)
        def delete():
            with TestClient(app) as client:
                results['delete'] = client.delete('/v1/mix/audio/' + item['id']).status_code
        def submit():
            submit_started.set()
            with self.library.lock:
                try:
                    self.library.get('one', item['id'])
                    results['found'] = True
                except KeyError:
                    results['found'] = False
                submit_checked.set()
        deleting = threading.Thread(target=delete)
        submitting = threading.Thread(target=submit)
        deleting.start()
        try:
            self.assertTrue(checked.wait(5))
            submitting.start()
            self.assertTrue(submit_started.wait(5))
            self.assertFalse(submit_checked.wait(.1), 'submit must wait until deletion finishes')
        finally:
            finish_check.set()
            deleting.join(5)
            if submitting.ident:
                submitting.join(5)
        self.assertEqual(results, {'delete': 200, 'found': False})


if __name__ == '__main__':
    unittest.main()
