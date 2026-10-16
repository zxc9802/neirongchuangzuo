import hashlib
import json
import subprocess
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

import numpy as np
from fastapi import HTTPException
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'services/mix/python'))
try:
    from cloud_materials import CloudMaterials
    from cloud_catalog import CloudCatalog, hydrate_cloud
except ModuleNotFoundError:
    CloudMaterials = None

OWNER = 'a' * 64
OTHER = 'b' * 64
ENV = dict(zip(('MIX_MATERIAL_COS_SECRET_ID', 'MIX_MATERIAL_COS_SECRET_KEY',
                'MIX_MATERIAL_COS_BUCKET', 'MIX_MATERIAL_COS_REGION'),
               ('test-id', 'test-key', 'test-bucket-123', 'ap-singapore')))


class FakeCos:
    def __init__(self):
        self.objects = {}
        self.copies = []
        self.downloads = []
        self.fail_delete = False

    def get_presigned_url(self, **params):
        return 'https://test-bucket-123.cos.ap-singapore.myqcloud.com/' + params['Key'] + '?sign=test'

    def head_object(self, **params):
        value = self.objects[params['Key']]
        return {'Content-Length': str(len(value)), 'ETag': '"' + hashlib.md5(value).hexdigest() + '"'}

    def copy_object(self, **params):
        self.copies.append(params)
        source = params['CopySource']['Key']
        assert self.head_object(Key=source)['ETag'] == params['CopySourceIfMatch']
        self.objects[params['Key']] = self.objects[source]
        return self.head_object(Key=params['Key'])

    def put_object(self, **params):
        assert params['ACL'] == 'private'
        self.objects[params['Key']] = params['Body'].read()
        return self.head_object(Key=params['Key'])

    def download_file(self, **params):
        self.downloads.append(params['Key'])
        Path(params['DestFilePath']).write_bytes(self.objects[params['Key']])

    def delete_object(self, **params):
        if self.fail_delete:
            raise RuntimeError('cloud unavailable')
        self.objects.pop(params['Key'], None)


class FakeModels:
    embed_url = 'test://embedding-v1'
    llm_url = 'test://description-v1'

    def __init__(self):
        self.embeds = 0
        self.descriptions = 0
        self.fail_description = False

    def embed(self, **kwargs):
        self.embeds += 1
        return np.array([1., 0., 0.], dtype=np.float32)

    def json(self, *args, **kwargs):
        self.descriptions += 1
        if self.fail_description:
            raise RuntimeError('description unavailable')
        return {'description': '蓝色画面中的测试素材'}


class CloudMaterialsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixtures = tempfile.TemporaryDirectory()
        cls.video = Path(cls.fixtures.name) / 'sample.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'lavfi',
                        '-i', 'color=blue:s=96x128:d=9', '-f', 'lavfi',
                        '-i', 'sine=frequency=440:duration=9', '-c:v', 'libx264',
                        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', str(cls.video)],
                       check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        cls.fixtures.cleanup()

    def setUp(self):
        self.assertIsNotNone(CloudMaterials, 'CloudMaterials must implement durable cloud storage')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cos = FakeCos()
        self.library = CloudMaterials(self.root, client=self.cos, env=ENV)
        self.models = FakeModels()

    def upload(self, owner=OWNER):
        content = self.video.read_bytes()
        ticket = self.library.create_upload(owner, '子目录/真实素材.mp4', len(content))
        metadata = self.library.get(owner, ticket['id'])
        self.cos.objects[metadata['upload_key']] = content
        return self.library.complete(owner, ticket['id'])

    def index(self, owner=OWNER):
        item = self.upload(owner)
        self.assertTrue(self.library.index_next(self.models))
        return self.library.get(owner, item['id'])

    def test_config_and_upload_do_not_accept_untrusted_keys_or_owners(self):
        other = CloudMaterials(self.root / 'unconfigured', client=self.cos, env={})
        self.assertFalse(other.status()['configured'])
        self.assertEqual(set(other.status()['missing']), set(ENV))
        with self.assertRaises(RuntimeError):
            other.create_upload(OWNER, 'sample.mp4', 100)
        for name, size in [('bad.exe', 5), ('clip.mp4', 0), ('clip.mp4', True), ('clip.mp4', 6 * 1024**3)]:
            with self.assertRaises((ValueError, HTTPException)):
                self.library.create_upload(OWNER, name, size)
        with self.assertRaises((ValueError, HTTPException)):
            self.library.create_upload('../owner', 'clip.mp4', 10)
        self.assertEqual(self.cos.objects, {})

    def test_finalization_checks_size_and_revocable_staging_cannot_overwrite_source(self):
        content = self.video.read_bytes()
        ticket = self.library.create_upload(OWNER, 'sample.mp4', len(content))
        pending = self.library.get(OWNER, ticket['id'])
        with self.assertRaises((KeyError, HTTPException)):
            self.library.complete(OTHER, ticket['id'])
        self.cos.objects[pending['upload_key']] = b'too short'
        with self.assertRaises((ValueError, HTTPException)):
            self.library.complete(OWNER, ticket['id'])
        self.cos.objects[pending['upload_key']] = content
        item = self.library.complete(OWNER, ticket['id'])
        final = self.library.get(OWNER, item['id'])
        self.assertNotEqual(final['key'], pending['upload_key'])
        self.assertEqual(self.cos.objects[final['key']], content)
        self.cos.objects[pending['upload_key']] = b'late signed PUT replay'
        self.assertEqual(self.cos.objects[final['key']], content)
        self.assertEqual(self.library.complete(OWNER, item['id'])['state'], 'queued')
        self.assertNotIn('key', item)
        self.assertNotIn('upload_key', item)

    def test_index_is_durable_and_faiss_search_is_account_scoped(self):
        asset = self.index()
        self.assertEqual(asset['state'], 'ready')
        self.assertAlmostEqual(asset['duration'], 9, places=1)
        self.assertEqual(self.models.embeds, 2)
        restarted = CloudMaterials(self.root, client=self.cos, env=ENV)
        config = {'type': 'cloud', 'root': str(self.root), 'owner': OWNER, 'job_id': 'c' * 32}
        catalog = CloudCatalog(config, library=restarted, embedding=self.models.embed_url)
        search = catalog.searcher()
        found = search([1, 0, 0], 20)
        self.assertEqual(len(found), 2)
        self.assertEqual(found[0]['remote']['owner'], OWNER)
        self.assertTrue((self.root / 'cloud-materials' / 'indexes' / OWNER / 'vectors.faiss').is_file())
        with self.assertRaises(ValueError):
            search([1, 0], 1)
        with self.assertRaises(ValueError):
            CloudCatalog({**config, 'owner': OTHER}, library=restarted, embedding=self.models.embed_url).searcher()
        with self.assertRaises(ValueError):
            CloudCatalog(config, library=restarted, embedding='different-model').searcher()
        self.assertEqual(restarted.list(OTHER), [])

    def test_failed_description_retry_reuses_successful_embedding(self):
        item = self.upload()
        self.models.fail_description = True
        self.assertTrue(self.library.index_next(self.models))
        self.assertEqual(self.library.get(OWNER, item['id'])['state'], 'failed')
        embeds = self.models.embeds
        self.models.fail_description = False
        self.library.retry(OWNER, item['id'])
        self.assertTrue(self.library.index_next(self.models))
        self.assertEqual(self.library.get(OWNER, item['id'])['state'], 'ready')
        self.assertEqual(self.models.embeds, embeds)

    def test_source_and_proxy_hydration_work_without_browser_and_cache_is_verified(self):
        item = self.index()
        catalog = CloudCatalog({'type': 'cloud', 'root': str(self.root), 'owner': OWNER,
                                'job_id': 'd' * 32}, library=self.library, embedding=self.models.embed_url)
        candidate = next(row for row in catalog.searcher()([1, 0, 0], 100) if row['source_start'] == 0)
        hydrate_cloud(candidate, 'proxy', library=self.library)
        self.assertTrue(Path(candidate['proxy']).is_file())
        source = self.library.cache_source(OWNER, item['id'])
        source.write_bytes(b'corrupt cached video')
        hydrate_cloud(candidate, 'source', library=self.library)
        self.assertEqual(Path(candidate['path']).read_bytes(), self.video.read_bytes())
        self.assertTrue(candidate['stamp'])
        self.assertEqual(candidate['source_start'], 0)
        self.assertEqual(candidate['source_end'], 8)

    def test_recover_and_delete_remove_metadata_vectors_and_owned_objects(self):
        item = self.index()
        with self.library.connect() as db:
            db.execute("UPDATE assets SET state='indexing' WHERE id=?", (item['id'],))
        self.library.recover()
        self.assertEqual(self.library.get(OWNER, item['id'])['state'], 'queued')
        self.library.index_next(self.models)
        with self.assertRaises((KeyError, HTTPException)):
            self.library.delete(OTHER, item['id'])
        self.library.delete(OWNER, item['id'])
        self.assertEqual(self.library.list(OWNER), [])
        self.assertEqual(self.cos.objects, {})
        with self.library.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM clips').fetchone()[0], 0)

    def test_multiple_clips_from_one_original_keep_the_same_source_stamp(self):
        self.index()
        catalog = CloudCatalog({'type': 'cloud', 'root': str(self.root), 'owner': OWNER,
                                'job_id': 'd' * 32}, library=self.library, embedding=self.models.embed_url)
        candidates = catalog.searcher()([1, 0, 0], 2)
        for candidate in candidates:
            hydrate_cloud(candidate, 'source', library=self.library)
        self.assertEqual(candidates[0]['path'], candidates[1]['path'])
        self.assertEqual(candidates[0]['stamp'], candidates[1]['stamp'])

    def test_render_batch_validates_a_shared_original_only_once(self):
        from remote_catalog import hydrate
        self.index()
        candidates = CloudCatalog({'type': 'cloud', 'root': str(self.root), 'owner': OWNER,
            'job_id': 'd'*32}, library=self.library, embedding=self.models.embed_url).searcher()([1, 0, 0], 2)
        with patch('cloud_catalog.CloudMaterials', return_value=self.library), \
                patch.object(self.library, 'cache_source', wraps=self.library.cache_source) as cache:
            hydrate(candidates, 'source')
        self.assertEqual(cache.call_count, 1)
        self.assertEqual(candidates[0]['path'], candidates[1]['path'])
        self.assertEqual(candidates[0]['stamp'], candidates[1]['stamp'])

    def test_cloud_routes_and_jobs_use_verified_owner_without_a_browser_device(self):
        from app import create_app
        self.index()
        app = create_app(root=self.root, token='t' * 64, start_worker=False, cloud_library=self.library)
        headers = {'Authorization': 'Bearer ' + 't' * 64, 'x-material-owner': OWNER}
        with TestClient(app) as client:
            self.assertEqual(client.get('/v1/mix/materials').status_code, 401)
            health = client.get('/health', headers=headers).json()
            self.assertTrue(health['material_library']['configured'])
            own = client.get('/v1/mix/materials', headers=headers)
            self.assertEqual(len(own.json()['items']), 1)
            self.assertEqual(own.json()['indexed_clips'], 2)
            self.assertNotIn('test-key', own.text)
            other = client.get('/v1/mix/materials', headers={**headers, 'x-material-owner': OTHER})
            self.assertEqual(other.json()['items'], [])
            response = client.post('/v1/mix/jobs', headers={**headers, 'Idempotency-Key': 'cloud-job'},
                                   json={'source': 'cloud', 'text': '蓝色画面', 'voice_mode': 'original'})
            self.assertEqual(response.status_code, 202, response.text)
            with app.state.jobs.connect() as db:
                spec = json.loads(db.execute('SELECT spec FROM jobs').fetchone()[0])
            self.assertEqual(spec['source'], 'cloud')
            self.assertEqual(spec['owner'], OWNER)
            self.assertIsNone(spec['device_id'])
            item = own.json()['items'][0]
            denied = client.delete('/v1/mix/materials/' + item['id'], headers=headers)
            self.assertEqual(denied.status_code, 409)
            other_job = client.post('/v1/mix/jobs', headers={**headers, 'x-material-owner': OTHER,
                'Idempotency-Key': 'empty-owner'}, json={'source': 'cloud', 'text': '蓝色画面', 'voice_mode': 'original'})
            self.assertEqual(other_job.status_code, 409)

    def test_cloud_job_runs_without_device_or_browser_after_submission(self):
        from app import create_app
        self.index()

        def runner(spec, folder, log):
            result = folder / 'final.mp4'
            result.write_bytes(self.video.read_bytes())
            (folder / 'quality-report.json').write_text(json.dumps({
                'passed': True, 'sha256': hashlib.sha256(result.read_bytes()).hexdigest()}))
            return result

        app = create_app(root=self.root, token='t' * 64, start_worker=False,
                         cloud_library=self.library, runner=runner)
        headers = {'Authorization': 'Bearer ' + 't' * 64, 'x-material-owner': OWNER,
                   'Idempotency-Key': 'offline-job'}
        with TestClient(app) as client:
            response = client.post('/v1/mix/jobs', headers=headers,
                json={'source': 'cloud', 'text': '蓝色画面', 'voice_mode': 'original'})
            self.assertEqual(response.status_code, 202, response.text)
            job_id = response.json()['id']
        self.assertTrue(app.state.jobs.run_one(app.state.runner))
        self.assertEqual(app.state.jobs.get(job_id, OWNER)['state'], 'done')

    def test_resume_waits_for_deletion_and_refuses_missing_cloud_materials(self):
        from app import create_app
        item = self.index()
        app = create_app(root=self.root, token='t' * 64, start_worker=False, cloud_library=self.library)
        headers = {'Authorization': 'Bearer ' + 't'*64, 'x-material-owner': OWNER,
                   'Idempotency-Key': 'resume-race'}
        entered, release = threading.Event(), threading.Event()
        original = self.cos.delete_object

        def paused(**kwargs):
            entered.set()
            self.assertTrue(release.wait(5))
            return original(**kwargs)

        with TestClient(app) as client:
            submitted = client.post('/v1/mix/jobs', headers=headers,
                json={'source': 'cloud', 'text': '蓝色画面', 'voice_mode': 'original'})
            job = submitted.json()['id']
            with app.state.jobs.connect() as db:
                db.execute("UPDATE jobs SET state='failed' WHERE id=?", (job,))
            with ThreadPoolExecutor(max_workers=2) as pool, patch.object(self.cos, 'delete_object', side_effect=paused):
                deleting = pool.submit(client.delete, '/v1/mix/materials/' + item['id'], headers=headers)
                self.assertTrue(entered.wait(5))
                resuming = pool.submit(client.post, f'/v1/mix/jobs/{job}/resume', headers=headers)
                try:
                    self.assertFalse(resuming.done(), 'resume must share the material lifecycle lock')
                finally:
                    release.set()
                self.assertEqual(deleting.result().status_code, 200)
                self.assertEqual(resuming.result().status_code, 409)
            self.assertEqual(app.state.jobs.get(job, OWNER)['state'], 'failed')

    def test_late_upload_replay_after_deletion_is_cleaned_once_ticket_expires(self):
        item = self.upload()
        pending_key = self.library.get(OWNER, item['id'])['upload_key']
        self.library.delete(OWNER, item['id'])
        self.cos.objects[pending_key] = b'replayed staging upload'
        with patch('cloud_materials.time.time', return_value=10**12):
            self.library.cleanup()
        self.assertEqual(self.cos.objects, {})

    def test_resume_does_not_require_deleted_rejected_audit_candidates(self):
        from app import create_app
        selected = self.index()
        rejected = self.index()
        app = create_app(root=self.root, token='t' * 64, start_worker=False, cloud_library=self.library)
        headers = {'Authorization': 'Bearer ' + 't'*64, 'x-material-owner': OWNER,
                   'Idempotency-Key': 'resume-selected-only'}
        with TestClient(app) as client:
            response = client.post('/v1/mix/jobs', headers=headers,
                json={'source': 'cloud', 'text': '蓝色画面', 'voice_mode': 'original'})
            job = response.json()['id']
            with app.state.jobs.connect() as db:
                db.execute("UPDATE jobs SET state='failed' WHERE id=?", (job,))
            folder = self.root / 'outputs' / job
            folder.mkdir(parents=True)
            match = {'id': 1, 'remote': {'type': 'cloud', 'asset_id': selected['id']}}
            unused = {'id': 2, 'remote': {'type': 'cloud', 'asset_id': rejected['id']}}
            (folder / 'plan.json').write_text(json.dumps({'scenes': [{'shots': [{'selected': match}],
                'match': {'selected': match, 'attempts': [{'top3': [match, unused],
                    'verdict': {'accepted': [{'id': 1}]}}]}}]}))
            self.assertEqual(client.delete('/v1/mix/materials/' + rejected['id'], headers=headers).status_code, 200)
            resumed = client.post(f'/v1/mix/jobs/{job}/resume', headers=headers)
            self.assertEqual(resumed.status_code, 202, resumed.text)

    def test_resume_rejects_deleted_candidates_in_unfinished_matching_checkpoints(self):
        from app import create_app
        keep = self.index()
        removed = self.index()
        app = create_app(root=self.root, token='t'*64, start_worker=False, cloud_library=self.library)
        headers = {'Authorization': 'Bearer ' + 't'*64, 'x-material-owner': OWNER}
        candidate = {'id': 1, 'remote': {'type': 'cloud', 'asset_id': removed['id']}}
        checkpoints = [{'match_progress': {'groups': {'20': {'top': [candidate]}}}},
                       {'coverage_progress': {'ranked': [candidate], 'groups': {}}}]
        with TestClient(app) as client:
            jobs = []
            for number, progress in enumerate(checkpoints):
                response = client.post('/v1/mix/jobs', headers={**headers, 'Idempotency-Key': f'pending-{number}'},
                    json={'source': 'cloud', 'text': '蓝色画面', 'voice_mode': 'original'})
                job = response.json()['id']
                jobs.append(job)
                with app.state.jobs.connect() as db:
                    db.execute("UPDATE jobs SET state='failed' WHERE id=?", (job,))
                folder = self.root / 'outputs' / job
                folder.mkdir(parents=True)
                (folder / 'plan.json').write_text(json.dumps({'scenes': [progress]}))
            self.assertEqual(client.delete('/v1/mix/materials/' + removed['id'], headers=headers).status_code, 200)
            self.assertEqual(self.library.get(OWNER, keep['id'])['state'], 'ready')
            for job in jobs:
                response = client.post(f'/v1/mix/jobs/{job}/resume', headers=headers)
                self.assertEqual(response.status_code, 409, response.text)

    def test_resume_checks_accepted_alternatives_only_before_shots_are_finalized(self):
        from app import create_app
        keep = self.index()
        removed = self.index()
        app = create_app(root=self.root, token='t'*64, start_worker=False, cloud_library=self.library)
        headers = {'Authorization': 'Bearer ' + 't'*64, 'x-material-owner': OWNER,
                   'Idempotency-Key': 'accepted-alternative'}
        selected = {'id': 1, 'source_start': 0, 'source_end': 8, 'verified_start': 0, 'verified_end': 1,
                    'remote': {'type': 'cloud', 'asset_id': keep['id']}}
        alternate = {'id': 2, 'source_start': 0, 'source_end': 8,
                     'remote': {'type': 'cloud', 'asset_id': removed['id']}}
        scene = {'text': '蓝色画面', 'start': 0, 'end': 2, 'match': {'selected': selected,
            'attempts': [{'top3': [selected, alternate], 'verdict': {
                'accepted': [{'id': 2, 'start': 0, 'end': 3, 'score': .96}]}}]}}
        with TestClient(app) as client:
            job = client.post('/v1/mix/jobs', headers=headers,
                json={'source': 'cloud', 'text': '蓝色画面', 'voice_mode': 'original'}).json()['id']
            with app.state.jobs.connect() as db:
                db.execute("UPDATE jobs SET state='failed' WHERE id=?", (job,))
            folder = self.root / 'outputs' / job
            folder.mkdir(parents=True)
            plan = folder / 'plan.json'
            plan.write_text(json.dumps({'fps': 25, 'scenes': [scene]}))
            self.assertEqual(client.delete('/v1/mix/materials/' + removed['id'], headers=headers).status_code, 200)
            self.assertEqual(client.post(f'/v1/mix/jobs/{job}/resume', headers=headers).status_code, 409)
            scene['shots'] = [{'selected': selected, 'duration': 2}]
            plan.write_text(json.dumps({'fps': 25, 'scenes': [scene]}))
            self.assertEqual(client.post(f'/v1/mix/jobs/{job}/resume', headers=headers).status_code, 202)

    def test_playlist_disguised_as_video_is_rejected_without_network_access(self):
        ticket = self.library.create_upload(OWNER, 'disguised.mp4', 53)
        content = b'#EXTM3U\n#EXTINF:1,\nhttp://127.0.0.1:9/private.mp4\n'
        row = self.library.get(OWNER, ticket['id'])
        with self.library.connect() as db:
            db.execute('UPDATE assets SET bytes=? WHERE id=?', (len(content), ticket['id']))
        self.cos.objects[row['upload_key']] = content
        self.library.complete(OWNER, ticket['id'])
        self.library.index_next(self.models)
        self.assertEqual(self.library.get(OWNER, ticket['id'])['state'], 'failed')
        self.assertEqual(self.models.embeds, 0)


if __name__ == '__main__':
    unittest.main()
