import hashlib
import importlib
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT.parent / 'services/mix/python')]
try:
    materials = importlib.import_module('local_materials')
except ModuleNotFoundError:
    materials = None

from fastapi import HTTPException
from fastapi.testclient import TestClient


class MaterialBrokerTests(unittest.TestCase):
    def test_abandoned_analysis_becomes_retryable_after_upload_expiry_and_keeps_vector(self):
        uploaded = self.upload('proxy', complete=False)
        with self.broker.connect() as db:
            db.execute("UPDATE clips SET state='indexing',vector='[1,0]'")
            db.execute("UPDATE uploads SET state='processing',expires=0 WHERE id=?", (uploaded['id'],))
        restarted = materials.MaterialBroker(self.root)
        restarted.cleanup()
        response = restarted.register_clips(self.device, [self.clip])
        self.assertEqual(response['clips'][0]['state'], 'pending')
        with restarted.connect() as db:
            self.assertEqual(db.execute('SELECT vector FROM clips').fetchone()[0], '[1,0]')

    def test_request_expiry_removes_paused_jobs_input_copies_before_releasing_quota(self):
        job_id = 'd' * 32
        with self.broker.connect() as db:
            db.execute("UPDATE clips SET state='indexed',description='散步',vector='[1,0]'")
        request = self.broker.request_clip(self.device, self.clip['id'], 'source', job_id)
        staged = self.broker.folder / 'expired-copy.mp4'
        staged.write_bytes(b'original-transfer')
        inputs = self.root / 'outputs' / job_id / 'inputs'
        inputs.mkdir(parents=True)
        copied = inputs / (self.clip['id'] + '.mp4')
        copied.write_bytes(b'job-input-copy')
        final = inputs.parent / 'video.mp4'
        final.write_bytes(b'finished-video')
        with self.broker.connect() as db:
            db.execute("UPDATE requests SET state='complete',path=?,expires=0 WHERE id=?", (str(staged), request['id']))
        self.broker.cleanup()
        self.assertFalse(copied.exists(), 'Expired job inputs must not accumulate outside the cache quota')
        self.assertTrue(final.exists())

    def setUp(self):
        self.assertIsNotNone(materials, 'local material broker is not implemented')
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.broker = materials.MaterialBroker(self.root)
        self.owner = 'a' * 64
        self.device, self.token = self.pair(self.owner)
        self.clip = {'id': 'b' * 64, 'asset_id': 'c' * 64, 'name': 'pool.mp4',
                     'start': 8, 'end': 16}
        self.broker.register_clips(self.device, [self.clip])

    def pair(self, owner):
        pair = self.broker.pair(owner)
        result = self.broker.redeem(pair['code'], '我的电脑')
        return result['device_id'], result['token']

    def indexed(self):
        self.upload(kind='proxy')

    def upload(self, kind, request_id=None, content=b'video', complete=True):
        result = self.broker.begin_upload(self.device, self.clip['id'], kind, len(content),
            hashlib.sha256(content).hexdigest(), request_id)
        self.broker.append_upload(self.device, result['id'], result['offset'], content[result['offset']:])
        if complete:
            model = Mock()
            model.embed.return_value = [1, 0]
            model.json.return_value = {'description': '游泳池画面'}
            with patch('api.Models', return_value=model), patch('media.duration', return_value=8):
                self.broker.complete_upload(self.device, result['id'])
        return result

    def test_pair_is_single_use_expires_and_owner_isolated(self):
        pair = self.broker.pair(self.owner)
        self.broker.redeem(pair['code'], 'desktop')
        with self.assertRaises(HTTPException) as used:
            self.broker.redeem(pair['code'], 'desktop')
        self.assertEqual(used.exception.status_code, 410)
        pair = self.broker.pair(self.owner)
        with patch('local_materials.time.time', return_value=time.time() + 601):
            with self.assertRaises(HTTPException):
                self.broker.redeem(pair['code'], 'desktop')
        self.assertEqual(self.broker.status('d' * 64)['devices'], [])
        with self.assertRaises(HTTPException):
            self.broker.device(self.device, 'd' * 64)
        self.assertEqual(self.broker.authenticate(self.token), self.device)
        with self.assertRaises(HTTPException):
            self.broker.authenticate('invalid')

    def test_index_deletes_analysis_proxy_and_retains_only_description_vector(self):
        self.indexed()
        rows = self.broker.indexed_clips(self.device)
        self.assertEqual(rows[0]['id'], self.clip['id'])
        self.assertEqual(rows[0]['description'], '游泳池画面')
        self.assertEqual(list(rows[0]['vector']), [1, 0])
        self.assertEqual(list((self.root / 'local-materials').rglob('*.mp4')), [])
        self.assertEqual(self.broker.status(self.owner)['devices'][0]['indexed_clips'], 1)

    def test_clip_metadata_is_immutable_and_validated(self):
        self.assertEqual(self.broker.register_clips(self.device, [self.clip])['clips'][0]['state'], 'pending')
        for invalid in ({**self.clip, 'end': 17}, {**self.clip, 'id': '../escape'},
                        {**self.clip, 'start': float('nan')}, {**self.clip, 'name': 'x' * 513}):
            with self.assertRaises(HTTPException):
                self.broker.register_clips(self.device, [invalid])

    def test_resume_offset_digest_and_cross_device_are_enforced(self):
        content = b'fragment-content'
        result = self.broker.begin_upload(self.device, self.clip['id'], 'proxy', len(content),
                                          hashlib.sha256(content).hexdigest(), None)
        self.assertEqual(self.broker.append_upload(self.device, result['id'], 0, content[:4])['offset'], 4)
        restarted = materials.MaterialBroker(self.root)
        self.assertEqual(restarted.upload_offset(self.device, result['id']), 4)
        with self.assertRaises(HTTPException) as offset:
            restarted.append_upload(self.device, result['id'], 0, content)
        self.assertEqual(offset.exception.status_code, 409)
        other, _ = self.pair('d' * 64)
        with self.assertRaises(HTTPException):
            restarted.upload_offset(other, result['id'])
        with self.assertRaises(HTTPException):
            restarted.complete_upload(self.device, result['id'])
        restarted.append_upload(self.device, result['id'], 4, b'x' * (len(content) - 4))
        with self.assertRaises(HTTPException) as digest:
            restarted.complete_upload(self.device, result['id'])
        self.assertEqual(digest.exception.status_code, 422)

    def test_upload_reservation_quota_and_chunk_bound(self):
        with patch.object(materials, 'DEVICE_QUOTA', 9), patch.object(materials, 'MAX_CHUNK', 4):
            first = self.broker.begin_upload(self.device, self.clip['id'], 'proxy', 8, '0' * 64, None)
            with self.assertRaises(HTTPException) as too_big:
                self.broker.append_upload(self.device, first['id'], 0, b'12345')
            self.assertEqual(too_big.exception.status_code, 413)
            self.broker.register_clips(self.device, [{**self.clip, 'id': 'e' * 64}])
            with self.assertRaises(HTTPException) as quota:
                self.broker.begin_upload(self.device, 'e' * 64, 'proxy', 8, '0' * 64, None)
            self.assertEqual(quota.exception.status_code, 429)

    def test_requests_are_deduplicated_and_staged_upload_is_immutable(self):
        self.indexed()
        request = self.broker.request_clip(self.device, self.clip['id'], 'source', '1' * 32)
        repeated = self.broker.request_clip(self.device, self.clip['id'], 'source', '1' * 32)
        self.assertEqual(request['id'], repeated['id'])
        with self.assertRaises(materials.MaterialsPending):
            self.broker.wait_clip(request['id'], timeout=0)
        self.assertEqual(self.broker.requests(self.device)['requests'][0]['start'], 8)
        self.upload(kind='source', request_id=request['id'])
        result = self.broker.wait_clip(request['id'], timeout=0)
        self.assertEqual(result.suffix, '.mp4')
        self.assertEqual(result.read_bytes(), b'video')
        self.assertEqual(self.broker.requests(self.device)['requests'], [])
        with self.assertRaises(HTTPException):
            self.upload(kind='source', request_id=request['id'], content=b'changed')
        with self.assertRaises(HTTPException):
            self.upload(kind='source', request_id=None)

    def test_upload_duration_must_match_original_interval(self):
        result = self.upload(kind='proxy', complete=False)
        with patch('media.duration', return_value=2), patch('api.Models') as models:
            with self.assertRaises(HTTPException):
                self.broker.complete_upload(self.device, result['id'])
            models.assert_not_called()

    def test_repeated_analysis_completion_does_not_bill_again(self):
        result = self.upload(kind='proxy', complete=False)
        model = Mock()
        model.embed.return_value = [1, 0]
        model.json.return_value = {'description': 'pool'}
        with patch('api.Models', return_value=model), patch('media.duration', return_value=8):
            self.broker.complete_upload(self.device, result['id'])
            self.broker.complete_upload(self.device, result['id'])
        self.assertEqual(model.embed.call_count, 1)
        self.assertEqual(model.json.call_count, 1)

    def test_vector_and_description_overlap_with_independent_model_sessions(self):
        result = self.upload(kind='proxy', complete=False)
        together = threading.Barrier(2)
        sessions, threads = [], []

        def post(model, url, key_name, payload):
            sessions.append(model.session)
            threads.append(threading.get_ident())
            try:
                together.wait(3)
            except threading.BrokenBarrierError:
                self.fail('Vector and description requests must overlap')
            if url == model.embed_url:
                return {'embedding': {'values': [3, 4]}}
            return {'candidates': [{'content': {'parts': [{'text': '{"description":"游泳池"}'}]}}]}

        with patch('api.Models.post', new=post), patch('media.duration', return_value=8):
            self.assertTrue(self.broker.complete_upload(self.device, result['id'])['complete'])
        self.assertEqual(len(sessions), 2)
        self.assertIsNot(sessions[0], sessions[1])
        self.assertNotEqual(threads[0], threads[1])
        clip = self.broker.indexed_clips(self.device)[0]
        self.assertEqual(clip['description'], '游泳池')
        self.assertAlmostEqual(clip['vector'][0], .6)
        self.assertAlmostEqual(clip['vector'][1], .8)

    def test_invalid_vectors_keep_successful_description_but_never_index(self):
        for index, vector in enumerate(([], [0, 0], [float('nan'), 1], [[1, 0]])):
            with self.subTest(vector=vector):
                self.clip = {**self.clip, 'id': f'{index + 1:064x}'}
                self.broker.register_clips(self.device, [self.clip])
                result = self.upload(kind='proxy', complete=False)
                model = Mock()
                model.embed.return_value = vector
                model.json.return_value = {'description': '游泳池'}
                with patch('api.Models', return_value=model), patch('media.duration', return_value=8):
                    with self.assertRaises(ValueError):
                        self.broker.complete_upload(self.device, result['id'])
                with self.broker.connect() as db:
                    clip = db.execute('SELECT * FROM clips WHERE id=?', (self.clip['id'],)).fetchone()
                self.assertEqual(clip['state'], 'error')
                self.assertIsNone(clip['vector'])
                self.assertEqual(clip['description'], '游泳池')
        self.assertEqual(self.broker.indexed_clips(self.device), [])

    def test_vector_dimension_failure_retains_description_for_retry(self):
        self.indexed()
        self.clip = {**self.clip, 'id': 'e' * 64}
        self.broker.register_clips(self.device, [self.clip])
        result = self.upload(kind='proxy', complete=False)
        model = Mock()
        model.embed.side_effect = [[1, 0, 0], [3, 4]]
        model.json.return_value = {'description': '游泳池'}
        with patch('api.Models', return_value=model), patch('media.duration', return_value=8):
            with self.assertRaises(HTTPException) as error:
                self.broker.complete_upload(self.device, result['id'])
            self.assertEqual(error.exception.status_code, 409)
            with self.broker.connect() as db:
                clip = db.execute('SELECT * FROM clips WHERE id=?', (self.clip['id'],)).fetchone()
            self.assertEqual(clip['state'], 'error')
            self.assertIsNone(clip['vector'])
            self.assertEqual(clip['description'], '游泳池')
            retry = self.upload(kind='proxy', complete=False)
            self.assertTrue(self.broker.complete_upload(self.device, retry['id'])['complete'])
        self.assertEqual(model.embed.call_count, 2)
        self.assertEqual(model.json.call_count, 1)

    def test_parallel_analysis_does_not_save_results_after_asset_revocation(self):
        ready = threading.Barrier(3)
        release = threading.Event()
        errors = []
        model = Mock()

        def complete(value):
            ready.wait(3)
            self.assertTrue(release.wait(5))
            return value

        model.embed.side_effect = lambda **kwargs: complete([1, 0])
        model.json.side_effect = lambda *args, **kwargs: complete({'description': '游泳池'})

        def analyze():
            try:
                self.broker._analyze(self.device, self.clip['id'], self.root / 'proxy.mp4')
            except BaseException as error:
                errors.append(error)

        with patch('api.Models', return_value=model):
            worker = threading.Thread(target=analyze)
            worker.start()
            try:
                try:
                    ready.wait(3)
                except threading.BrokenBarrierError:
                    self.fail('Both model requests must start before revocation')
                self.broker.remove_asset(self.device, self.clip['asset_id'])
            finally:
                release.set()
                worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], HTTPException)
        self.assertEqual(errors[0].status_code, 410)
        with self.broker.connect() as db:
            clip = db.execute('SELECT * FROM clips WHERE id=?', (self.clip['id'],)).fetchone()
        self.assertEqual(clip['revoked'], 1)
        self.assertIsNone(clip['vector'])
        self.assertIsNone(clip['description'])
        self.assertNotEqual(clip['state'], 'indexed')

    def test_one_fps_proxy_accepts_fractional_tail_without_source_timing_drift(self):
        import media
        source = self.root / 'tail.mp4'
        proxy = self.root / 'proxy.mp4'
        media.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i',
                   'color=c=blue:s=64x64:r=25', '-t', '5.36', '-an', '-c:v', 'libx264', str(source)])
        media.proxy(source, 0, 5.36, proxy, fps=1)
        self.clip = {**self.clip, 'id': 'e' * 64, 'start': 0, 'end': 5.36}
        self.broker.register_clips(self.device, [self.clip])
        content = proxy.read_bytes()
        result = self.broker.begin_upload(self.device, self.clip['id'], 'proxy', len(content),
                                          hashlib.sha256(content).hexdigest())
        self.broker.append_upload(self.device, result['id'], 0, content)
        model = Mock()
        model.embed.return_value = [1, 0]
        model.json.return_value = {'description': '蓝色画面'}
        with patch('api.Models', return_value=model):
            self.assertTrue(self.broker.complete_upload(self.device, result['id'])['complete'])
        self.assertEqual(self.broker.indexed_clips(self.device)[0]['end'], 5.36)

    def test_revoked_assets_devices_and_expired_uploads_are_unusable(self):
        result = self.upload(kind='proxy', complete=False)
        with patch('local_materials.time.time', return_value=time.time() + materials.UPLOAD_TTL + 1):
            self.broker.cleanup()
            with self.assertRaises(HTTPException):
                self.broker.upload_offset(self.device, result['id'])
        self.broker.remove_asset(self.device, self.clip['asset_id'])
        with self.assertRaises(HTTPException):
            self.broker.request_clip(self.device, self.clip['id'], 'proxy', '1' * 32)
        self.broker.revoke(self.device, self.owner)
        with self.assertRaises(HTTPException):
            self.broker.authenticate(self.token)

    def analyze_proxy(self, device=None, clip=None, embed=(1, 0), description='游泳池画面'):
        device, clip = device or self.device, clip or self.clip
        content = b'video'
        result = self.broker.begin_upload(device, clip['id'], 'proxy', len(content),
                                          hashlib.sha256(content).hexdigest())
        self.broker.append_upload(device, result['id'], 0, content)
        model = Mock()
        model.embed.return_value = list(embed)
        model.json.return_value = {'description': description}
        with patch('api.Models', return_value=model), patch('media.duration', return_value=8):
            self.broker.complete_upload(device, result['id'])
        return model

    def test_identical_content_reuses_paid_analysis_within_the_same_workspace_only(self):
        keyed = {**self.clip, 'id': 'e' * 64, 'content_key': 'f' * 64}
        self.broker.register_clips(self.device, [keyed])
        self.analyze_proxy(clip=keyed)
        with self.broker.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM vector_cache').fetchone()[0], 1)
        reselected, _ = self.pair(self.owner)
        moved = {**keyed, 'id': '1' * 64, 'asset_id': '2' * 64, 'name': 'renamed.mp4'}
        self.assertEqual(self.broker.register_clips(reselected, [moved])['clips'][0]['state'], 'indexed')
        clip = self.broker.indexed_clips(reselected)[0]
        self.assertEqual(clip['description'], '游泳池画面')
        self.assertEqual(clip['vector'].tolist(), [1, 0])
        stranger, _ = self.pair('9' * 64)
        self.assertEqual(self.broker.register_clips(stranger, [moved])['clips'][0]['state'], 'pending')
        with self.assertRaises(HTTPException):
            self.broker.register_clips(self.device, [{**keyed, 'id': '3' * 64, 'content_key': 'not-hex'}])

    def test_vectors_are_float32_blobs_and_legacy_json_rows_still_search(self):
        self.analyze_proxy(embed=(3, 4))
        with self.broker.connect() as db:
            stored = db.execute('SELECT vector FROM clips').fetchone()[0]
            self.assertIsInstance(stored, bytes)
            self.assertEqual(len(stored), 8)
            db.execute("UPDATE clips SET vector='[0.6,0.8]'")
        self.assertEqual([round(value, 3) for value in self.broker.indexed_clips(self.device)[0]['vector'].tolist()],
                         [.6, .8])

    def test_storage_uses_wal_and_index_cache_follows_every_change(self):
        with self.broker.connect() as db:
            self.assertEqual(db.execute('PRAGMA journal_mode').fetchone()[0], 'wal')
        self.analyze_proxy()
        first = self.broker.indexed_clips(self.device)
        self.assertIs(first[0]['vector'], self.broker.indexed_clips(self.device)[0]['vector'],
                      'Unchanged index is served from memory')
        with self.broker.connect() as db:
            db.execute("UPDATE clips SET description='新的描述'")
        self.assertEqual(self.broker.indexed_clips(self.device)[0]['description'], '新的描述')

    def test_hot_path_cleanup_is_throttled_and_old_terminal_rows_are_pruned(self):
        with patch.object(self.broker, '_cleanup', wraps=self.broker._cleanup) as scan:
            self.broker.cleanup()
            self.broker.maybe_cleanup()
            self.assertEqual(scan.call_count, 1)
            with patch('local_materials.time.time', return_value=time.time() + materials.CLEANUP_INTERVAL + 1):
                self.broker.maybe_cleanup()
            self.assertEqual(scan.call_count, 2)
        self.analyze_proxy()
        request = self.broker.request_clip(self.device, self.clip['id'], 'source', 'd' * 32)
        with self.broker.connect() as db:
            db.execute("UPDATE requests SET state='cancelled',expires=? WHERE id=?",
                       (time.time() - materials.TERMINAL_TTL - 1, request['id']))
        self.broker.cleanup()
        with self.broker.connect() as db:
            self.assertIsNone(db.execute('SELECT 1 FROM requests WHERE id=?', (request['id'],)).fetchone())

    def test_description_queue_retries_with_backoff_then_requests_new_frames(self):
        self.broker.register_clips(self.device, [self.clip])
        retained = self.broker.folder / 'describe' / 'queued.mp4'
        retained.parent.mkdir(exist_ok=True)
        retained.write_bytes(b'frames')
        with self.broker.connect() as db:
            db.execute("UPDATE clips SET state='indexed',vector=?", (materials.pack_vector([1, 0]),))
            db.execute('INSERT INTO description_queue VALUES(?,?,?,0,0,NULL)', (self.device, self.clip['id'], str(retained)))
        with patch.object(materials.MaterialBroker, '_describe', side_effect=RuntimeError('busy')):
            self.assertTrue(self.broker.describe_next())
            self.assertFalse(self.broker.describe_next(), 'A failed description waits for its backoff')
            with self.broker.connect() as db:
                row = db.execute('SELECT attempts,next_try FROM description_queue').fetchone()
            self.assertEqual(row['attempts'], 1)
            self.assertGreater(row['next_try'], time.time() + 20)
            for attempt in range(materials.DESCRIBE_ATTEMPTS - 1):
                with self.broker.connect() as db:
                    db.execute('UPDATE description_queue SET next_try=0')
                self.assertTrue(self.broker.describe_next())
        with self.broker.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM description_queue').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT state FROM clips').fetchone()[0], 'pending')
            self.assertIsNotNone(db.execute('SELECT vector FROM clips').fetchone()[0], 'The paid vector is kept')
        self.assertFalse(retained.exists())

    def test_restart_recovers_description_leases_and_resets_lost_copies(self):
        self.broker.register_clips(self.device, [self.clip])
        with self.broker.connect() as db:
            db.execute("UPDATE clips SET state='indexed',vector=?", (materials.pack_vector([1, 0]),))
            db.execute('INSERT INTO description_queue VALUES(?,?,?,0,0,?)',
                       (self.device, self.clip['id'], str(self.broker.folder / 'describe' / 'gone.mp4'), time.time() + 600))
        self.broker.recover_descriptions()
        with self.broker.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM description_queue').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT state FROM clips').fetchone()[0], 'pending')


class ModelConfigTests(unittest.TestCase):
    def setUp(self):
        import api
        self.api = api
        api._unsupported_config.clear()
        self.addCleanup(api._unsupported_config.clear)

    def test_description_speed_options_fall_back_once_when_gateway_rejects_them(self):
        payloads = []

        def post(model, url, key_name, payload):
            payloads.append(payload['generationConfig'])
            if 'thinkingConfig' in payload['generationConfig']:
                raise RuntimeError('HTTP 400: unknown field thinkingConfig')
            return {'candidates': [{'content': {'parts': [{'text': '{"description":"池"}'}]}}]}

        with patch('api.Models.post', new=post):
            model = self.api.Models()
            self.assertEqual(model.json('p', config=self.api.DESCRIBE_CONFIG), {'description': '池'})
            self.assertEqual(model.json('p', config=self.api.DESCRIBE_CONFIG), {'description': '池'})
        self.assertEqual(len(payloads), 3, 'Rejected options are remembered and not retried')
        self.assertIn('thinkingConfig', payloads[0])
        self.assertNotIn('thinkingConfig', payloads[2])

    def test_other_errors_are_not_retried_without_options(self):
        with patch('api.Models.post', side_effect=RuntimeError('HTTP 500: busy')) as post:
            with self.assertRaises(RuntimeError):
                self.api.Models().json('p', config=self.api.DESCRIBE_CONFIG)
        self.assertEqual(post.call_count, 1)
        self.assertEqual(self.api._unsupported_config, set())

    def test_each_thread_reuses_its_own_session(self):
        sessions = []
        worker = threading.Thread(target=lambda: sessions.extend([self.api.Models().session, self.api.Models().session]))
        worker.start()
        worker.join()
        self.assertIs(sessions[0], sessions[1])
        self.assertIsNot(sessions[0], self.api.Models().session)
