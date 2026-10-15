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

    def analysis_source(self, clip=None):
        response = self.client.post(self.base + '/analysis-source', headers=self.headers,
                                    json={'clip_id': (clip or self.clip)['id']})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_analysis_proxy_is_native_small_silent_and_raw_cache_is_released(self):
        source = self.root / 'original.mov'
        media.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                   'testsrc2=s=1280x720:r=60:d=4', '-f', 'lavfi', '-i', 'sine=duration=4',
                   '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', str(source)])
        content = source.read_bytes()
        before = hashlib.sha256(content).hexdigest()
        prepared = self.analysis_source()
        self.assertFalse(prepared['source_ready'])
        self.assertEqual(prepared['request']['kind'], 'analysis')
        self.assertEqual(self.analysis_source(), prepared)
        self.assertEqual(self.client.get(self.base + '/requests', headers=self.headers).json(), {'requests': []})
        url, sent = self.sparse_transfer(prepared['request'], content)
        with patch('api.Models') as models:
            response = self.client.post(url + '/complete', headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        models.assert_not_called()
        path = self.broker.wait_clip(prepared['request']['id'], timeout=0)
        info = json.loads(media.run(['ffprobe', '-v', 'error', '-show_streams', '-of', 'json', str(path)]))
        self.assertEqual(len(info['streams']), 1)
        video = info['streams'][0]
        self.assertEqual((video['codec_name'], video['avg_frame_rate'], video['width'], video['height']),
                         ('h264', '1/1', 640, 360))
        self.assertEqual(video['color_space'], 'bt709')
        self.assertAlmostEqual(media.duration(path), 2, delta=.05)
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), before)
        self.assertTrue(self.analysis_source()['source_ready'])
        self.assertEqual(self.client.head(url, headers=self.headers).status_code, 410)
        self.assertEqual(list(self.adapter.folder.glob('*.mp4')), [])
        restarted = browser_materials.BrowserMaterials(self.broker)
        self.assertTrue(restarted.analysis_source(self.device, self.clip['id'])['source_ready'])

    def test_analysis_proxy_survives_partial_model_retry_without_transfer_or_device_lock(self):
        prepared = self.analysis_source()
        url = self.transfer(prepared['request'], self.source())
        self.assertEqual(self.client.post(url + '/complete', headers=self.headers).status_code, 200)
        path = self.broker.wait_clip(prepared['request']['id'], timeout=0)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        model, together = Mock(), threading.Barrier(2)
        def embed(*, video):
            self.assertEqual(Path(video), path)
            lock = self.adapter.device_lock(self.device)
            self.assertTrue(lock.acquire(blocking=False), 'paid model must not hold the transfer lock')
            lock.release()
            together.wait(5)
            return [1, 0]
        def describe(*args, **kwargs):
            if model.json.call_count == 1:
                together.wait(5)
                raise RuntimeError('provider interrupted')
            return {'description': 'blue'}
        model.embed.side_effect, model.json.side_effect = embed, describe
        body = {'clip_id': self.clip['id'], 'source_request_id': prepared['request']['id']}
        with patch('api.Models', return_value=model):
            self.assertEqual(self.client.post(self.base + '/analyze', headers=self.headers, json=body).status_code, 503)
            self.assertTrue(self.analysis_source()['source_ready'])
            result = self.client.post(self.base + '/analyze', headers=self.headers, json=body)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual((model.embed.call_count, model.json.call_count), (1, 2))
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), digest)
        self.assertEqual(self.analysis_source(), {'complete': True})

    def test_analysis_request_checks_owner_clip_kind_and_live_file(self):
        prepared = self.analysis_source()
        request = prepared['request']
        other = {**self.headers, 'X-Material-Owner': 'e' * 64}
        self.assertEqual(self.client.post(self.base + '/analysis-source', headers=other,
            json={'clip_id': self.clip['id']}).status_code, 404)
        body = {'clip_id': self.clip['id'], 'source_request_id': request['id']}
        self.assertEqual(self.client.post(self.base + '/analyze', headers=self.headers, json=body).status_code, 409)
        later = {**self.clip, 'id': 'e' * 64, 'start': 0, 'end': 1}
        self.broker.register_clips(self.device, [later])
        with patch('api.Models') as models:
            self.assertEqual(self.client.post(self.base + '/analyze', headers=self.headers,
                json={**body, 'clip_id': later['id']}).status_code, 409)
            with self.broker.connect() as db:
                db.execute("UPDATE requests SET kind='source' WHERE id=?", (request['id'],))
            self.assertEqual(self.client.post(self.base + '/analyze', headers=self.headers, json=body).status_code, 409)
        models.assert_not_called()

    def test_analysis_missing_expired_and_revoked_proxies_recover_without_losing_index(self):
        first = self.analysis_source()['request']
        url = self.transfer(first, self.source())
        self.assertEqual(self.client.post(url + '/complete', headers=self.headers).status_code, 200)
        self.broker.wait_clip(first['id'], timeout=0).unlink()
        second = self.analysis_source()
        self.assertFalse(second['source_ready'])
        self.assertNotEqual(first['id'], second['request']['id'])
        with self.broker.connect() as db:
            db.execute('UPDATE requests SET expires=0 WHERE id=?', (second['request']['id'],))
        third = self.analysis_source()
        self.assertNotEqual(second['request']['id'], third['request']['id'])
        self.assertEqual(self.client.delete(self.base + '/assets/' + self.clip['asset_id'], headers=self.headers).status_code, 200)
        self.assertEqual(self.client.post(self.base + '/analyze', headers=self.headers,
            json={'clip_id': self.clip['id'], 'source_request_id': third['request']['id']}).status_code, 410)

    def test_analysis_proxy_does_not_replace_source_export_or_evict_render_raw_cache(self):
        prepared = self.analysis_source()
        content = self.source()
        url = self.transfer(prepared['request'], content)
        self.assertEqual(self.client.post(url + '/complete', headers=self.headers).status_code, 200)
        proxy = self.broker.wait_clip(prepared['request']['id'], timeout=0)
        self.analyze()
        source_request = self.request()
        url = self.transfer(source_request, content)
        self.assertEqual(self.client.post(url + '/complete', headers=self.headers).status_code, 200)
        exported = self.broker.wait_clip(source_request['id'], timeout=0)
        self.assertNotEqual(proxy, exported)
        self.assertGreater(len(self.frame_hashes(exported)), len(self.frame_hashes(proxy)))
        self.assertEqual(self.client.head(url, headers=self.headers).status_code, 200)
        with self.broker.connect() as db:
            db.execute('UPDATE requests SET expires=0 WHERE kind=\'analysis\'')
        self.adapter.cleanup()
        self.assertFalse(proxy.exists())
        self.assertTrue(exported.exists())
        self.assertEqual(len(self.broker.indexed_clips(self.device)), 1)

    def test_render_preview_reuses_analysis_proxy_and_never_accepts_it_as_an_analysis_request(self):
        prepared = self.analysis_source()
        url = self.transfer(prepared['request'], self.source())
        self.assertEqual(self.client.post(url + '/complete', headers=self.headers).status_code, 200)
        proxy = self.broker.wait_clip(prepared['request']['id'], timeout=0)
        self.analyze()
        preview = self.request(kind='proxy')
        self.assertEqual(self.client.get(self.base + '/requests', headers=self.headers).json(), {'requests': []})
        self.assertEqual(proxy.read_bytes(), self.broker.wait_clip(preview['id'], timeout=0).read_bytes())
        with patch('api.Models') as models:
            response = self.client.post(self.base + '/analyze', headers=self.headers,
                json={'clip_id': self.clip['id'], 'source_request_id': preview['id']})
        self.assertEqual(response.status_code, 409)
        models.assert_not_called()

    def test_render_poller_does_not_wait_on_native_proxy_transfer(self):
        lock = self.adapter.device_lock(self.device)
        lock.acquire()
        finished = threading.Event()
        def poll():
            self.adapter.requests(self.device)
            finished.set()
        worker = threading.Thread(target=poll)
        try:
            worker.start()
            self.assertTrue(finished.wait(1), 'request polling must not wait behind native decoding')
        finally:
            lock.release()
            worker.join(5)

    def test_subsecond_analysis_proxy_has_a_complete_frame(self):
        short = {**self.clip, 'id': 'e' * 64, 'start': 3.9, 'end': 4}
        self.broker.register_clips(self.device, [short])
        prepared = self.analysis_source(short)
        url = self.transfer(prepared['request'], self.source())
        response = self.client.post(url + '/complete', headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        proxy = self.broker.wait_clip(prepared['request']['id'], timeout=0)
        self.assertEqual(len(self.frame_hashes(proxy)), 1)

    def test_restart_releases_raw_bytes_left_after_analysis_proxy_commit(self):
        request = self.analysis_source()['request']
        content = self.source()
        url = self.transfer(request, content)
        self.assertEqual(self.client.post(url + '/complete', headers=self.headers).status_code, 200)
        with self.broker.connect() as db:
            raw = Path(db.execute('SELECT path FROM browser_files').fetchone()[0])
            raw.write_bytes(content)
            db.execute("UPDATE browser_files SET state='uploading'")
        browser_materials.BrowserMaterials(self.broker)
        self.assertFalse(raw.exists())
        self.assertTrue(self.analysis_source()['source_ready'])

    def test_interrupted_native_proxy_finalization_can_retry(self):
        request = self.analysis_source()['request']
        content = self.source()
        url = self.transfer(request, content)
        self.assertEqual(self.client.post(url + '/complete', headers=self.headers).status_code, 200)
        # Crash after writing a valid upload, before its processing transaction committed.
        with self.broker.connect() as db:
            db.execute("UPDATE requests SET state='pending',path=NULL WHERE id=?", (request['id'],))
            db.execute("UPDATE uploads SET state='processing' WHERE request_id=?", (request['id'],))
        self.assertFalse(self.analysis_source()['source_ready'])
        again = self.transfer(request, content)
        response = self.client.post(again + '/complete', headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(self.analysis_source()['source_ready'])

    def test_analysis_source_rejects_other_device_and_changed_clip_version(self):
        request = self.analysis_source()['request']
        other = self.connect(key='f' * 64)['device_id']
        self.broker.register_clips(other, [self.clip])
        body = {'clip_id': self.clip['id'], 'source_request_id': request['id']}
        self.assertEqual(self.client.post('/v1/browser-materials/devices/' + other + '/analyze',
                                         headers=self.headers, json=body).status_code, 404)
        with self.broker.connect() as db:
            db.execute('UPDATE requests SET start=0 WHERE id=?', (request['id'],))
        self.assertEqual(self.client.post(self.base + '/analyze', headers=self.headers, json=body).status_code, 410)

    def test_analysis_transfer_replaces_expired_raw_cache_before_throttled_cleanup(self):
        request = self.analysis_source()['request']
        content = self.source()
        url = self.transfer(request, content)
        with self.broker.connect() as db:
            db.execute('UPDATE browser_files SET expires=0')
        self.adapter._last_cleanup = time.time()
        response = self.client.post(self.base + '/requests/' + request['id'] + '/file',
                                   headers=self.headers, json={'size': len(content)})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotEqual(response.json()['id'], url.split('/')[-1])
        self.assertEqual(response.json()['offset'], 0)

    def test_render_source_bytes_survive_analysis_of_another_clip_of_same_asset(self):
        self.analyze()
        source_request = self.request()
        content = self.source()
        source_url = self.transfer(source_request, content)
        self.assertEqual(self.client.post(source_url + '/complete', headers=self.headers).status_code, 200)
        later = {**self.clip, 'id': 'e' * 64, 'start': 0, 'end': 1}
        self.broker.register_clips(self.device, [later])
        request = self.analysis_source(later)['request']
        # The browser prefers sparse transfer for analysis, including small MOV/MP4 files.
        sparse = self.client.post(self.base + '/requests/' + request['id'] + '/sparse', headers=self.headers,
                                  json={'size': len(content), 'ranges': self.index_ranges(content)})
        self.assertEqual(sparse.status_code, 422, 'a cached full source must route back to resumable full transfer')
        segment = self.client.post(self.base + '/requests/' + request['id'] + '/segment', headers=self.headers,
                                   json={'size': 100, 'origin': 0})
        self.assertEqual(segment.status_code, 422, 'a segment fallback must also preserve cached render source bytes')
        # The raw full-file cache is already complete: native proxy preparation reuses it.
        begin = self.client.post(self.base + '/requests/' + request['id'] + '/file', headers=self.headers,
                                 json={'size': len(content)})
        self.assertEqual(begin.json()['offset'], len(content))
        self.assertEqual(self.client.post(source_url + '/complete', headers=self.headers).status_code, 200)
        self.assertTrue(self.analysis_source(later)['source_ready'])
        self.assertEqual(self.client.head(source_url, headers=self.headers).status_code, 200)
        self.assertTrue(self.broker.wait_clip(source_request['id'], timeout=0).exists())

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

    def test_heartbeat_never_waits_for_a_folder_transfer_and_keeps_its_file(self):
        self.analyze()
        request = self.request()
        content = self.source()
        upload = self.client.post(self.base + '/requests/' + request['id'] + '/file',
                                  headers=self.headers, json={'size': len(content)}).json()
        with self.broker.connect() as db:
            db.execute('UPDATE browser_files SET expires=0')
            path = Path(db.execute('SELECT path FROM browser_files').fetchone()[0])
        lock = self.adapter.device_lock(self.device)
        lock.acquire()
        try:
            self.adapter._last_cleanup = None
            started = time.monotonic()
            response = self.client.post(self.base + '/heartbeat', headers=self.headers, json={'status': 'ready'})
            elapsed = time.monotonic() - started
            self.assertTrue(path.exists(), 'Cleanup must skip a folder whose transfer holds its lock')
        finally:
            lock.release()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertLess(elapsed, 2)
        self.adapter.cleanup()
        self.assertFalse(path.exists())
        self.assertEqual(self.client.head(self.base + '/files/' + upload['id'], headers=self.headers).status_code, 410)

    def test_transfers_of_different_folders_use_independent_locks(self):
        other = self.connect(key='f' * 64)['device_id']
        self.assertIsNot(self.adapter.device_lock(self.device), self.adapter.device_lock(other))
        self.assertIs(self.adapter.device_lock(self.device), self.adapter.device_lock(self.device))

    def test_hot_path_cleanup_is_throttled_but_explicit_cleanup_is_immediate(self):
        with patch.object(self.adapter, '_cleanup', wraps=self.adapter._cleanup) as scan:
            self.adapter._last_cleanup = time.time()
            self.adapter.maybe_cleanup()
            scan.assert_not_called()
            self.adapter._last_cleanup = time.time() - local_materials.CLEANUP_INTERVAL - 1
            self.adapter.maybe_cleanup()
            scan.assert_called_once_with(blocking=False)
            self.adapter.cleanup()
            scan.assert_called_with(blocking=True)

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

        def describe(*args, **kwargs):
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
            self.assertEqual(local_materials.unpack_vector(clip['vector']).tolist(), [1, 0])
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

        def describe(*args, **kwargs):
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


    def long_source(self, name='long-source.mp4', seconds=20):
        path = self.root / name
        media.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', f'testsrc2=s=320x240:r=25:d={seconds}',
                   '-f', 'lavfi', '-i', f'sine=frequency=440:sample_rate=48000:duration={seconds}',
                   '-c:v', 'libx264', '-g', '10', '-crf', '0', '-c:a', 'aac', str(path)])
        return path

    @staticmethod
    def index_ranges(content):
        """What the browser sends first: every top-level box except mdat payloads."""
        ranges, offset = [], 0
        while offset + 8 <= len(content):
            size, kind, header = int.from_bytes(content[offset:offset + 4], 'big'), content[offset + 4:offset + 8], 8
            if size == 1:
                size, header = int.from_bytes(content[offset + 8:offset + 16], 'big'), 16
            elif size == 0:
                size = len(content) - offset
            ranges.append([offset, offset + (header if kind == b'mdat' else size)])
            offset += size
        return ranges

    def send_ranges(self, url, content, ranges):
        sent = 0
        for start, end in ranges:
            for offset in range(start, end, local_materials.MAX_CHUNK):
                chunk = content[offset:min(end, offset + local_materials.MAX_CHUNK)]
                response = self.client.patch(url, headers={**self.headers, 'Upload-Offset': str(offset),
                    'Upload-Checksum': hashlib.sha256(chunk).hexdigest()}, content=chunk)
                self.assertEqual(response.status_code, 200, response.text)
                sent += len(chunk)
        return sent

    def sparse_transfer(self, request, content):
        response = self.client.post(self.base + '/requests/' + request['id'] + '/sparse', headers=self.headers,
                                    json={'size': len(content), 'ranges': self.index_ranges(content)})
        self.assertEqual(response.status_code, 200, response.text)
        url = self.base + '/files/' + response.json()['id']
        sent = self.send_ranges(url, content, response.json()['ranges'])
        plan = self.client.post(url + '/plan', headers=self.headers)
        self.assertEqual(plan.status_code, 200, plan.text)
        return url, sent + self.send_ranges(url, content, plan.json()['ranges'])

    def expected_cut(self, source, request, name):
        output = self.root / name
        color_filter, _ = media.sdr_filter(media.video_color(source))
        self.adapter._extract(source, request, request['start'], color_filter, output)
        return output

    def frame_hashes(self, path, streams='0'):
        output = path.with_suffix('.framemd5')
        media.run(['ffmpeg', '-v', 'error', '-y', '-i', str(path), '-map', streams, '-f', 'framemd5', str(output)])
        return [line.rsplit(',', 1)[1].strip() for line in output.read_text().splitlines()
                if line and not line.startswith('#')]

    def test_sparse_source_uploads_only_index_and_needed_packets_and_cuts_identically(self):
        self.analyze()
        source = self.long_source()
        content = source.read_bytes()
        request = self.request()
        url, sent = self.sparse_transfer(request, content)
        self.assertLess(sent, len(content) / 2, 'Only the index and the requested interval may be uploaded')
        self.assertEqual(self.client.post(url + '/complete', headers=self.headers).status_code, 200)
        extracted = self.broker.wait_clip(request['id'], timeout=0)
        expected = self.expected_cut(source, request, 'expected-sparse.mp4')
        self.assertEqual(self.frame_hashes(extracted), self.frame_hashes(expected))
        with self.broker.connect() as db:
            row = db.execute('SELECT mode,size,offset FROM browser_files').fetchone()
        self.assertEqual((row['mode'], row['size']), ('sparse', len(content)))
        self.assertLess(row['offset'], len(content) / 2, 'Quota counts uploaded ranges, not the declared size')

    def test_sparse_source_plans_new_requests_and_never_cuts_unplanned_ranges(self):
        self.analyze()
        later_clip = {'id': 'e' * 64, 'asset_id': self.clip['asset_id'], 'name': 'pool.mp4', 'start': 15, 'end': 17}
        self.assertEqual(self.client.post(self.base + '/clips', headers=self.headers,
                                          json={'clips': [later_clip]}).status_code, 200)
        with self.broker.connect() as db:
            db.execute("UPDATE clips SET state='indexed'")
        source = self.long_source()
        content = source.read_bytes()
        first = self.request()
        url, _ = self.sparse_transfer(first, content)
        unplanned = self.request(job='2' * 32, clip=later_clip)
        self.assertEqual(self.client.post(url + '/complete', headers=self.headers).status_code, 200)
        self.assertTrue(self.broker.wait_clip(first['id'], timeout=0).is_file())
        pending = self.client.get(self.base + '/requests', headers=self.headers).json()['requests']
        self.assertEqual([item['id'] for item in pending], [unplanned['id']])
        again, _ = self.sparse_transfer(unplanned, content)
        self.assertEqual(again, url, 'The same sparse file grows with the new ranges')
        self.assertEqual(self.client.post(url + '/complete', headers=self.headers).status_code, 200)
        extracted = self.broker.wait_clip(unplanned['id'], timeout=0)
        expected = self.expected_cut(source, {**unplanned, 'start': 15, 'end': 17}, 'expected-later.mp4')
        self.assertEqual(self.frame_hashes(extracted), self.frame_hashes(expected))

    def test_sparse_rejects_writes_outside_planned_ranges_and_incomplete_completion(self):
        self.analyze()
        content = self.long_source().read_bytes()
        request = self.request()
        response = self.client.post(self.base + '/requests/' + request['id'] + '/sparse', headers=self.headers,
                                    json={'size': len(content), 'ranges': self.index_ranges(content)})
        url = self.base + '/files/' + response.json()['id']
        self.assertEqual(self.client.post(url + '/plan', headers=self.headers).status_code, 409)
        self.send_ranges(url, content, response.json()['ranges'])
        planned = self.client.post(url + '/plan', headers=self.headers).json()['ranges']
        gaps = [end for (_, end), (start, _) in zip(planned, planned[1:]) if start - end > 10]
        position = gaps[0] + 1 if gaps else planned[-1][1] + 1
        self.assertLess(position + 8, len(content))
        chunk = b'x' * 8
        self.assertEqual(self.client.patch(url, headers={**self.headers, 'Upload-Offset': str(position),
            'Upload-Checksum': hashlib.sha256(chunk).hexdigest()}, content=chunk).status_code, 409)
        self.assertEqual(self.client.post(url + '/complete', headers=self.headers).status_code, 409)
        for bad in ([[0, len(content) + 1]], [], [[5, 5]], 'x'):
            self.assertEqual(self.client.post(self.base + '/requests/' + request['id'] + '/sparse', headers=self.headers,
                                              json={'size': len(content), 'ranges': bad}).status_code, 400)

    def test_unparseable_sparse_index_expires_upload_for_segment_fallback(self):
        self.analyze()
        content = b'\x00\x00\x00\x10ftypisom\x00\x00\x00\x00' + b'\x00' * 64
        request = self.request()
        response = self.client.post(self.base + '/requests/' + request['id'] + '/sparse', headers=self.headers,
                                    json={'size': len(content), 'ranges': [[0, len(content)]]})
        url = self.base + '/files/' + response.json()['id']
        self.send_ranges(url, content, response.json()['ranges'])
        self.assertEqual(self.client.post(url + '/plan', headers=self.headers).status_code, 422)
        self.assertEqual(self.client.head(url, headers=self.headers).status_code, 410)
        self.assertEqual(list(self.adapter.folder.glob('*.mp4')), [])

    def test_wasm_style_stream_copy_segment_keeps_original_timeline(self):
        self.analyze()
        source = self.long_source()
        segment = self.root / 'copy.mkv'
        media.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-ss', '0.5', '-t', '3.5', '-i', str(source),
                   '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-copyts', '-f', 'matroska', str(segment)])
        content = segment.read_bytes()
        request = self.request()
        response = self.client.post(self.base + '/requests/' + request['id'] + '/segment', headers=self.headers,
                                    json={'size': len(content), 'origin': 0})
        self.assertEqual(response.status_code, 200, response.text)
        url = self.base + '/files/' + response.json()['id']
        self.send_ranges(url, content, [[0, len(content)]])
        self.assertEqual(self.client.post(url + '/complete', headers=self.headers).status_code, 200)
        extracted = self.broker.wait_clip(request['id'], timeout=0)
        expected = self.expected_cut(source, request, 'expected-segment.mp4')
        # Video is frame-identical; AAC differs only by decoder warm-up after the earlier seek.
        self.assertEqual(self.frame_hashes(extracted, '0:v'), self.frame_hashes(expected, '0:v'))
        self.assertTrue(media.has_audio(extracted))
        later = self.request(job='2' * 32)
        self.assertEqual(self.client.get(self.base + '/requests', headers=self.headers).json(), {'requests': []})
        self.assertTrue(self.broker.wait_clip(later['id'], timeout=0).is_file())

    def test_segment_that_misses_the_request_is_rejected(self):
        self.analyze()
        source = self.long_source()
        segment = self.root / 'early.mkv'
        media.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-t', '1.5', '-i', str(source),
                   '-map', '0:v:0', '-c', 'copy', '-copyts', '-f', 'matroska', str(segment)])
        content = segment.read_bytes()
        request = self.request()
        for origin in ('0', None, 1e9):
            self.assertEqual(self.client.post(self.base + '/requests/' + request['id'] + '/segment', headers=self.headers,
                json={'size': len(content), 'origin': origin}).status_code, 400)
        response = self.client.post(self.base + '/requests/' + request['id'] + '/segment', headers=self.headers,
                                    json={'size': len(content), 'origin': 0})
        url = self.base + '/files/' + response.json()['id']
        self.send_ranges(url, content, [[0, len(content)]])
        self.assertEqual(self.client.post(url + '/complete', headers=self.headers).status_code, 422)
        self.assertEqual(self.client.get(self.base + '/requests', headers=self.headers).json()['requests'][0]['id'],
                         request['id'])

    def test_jpeg_size_reads_start_of_frame_without_probe(self):
        image = io.BytesIO()
        Image.new('RGB', (37, 21), 'red').save(image, format='JPEG', progressive=True)
        self.assertEqual(browser_materials.jpeg_size(image.getvalue()), (37, 21))
        for content in (b'\xff\xd8\xff\xd9', b'\xff\xd8\x00\x00\x00\x00', b'\xff\xd8\xff\xe0\x00\x01'):
            with self.assertRaises(ValueError):
                browser_materials.jpeg_size(content)

    def test_deferred_analysis_indexes_on_vector_and_queue_completes_description(self):
        import api
        self.adapter.defer_descriptions = True
        model = Mock()
        model.embed.return_value = [1, 0]
        model.json.return_value = {'description': '蓝色游泳池'}
        with patch('api.Models', return_value=model):
            response = self.client.post(self.base + '/analyze', headers=self.headers,
                json={'clip_id': self.clip['id'], 'frames': self.frames()})
            self.assertEqual(response.status_code, 200, response.text)
            model.json.assert_not_called()
            self.assertIsNone(self.broker.indexed_clips(self.device)[0]['description'])
            self.assertEqual(self.broker.describe_backlog(), 1)
            self.assertTrue(self.broker.describe_next())
            self.assertFalse(self.broker.describe_next())
        self.assertEqual(model.json.call_args.kwargs['config'], api.DESCRIBE_CONFIG)
        self.assertEqual(self.broker.indexed_clips(self.device)[0]['description'], '蓝色游泳池')
        self.assertEqual(list((self.broker.folder / 'describe').iterdir()), [])

if __name__ == '__main__':
    unittest.main()
