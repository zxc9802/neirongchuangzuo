import base64
import hashlib
import importlib
import io
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT.parent / 'services/mix/python')]
try:
    browser_materials = importlib.import_module('browser_materials')
except ModuleNotFoundError:
    browser_materials = None

import local_materials
import media
from app import create_app


class BrowserMaterialBackendTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(browser_materials, 'browser material NAS adapter is missing')
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.app = create_app(self.root, 'x' * 40, start_worker=False)
        self.client = TestClient(self.app)
        self.owner = 'a' * 64
        self.headers = {'Authorization': 'Bearer ' + 'x' * 40, 'X-Material-Owner': self.owner}
        self.device = self.connect()['device_id']
        self.base = '/v1/browser-materials/devices/' + self.device
        self.broker = self.app.state.materials
        self.adapter = self.app.state.browser_materials
        self.clip = {'id': 'b' * 64, 'asset_id': 'c' * 64, 'name': 'pool.mp4', 'start': 1, 'end': 3}
        self.assertEqual(self.client.post(self.base + '/clips', headers=self.headers,
                                         json={'clips': [self.clip]}).status_code, 200)

    def connect(self, owner=None, key='d' * 64):
        return self.client.post('/v1/browser-materials/connect',
            headers={**self.headers, 'X-Material-Owner': owner or self.owner},
            json={'folder_key': key, 'name': '我的素材'}).json()

    @staticmethod
    def frames(color='blue', count=2, size=(64, 64)):
        image = io.BytesIO()
        Image.new('RGB', size, color).save(image, format='JPEG')
        frame = 'data:image/jpeg;base64,' + base64.b64encode(image.getvalue()).decode()
        return [frame] * count

    def analyze(self, model=None):
        model = model or Mock()
        model.embed.return_value = [1, 0]
        model.json.return_value = {'description': '蓝色游泳池'}
        with patch('api.Models', return_value=model):
            response = self.client.post(self.base + '/analyze', headers=self.headers,
                json={'clip_id': self.clip['id'], 'frames': self.frames()})
        self.assertEqual(response.status_code, 200, response.text)
        return model

    def request(self, kind='source', job='1' * 32, clip=None):
        return self.broker.request_clip(self.device, (clip or self.clip)['id'], kind, job)

    def source(self):
        path = self.root / 'source.mp4'
        media.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i',
                   'color=c=red:s=64x64:r=25:d=1', '-f', 'lavfi', '-i',
                   'color=c=blue:s=64x64:r=25:d=3', '-filter_complex',
                   '[0:v][1:v]concat=n=2:v=1:a=0', '-c:v', 'libx264', str(path)])
        return path.read_bytes()

    def transfer(self, request, content):
        response = self.client.post(self.base + '/requests/' + request['id'] + '/file',
                                    headers=self.headers, json={'size': len(content)})
        self.assertEqual(response.status_code, 200, response.text)
        upload = response.json()
        url = self.base + '/files/' + upload['id']
        self.assertEqual(self.client.patch(url, headers={**self.headers, 'Upload-Offset': str(upload['offset']),
            'Upload-Checksum': hashlib.sha256(content[upload['offset']:]).hexdigest()},
            content=content[upload['offset']:]).status_code, 200)
        return url

    def test_connection_is_persistent_idempotent_and_owner_scoped(self):
        self.assertEqual(self.connect()['device_id'], self.device)
        other = self.connect(owner='e' * 64)['device_id']
        self.assertNotEqual(other, self.device)
        restarted = TestClient(create_app(self.root, 'x' * 40, start_worker=False))
        result = restarted.post('/v1/browser-materials/connect', headers=self.headers,
                                json={'folder_key': 'd' * 64, 'name': '我的素材'})
        self.assertEqual(result.json()['device_id'], self.device)
        self.assertTrue(self.client.get('/health', headers=self.headers).json()['browser_materials'])

    def test_explicit_disconnect_is_owner_scoped_and_cancels_linked_requests(self):
        self.analyze()
        request = self.request()
        stranger = {**self.headers, 'X-Material-Owner': 'e' * 64}
        self.assertEqual(self.client.delete(self.base, headers=stranger).status_code, 404)
        self.assertEqual(self.client.delete(self.base, headers=self.headers).status_code, 200)
        self.assertEqual(self.client.get(self.base + '/requests', headers=self.headers).status_code, 404)
        with self.broker.connect() as db:
            self.assertEqual(db.execute('SELECT state FROM requests WHERE id=?', (request['id'],)).fetchone()[0],
                             'cancelled')
            self.assertEqual(db.execute('SELECT revoked FROM clips WHERE device_id=?', (self.device,)).fetchone()[0], 1)

    def test_more_than_ten_connect_disconnect_cycles_reuse_active_folder_quota(self):
        self.assertEqual(self.client.delete(self.base, headers=self.headers).status_code, 200)
        for index in range(12):
            key = hashlib.sha256(str(index).encode()).hexdigest()
            response = self.client.post('/v1/browser-materials/connect', headers=self.headers,
                json={'folder_key': key, 'name': '素材 ' + str(index)})
            self.assertEqual(response.status_code, 200, response.text)
            device = response.json()['device_id']
            self.assertEqual(self.client.delete('/v1/browser-materials/devices/' + device,
                                                headers=self.headers).status_code, 200)
        self.assertEqual(self.broker.status(self.owner)['devices'], [])

    def test_heartbeat_waiting_for_transfer_lock_does_not_block_shared_event_loop(self):
        heartbeat_done, health_done = threading.Event(), threading.Event()
        responses = {}
        with TestClient(self.app) as client:
            self.assertEqual(client.get('/health', headers=self.headers).status_code, 200)
            def heartbeat():
                try:
                    responses['heartbeat'] = client.post(self.base + '/heartbeat',
                        headers=self.headers, json={'status': 'ready'})
                finally:
                    heartbeat_done.set()
            def health():
                try:
                    responses['health'] = client.get('/health', headers=self.headers)
                finally:
                    health_done.set()
            self.adapter.transfer_lock.acquire()
            waiting = threading.Thread(target=heartbeat)
            probe = threading.Thread(target=health)
            try:
                waiting.start()
                self.assertFalse(heartbeat_done.wait(.2), 'Heartbeat must be waiting for the held transfer lock')
                probe.start()
                responsive = health_done.wait(.75)
            finally:
                self.adapter.transfer_lock.release()
                waiting.join(5)
                if probe.ident is not None:
                    probe.join(5)
            self.assertTrue(responsive, 'A blocked heartbeat must not prevent unrelated routes from running')
            self.assertEqual(responses['health'].status_code, 200)
            self.assertEqual(responses['heartbeat'].status_code, 200)

    def test_routes_require_admin_owner_and_membership(self):
        other = {**self.headers, 'X-Material-Owner': 'e' * 64}
        request_id, upload_id = '1' * 32, '2' * 32
        operations = [('post', '/heartbeat', {}), ('post', '/clips', {'clips': [self.clip]}),
            ('delete', '/assets/' + self.clip['asset_id'], None),
            ('post', '/analyze', {'clip_id': self.clip['id'], 'frames': self.frames()}),
            ('get', '/requests', None), ('post', '/requests/' + request_id + '/frames', {}),
            ('post', '/requests/' + request_id + '/file', {'size': 5}),
            ('head', '/files/' + upload_id, None), ('patch', '/files/' + upload_id, None),
            ('post', '/files/' + upload_id + '/complete', None)]
        for method, suffix, body in operations:
            kwargs = {'json': body} if body is not None else {}
            with self.subTest(method=method, suffix=suffix):
                self.assertEqual(getattr(self.client, method)(self.base + suffix, headers=other,
                                                               **kwargs).status_code, 404)
        self.assertEqual(self.client.get(self.base + '/requests').status_code, 401)
        self.assertEqual(self.client.get(self.base + '/requests',
            headers={'Authorization': self.headers['Authorization']}).status_code, 401)
        self.assertEqual(self.client.post('/v1/browser-materials/connect', headers=self.headers,
            json={'folder_key': '../bad', 'name': '素材'}).status_code, 400)

    def test_real_frames_are_encoded_for_models_and_unchanged_clips_reuse_index(self):
        model = Mock()
        def embed(*, video):
            self.assertAlmostEqual(media.duration(video), 2, delta=.05)
            info = json.loads(media.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
                '-show_entries', 'stream=avg_frame_rate', '-of', 'json', str(video)]))
            self.assertEqual(info['streams'][0]['avg_frame_rate'], '1/1')
            return [1, 0]
        model.embed.side_effect = embed
        self.analyze(model)
        self.analyze(model)
        self.assertEqual(model.embed.call_count, 1)
        self.assertEqual(model.json.call_count, 1)
        self.assertEqual(self.broker.indexed_clips(self.device)[0]['description'], '蓝色游泳池')
        self.assertEqual(list(self.broker.folder.rglob('*.mp4')), [])
        self.assertEqual(list(self.broker.folder.rglob('*.jpg')), [])

    def test_failed_description_retry_keeps_saved_vector_and_cleans_frames(self):
        together = threading.Barrier(2)
        model = Mock()

        def embed(*, video):
            together.wait(3)
            return [1, 0]

        def describe(*args):
            if model.json.call_count == 1:
                together.wait(3)
                raise RuntimeError('provider interrupted')
            return {'description': '蓝色'}

        model.embed.side_effect = embed
        model.json.side_effect = describe
        with patch('api.Models', return_value=model):
            first = self.client.post(self.base + '/analyze', headers=self.headers,
                json={'clip_id': self.clip['id'], 'frames': self.frames()})
            self.assertEqual(first.status_code, 503)
            with self.broker.connect() as db:
                clip = db.execute('SELECT * FROM clips WHERE id=?', (self.clip['id'],)).fetchone()
                self.assertEqual(db.execute('SELECT count(*) FROM browser_analysis').fetchone()[0], 0)
            self.assertEqual(clip['state'], 'error')
            self.assertIsNotNone(clip['vector'])
            self.assertEqual(json.loads(clip['vector']), [1, 0])
            self.assertIsNone(clip['description'])
            self.assertEqual(self.broker.indexed_clips(self.device), [])
            self.assertEqual(list(self.broker.folder.rglob('*.mp4')), [])
            second = self.client.post(self.base + '/analyze', headers=self.headers,
                json={'clip_id': self.clip['id'], 'frames': self.frames()})
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(model.embed.call_count, 1)
        self.assertEqual(model.json.call_count, 2)
        self.assertEqual(list(self.broker.folder.rglob('*.mp4')), [])

    def test_failed_vector_retry_keeps_saved_description_and_cleans_frames(self):
        together = threading.Barrier(2)
        model = Mock()

        def embed(*, video):
            if model.embed.call_count == 1:
                together.wait(3)
                raise RuntimeError('provider interrupted')
            return [1, 0]

        def describe(*args):
            together.wait(3)
            return {'description': '蓝色'}

        model.embed.side_effect = embed
        model.json.side_effect = describe
        with patch('api.Models', return_value=model):
            first = self.client.post(self.base + '/analyze', headers=self.headers,
                json={'clip_id': self.clip['id'], 'frames': self.frames()})
            self.assertEqual(first.status_code, 503)
            with self.broker.connect() as db:
                clip = db.execute('SELECT * FROM clips WHERE id=?', (self.clip['id'],)).fetchone()
                self.assertEqual(db.execute('SELECT count(*) FROM browser_analysis').fetchone()[0], 0)
            self.assertEqual(clip['state'], 'error')
            self.assertIsNone(clip['vector'])
            self.assertEqual(clip['description'], '蓝色')
            self.assertEqual(self.broker.indexed_clips(self.device), [])
            self.assertEqual(list(self.broker.folder.rglob('*.mp4')), [])
            second = self.client.post(self.base + '/analyze', headers=self.headers,
                json={'clip_id': self.clip['id'], 'frames': self.frames()})
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(model.embed.call_count, 2)
        self.assertEqual(model.json.call_count, 1)
        self.assertEqual(list(self.broker.folder.rglob('*.mp4')), [])

    def test_concurrent_analysis_has_one_atomic_lease(self):
        started, release = threading.Event(), threading.Event()
        model = Mock()
        def embed(*, video):
            started.set()
            self.assertTrue(release.wait(5))
            return [1, 0]
        model.embed.side_effect = embed
        model.json.return_value = {'description': '蓝色'}
        result = []
        def first():
            result.append(self.client.post(self.base + '/analyze', headers=self.headers,
                json={'clip_id': self.clip['id'], 'frames': self.frames()}))
        with patch('api.Models', return_value=model):
            worker = threading.Thread(target=first)
            worker.start()
            self.assertTrue(started.wait(5))
            with self.broker.connect() as db:
                db.execute('UPDATE browser_analysis SET expires=0')
            second = self.client.post(self.base + '/analyze', headers=self.headers,
                json={'clip_id': self.clip['id'], 'frames': self.frames()})
            release.set()
            worker.join(5)
        self.assertEqual(second.status_code, 409)
        self.assertEqual(result[0].status_code, 200)
        self.assertEqual(model.embed.call_count, 1)

    def test_invalid_frames_and_body_bounds_do_not_call_models(self):
        with patch('api.Models') as model:
            for frames in ([], self.frames(count=1), ['data:image/jpeg;base64,eA=='] * 2,
                           self.frames(size=(641, 64))):
                response = self.client.post(self.base + '/analyze', headers=self.headers,
                    json={'clip_id': self.clip['id'], 'frames': frames})
                self.assertEqual(response.status_code, 400, response.text)
            self.assertEqual(self.client.post(self.base + '/clips', headers=self.headers,
                                               content=b'x' * 262145).status_code, 413)
        model.assert_not_called()

    def test_chunks_validate_digest_offset_and_resume_actual_persisted_size(self):
        self.analyze()
        request = self.request()
        content = self.source()
        result = self.client.post(self.base + '/requests/' + request['id'] + '/file',
                                 headers=self.headers, json={'size': len(content)}).json()
        url = self.base + '/files/' + result['id']
        chunk = content[:100]
        headers = {**self.headers, 'Upload-Offset': '0', 'Upload-Checksum': '0' * 64}
        self.assertEqual(self.client.patch(url, headers=headers, content=chunk).status_code, 422)
        headers['Upload-Checksum'] = hashlib.sha256(chunk).hexdigest()
        self.assertEqual(self.client.patch(url, headers=headers, content=chunk).json()['offset'], 100)
        self.assertEqual(self.client.patch(url, headers=headers, content=chunk).status_code, 409)
        with self.broker.connect() as db:
            db.execute('UPDATE browser_files SET offset=0 WHERE id=?', (result['id'],))
        self.assertEqual(self.client.head(url, headers=self.headers).headers['Upload-Offset'], '100')
        resume = self.client.post(self.base + '/requests/' + request['id'] + '/file',
                                 headers=self.headers, json={'size': len(content)}).json()
        self.assertEqual(resume, {'id': result['id'], 'offset': 100})
        self.assertEqual(self.client.post(url + '/complete', headers=self.headers).status_code, 409)

    def test_full_source_extracts_zero_based_segment_and_cached_file_fulfils_new_request(self):
        self.analyze()
        request = self.request()
        url = self.transfer(request, self.source())
        self.assertEqual(self.client.post(url + '/complete', headers=self.headers).status_code, 200)
        clip_path = self.broker.wait_clip(request['id'], timeout=0)
        self.assertAlmostEqual(media.duration(clip_path), 2, delta=.05)
        raw = self.root / 'pixel.rgb'
        media.run(['ffmpeg', '-v', 'error', '-y', '-i', str(clip_path), '-frames:v', '1',
                   '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', str(raw)])
        r, g, b = raw.read_bytes()
        self.assertGreater(b, r + 100, 'Source seek must begin at the requested blue interval')
        packet = json.loads(media.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'packet=pts_time', '-read_intervals', '%+#1', '-of', 'json', str(clip_path)]))
        self.assertAlmostEqual(float(packet['packets'][0]['pts_time']), 0, delta=.001)
        later = self.request(job='2' * 32)
        self.assertEqual(self.client.get(self.base + '/requests', headers=self.headers).json(), {'requests': []})
        self.assertTrue(self.broker.wait_clip(later['id'], timeout=0).is_file())

    def test_proxy_request_uses_frames_without_paid_analysis(self):
        self.analyze()
        request = self.request(kind='proxy')
        with patch('api.Models') as models:
            response = self.client.post(self.base + '/requests/' + request['id'] + '/frames',
                                       headers=self.headers, json={'frames': self.frames()})
        self.assertEqual(response.status_code, 200, response.text)
        models.assert_not_called()
        self.assertAlmostEqual(media.duration(self.broker.wait_clip(request['id'], timeout=0)), 2, delta=.05)

    def assert_source_pixels_preserved(self, hdr=False, fps=25):
        source = self.root / 'detailed-source.mp4'
        color_flags = (['-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67',
                        '-colorspace', 'bt2020nc', '-color_range', 'tv'] if hdr else media.SDR_FLAGS)
        media.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i',
                   f'testsrc2=s=64x64:r={fps}:d=4', '-c:v', 'libx264', '-crf', '0',
                   '-pix_fmt', 'yuv420p10le' if hdr else 'yuv420p', *color_flags, str(source)])
        original_hash = hashlib.sha256(source.read_bytes()).hexdigest()
        self.analyze()
        request = self.request()
        url = self.transfer(request, source.read_bytes())
        self.assertEqual(self.client.post(url + '/complete', headers=self.headers).status_code, 200)
        extracted = self.broker.wait_clip(request['id'], timeout=0)
        color_filter, _ = media.sdr_filter(media.video_color(source))
        expected, actual = self.root / 'expected.md5', self.root / 'actual.md5'
        media.run(['ffmpeg', '-v', 'error', '-y', '-ss', '1', '-i', str(source), '-t', '2',
                   '-an', '-vf', 'fps=25,' + color_filter, '-pix_fmt', 'yuv420p', '-f', 'framemd5', str(expected)])
        media.run(['ffmpeg', '-v', 'error', '-y', '-i', str(extracted), '-an',
                   '-pix_fmt', 'yuv420p', '-f', 'framemd5', str(actual)])
        hashes = lambda path: [line.rsplit(',', 1)[1].strip() for line in path.read_text().splitlines()
                               if line and not line.startswith('#')]
        self.assertEqual(hashes(actual), hashes(expected), 'Source transfer must retain every converted pixel')
        self.assertEqual(media.video_color(extracted), {
            'color_range': 'tv', 'color_space': 'bt709', 'color_transfer': 'bt709', 'color_primaries': 'bt709'})
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), original_hash)

    def test_source_transfer_preserves_sdr_pixels_without_extra_lossy_encode(self):
        self.assert_source_pixels_preserved()

    def test_source_transfer_tone_maps_10bit_hdr_before_quantizing_to_sdr(self):
        self.assert_source_pixels_preserved(hdr=True)

    def test_source_transfer_normalizes_60fps_hdr_to_export_rate(self):
        self.assert_source_pixels_preserved(hdr=True, fps=60)

    def assert_source_fits_export(self, size, expected):
        source = self.root / '4k-source.mp4'
        media.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i',
                   f'color=c=blue:s={size}:r=1:d=4', '-c:v', 'libx264', '-threads', '2',
                   '-crf', '0', '-pix_fmt', 'yuv420p', *media.SDR_FLAGS, str(source)])
        self.analyze()
        request = self.request()
        url = self.transfer(request, source.read_bytes())
        self.assertEqual(self.client.post(url + '/complete', headers=self.headers).status_code, 200)
        extracted = self.broker.wait_clip(request['id'], timeout=0)
        info = self.adapter.video_info(extracted)
        self.assertEqual((info['width'], info['height']), expected)
        self.assertAlmostEqual(media.duration(extracted), 2, delta=.05)

    def test_source_transfer_bounds_landscape_4k_to_supported_export(self):
        self.assert_source_fits_export('3840x2160', (1920, 1080))

    def test_source_transfer_bounds_portrait_4k_to_supported_export(self):
        self.assert_source_fits_export('2160x3840', (1080, 1920))

    def test_source_cache_counts_with_broker_quota_and_removal_deletes_all_copies(self):
        self.analyze()
        content = self.source()
        request = self.request()
        with patch.object(local_materials, 'DEVICE_QUOTA', len(content) + 1):
            result = self.client.post(self.base + '/requests/' + request['id'] + '/file',
                                     headers=self.headers, json={'size': len(content)})
            self.assertEqual(result.status_code, 200, result.text)
            with self.assertRaises(HTTPException) as quota:
                self.broker.begin_upload(self.device, self.clip['id'], 'proxy', 2, '0' * 64)
            self.assertEqual(quota.exception.status_code, 429)
        url = self.transfer(request, content)
        self.assertEqual(self.client.post(url + '/complete', headers=self.headers).status_code, 200)
        copied = self.root / 'outputs' / ('1' * 32) / 'inputs' / (self.clip['id'] + '.mp4')
        copied.parent.mkdir(parents=True)
        copied.write_bytes(b'input-copy')
        self.assertEqual(self.client.delete(self.base + '/assets/' + self.clip['asset_id'],
                                           headers=self.headers).status_code, 200)
        self.assertFalse(copied.exists())
        self.assertEqual(list(self.broker.folder.rglob('*.mp4')), [])

    def test_file_ttl_removes_cache_and_upload_is_retryable(self):
        self.analyze()
        content = self.source()
        request = self.request()
        url = self.transfer(request, content)
        with self.broker.connect() as db:
            db.execute('UPDATE browser_files SET expires=0')
        self.adapter.cleanup()
        self.assertEqual(self.client.head(url, headers=self.headers).status_code, 410)
        self.assertEqual(list(self.broker.folder.rglob('*.mp4')), [])
        resumed = self.client.post(self.base + '/requests/' + request['id'] + '/file',
                                  headers=self.headers, json={'size': len(content)})
        self.assertEqual(resumed.status_code, 200)
        self.assertEqual(resumed.json()['offset'], 0)

    def test_full_source_expires_in_24_hours_while_active_job_copies_follow_broker_lifetime(self):
        self.analyze()
        request = self.request()
        url = self.transfer(request, self.source())
        self.assertEqual(self.client.post(url + '/complete', headers=self.headers).status_code, 200)
        copied = self.root / 'outputs' / ('1' * 32) / 'inputs' / (self.clip['id'] + '.mp4')
        copied.parent.mkdir(parents=True)
        copied.write_bytes(b'input-copy')
        with patch('browser_materials.time.time', return_value=time.time() + local_materials.UPLOAD_TTL + 1):
            self.adapter.cleanup()
        self.assertTrue(copied.exists())
        self.assertEqual(list(self.adapter.folder.rglob('*.mp4')), [])
        self.assertTrue(self.broker.wait_clip(request['id'], timeout=0).is_file())
        self.assertEqual(len(self.broker.indexed_clips(self.device)), 1)

    def test_terminal_job_cleanup_removes_source_and_broker_input_copies(self):
        self.analyze()
        job_id = '1' * 32
        request = self.request(job=job_id)
        url = self.transfer(request, self.source())
        self.assertEqual(self.client.post(url + '/complete', headers=self.headers).status_code, 200)
        with self.app.state.jobs.connect() as db:
            db.execute("INSERT INTO jobs (id,request_key,owner,spec,state,created,updated,logs) VALUES(?,?,?,'{}','done',0,0,'[]')",
                       (job_id, 'cleanup-test', self.owner))
        inputs = self.root / 'outputs' / job_id / 'inputs'
        inputs.mkdir(parents=True)
        (inputs / (self.clip['id'] + '.mp4')).write_bytes(b'copy')
        self.adapter.cleanup()
        self.assertFalse(inputs.exists())
        self.assertEqual(list(self.broker.folder.rglob('*.mp4')), [])

    def test_restart_releases_old_analysis_lease_retains_vector_and_removes_orphan_payloads(self):
        orphan = self.adapter.folder / ('frames-' + '0' * 32 + '-orphan')
        orphan.mkdir()
        (orphan / 'analysis.mp4').write_bytes(b'interrupted-analysis')
        with self.broker.connect() as db:
            db.execute("UPDATE clips SET state='indexing',vector='[1,0]'")
            db.execute('INSERT INTO browser_analysis VALUES(?,?,?,?,?)',
                (self.device, self.clip['id'], '1' * 32, 'previous-process', time.time() + 900))
        browser_materials.BrowserMaterials(self.broker)
        self.assertFalse(orphan.exists())
        model = self.analyze()
        model.embed.assert_not_called()
        model.json.assert_called_once()

    def test_restored_unchanged_asset_reuses_index_but_old_requests_stay_cancelled(self):
        self.analyze()
        old = self.request()
        self.client.delete(self.base + '/assets/' + self.clip['asset_id'], headers=self.headers)
        response = self.client.post(self.base + '/clips', headers=self.headers, json={'clips': [self.clip]})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['clips'][0]['state'], 'indexed')
        with patch('api.Models') as model:
            response = self.client.post(self.base + '/analyze', headers=self.headers,
                json={'clip_id': self.clip['id'], 'frames': self.frames()})
        self.assertEqual(response.status_code, 200)
        model.assert_not_called()
        with self.broker.connect() as db:
            self.assertEqual(db.execute('SELECT state FROM requests WHERE id=?', (old['id'],)).fetchone()[0], 'cancelled')
        self.client.delete(self.base + '/assets/' + self.clip['asset_id'], headers=self.headers)
        with self.assertRaises(HTTPException):
            self.broker.register_clips(self.device, [self.clip])
        changed = {**self.clip, 'name': 'changed.mp4'}
        self.assertEqual(self.client.post(self.base + '/clips', headers=self.headers,
                                          json={'clips': [changed]}).status_code, 409)

    def test_source_limits_kind_and_duration_are_validated(self):
        self.analyze()
        request = self.request()
        file_url = self.base + '/requests/' + request['id'] + '/file'
        for size in (True, 0, local_materials.MAX_SOURCE + 1):
            self.assertEqual(self.client.post(file_url, headers=self.headers, json={'size': size}).status_code, 400)
        self.assertEqual(self.client.post(self.base + '/requests/' + request['id'] + '/frames',
            headers=self.headers, json={'frames': self.frames()}).status_code, 409)
        short = self.root / 'short.mp4'
        media.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i',
                   'color=c=blue:s=64x64:r=25', '-t', '1', '-an', '-c:v', 'libx264', str(short)])
        url = self.transfer(request, short.read_bytes())
        self.assertEqual(self.client.post(url + '/complete', headers=self.headers).status_code, 422)
        self.assertEqual(list(self.broker.folder.rglob('*.mp4')), [])

    def test_source_complete_validates_video_even_if_job_request_is_already_fulfilled(self):
        self.analyze()
        request = self.request()
        url = self.transfer(request, self.source())
        self.assertEqual(self.client.post(url + '/complete', headers=self.headers).status_code, 200)
        with self.broker.connect() as db:
            db.execute('UPDATE browser_files SET expires=0')
        self.adapter.cleanup()
        invalid = self.transfer(request, b'not-a-video')
        self.assertEqual(self.client.post(invalid + '/complete', headers=self.headers).status_code, 422)


if __name__ == '__main__':
    unittest.main()
