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
from qcloud_cos.cos_exception import CosServiceError

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
        if params['Key'] not in self.objects:
            raise CosServiceError('HEAD', '<Error><Code>NoSuchKey</Code></Error>', 404)
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

    def test_changing_upload_bucket_preserves_old_originals_proxies_and_staging(self):
        old = self.index()
        pending = self.library.create_upload(OWNER, 'pending.mp4', self.video.stat().st_size)
        # Simulate existing metadata written before bucket locations were recorded.
        with self.library.connect() as db:
            db.execute('UPDATE assets SET bucket=NULL,region=NULL')
            db.execute('UPDATE staging_cleanup SET bucket=NULL,region=NULL')
        env = {**ENV, 'MIX_MATERIAL_COS_BUCKET': 'hj-1410143389',
               'MIX_MATERIAL_COS_LEGACY_BUCKET': ENV['MIX_MATERIAL_COS_BUCKET']}
        library = CloudMaterials(self.root, client=self.cos, env=env)
        self.assertEqual(library.get(OWNER, old['id'])['bucket'], ENV['MIX_MATERIAL_COS_BUCKET'])
        with patch.object(self.cos, 'get_presigned_url', wraps=self.cos.get_presigned_url) as signed:
            library.signed_url(OWNER, old['id'])
            self.assertEqual(signed.call_args.kwargs['Bucket'], ENV['MIX_MATERIAL_COS_BUCKET'])
            fresh = library.create_upload(OWNER, 'new.mp4', self.video.stat().st_size)
            self.assertEqual(signed.call_args.kwargs['Bucket'], 'hj-1410143389')
        source = library.folder / 'cache' / OWNER / old['id'] / 'source.mp4'
        source.unlink()
        with patch.object(self.cos, 'download_file', wraps=self.cos.download_file) as download:
            library.cache_source(OWNER, old['id'])
            self.assertEqual(download.call_args.kwargs['Bucket'], ENV['MIX_MATERIAL_COS_BUCKET'])
        with library.connect() as db:
            clip = db.execute('SELECT * FROM clips WHERE asset_id=? LIMIT 1', (old['id'],)).fetchone()
            db.execute('UPDATE staging_cleanup SET expires=0 WHERE key=?',
                       (library.get(OWNER, pending['id'])['upload_key'],))
        proxy = library.folder / 'cache' / OWNER / old['id'] / (str(clip['id']) + '-proxy.mp4')
        proxy.unlink(missing_ok=True)
        with patch.object(self.cos, 'download_file', wraps=self.cos.download_file) as download:
            library.cache_proxy(OWNER, clip['id'])
            self.assertEqual(download.call_args.kwargs['Bucket'], ENV['MIX_MATERIAL_COS_BUCKET'])
        with patch.object(self.cos, 'delete_object', wraps=self.cos.delete_object) as delete:
            library.cleanup()
            self.assertEqual(delete.call_args.kwargs['Bucket'], ENV['MIX_MATERIAL_COS_BUCKET'])
        self.assertEqual(library.get(OWNER, fresh['id'])['bucket'], 'hj-1410143389')

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

    def test_fingerprint_resumes_the_same_account_file_and_preserves_legacy_uploads(self):
        fingerprint = 'd' * 64
        first = self.library.create_upload(OWNER, 'folder/clip.mp4', 5, fingerprint)
        restarted = CloudMaterials(self.root, client=self.cos, env=ENV)
        resumed = restarted.create_upload(OWNER, 'folder\\clip.mp4', 5, fingerprint.upper())
        self.assertEqual(first['id'], resumed['id'])
        self.assertIn('upload_url', resumed)
        other = restarted.create_upload(OTHER, 'folder/clip.mp4', 5, fingerprint)
        self.assertNotEqual(first['id'], other['id'])
        for _ in range(2):
            legacy = restarted.create_upload(OWNER, 'folder/clip.mp4', 5)
            self.assertNotEqual(first['id'], legacy['id'])
        self.assertEqual(len(restarted.list(OWNER)), 3)
        self.assertIsNone(restarted.list(OWNER)[0]['fingerprint'])
        self.assertEqual(restarted.public(restarted.get(OWNER, first['id']))['fingerprint'], fingerprint)

    def test_existing_database_migration_preserves_assets_without_guessing_identity(self):
        legacy = self.upload()
        with self.library.connect() as db:
            db.execute('DROP INDEX assets_fingerprint')
            db.execute('ALTER TABLE assets DROP COLUMN fingerprint')
        restarted = CloudMaterials(self.root, client=self.cos, env=ENV)
        before = restarted.get(OWNER, legacy['id'])
        self.assertIsNone(before['fingerprint'])
        ticket = restarted.create_upload(OWNER, legacy['name'], legacy['bytes'], 'd' * 64)
        self.assertNotEqual(ticket['id'], legacy['id'])
        self.assertEqual(restarted.get(OWNER, legacy['id']), before)
        self.assertEqual(self.cos.objects[before['key']], self.video.read_bytes())

    def test_confirmed_legacy_reselection_binds_only_the_unique_owned_asset(self):
        legacy = self.upload()
        other = self.upload(OTHER)
        before = self.library.get(OWNER, legacy['id'])
        resumed = self.library.create_upload(OWNER, legacy['name'], legacy['bytes'], 'd' * 64, True)
        self.assertEqual(resumed['id'], legacy['id'])
        self.assertEqual(resumed['item']['fingerprint'], 'd' * 64)
        self.assertEqual(resumed['item']['state'], 'queued')
        self.assertNotIn('upload_url', resumed)
        self.assertEqual(self.library.get(OWNER, legacy['id']), {**before, 'fingerprint': 'd' * 64})
        self.assertIsNone(self.library.get(OTHER, other['id'])['fingerprint'])
        self.assertEqual(len(self.cos.copies), 2)

    def test_legacy_reselection_does_not_guess_between_duplicates_or_rebind_identity(self):
        first = self.library.create_upload(OWNER, 'clip.mp4', 5)
        second = self.library.create_upload(OWNER, 'clip.mp4', 5)
        ambiguous = self.library.create_upload(OWNER, 'clip.mp4', 5, 'd' * 64, True)
        self.assertNotIn(ambiguous['id'], (first['id'], second['id']))
        self.assertIsNone(self.library.get(OWNER, first['id'])['fingerprint'])
        self.assertIsNone(self.library.get(OWNER, second['id'])['fingerprint'])
        assigned = self.library.create_upload(OWNER, 'assigned.mp4', 5, 'e' * 64)
        replacement = self.library.create_upload(OWNER, 'assigned.mp4', 5, 'f' * 64, True)
        self.assertNotEqual(replacement['id'], assigned['id'])
        self.assertEqual(self.library.get(OWNER, assigned['id'])['fingerprint'], 'e' * 64)

    def test_confirmed_legacy_reselection_continues_uploads_and_excludes_deleting(self):
        pending = self.library.create_upload(OWNER, 'pending.mp4', 5)
        resumed = self.library.create_upload(OWNER, 'pending.mp4', 5, 'd' * 64, True)
        self.assertEqual(resumed['id'], pending['id'])
        self.assertIn('upload_url', resumed)
        finished = self.library.create_upload(OWNER, 'finished.mp4', 5)
        item = self.library.get(OWNER, finished['id'])
        self.cos.objects[item['upload_key']] = b'short'
        recovered = self.library.create_upload(OWNER, 'finished.mp4', 5, 'e' * 64, True)
        self.assertEqual(recovered['id'], finished['id'])
        self.assertEqual(recovered['item']['state'], 'queued')
        deleting = self.library.create_upload(OWNER, 'deleting.mp4', 5)
        with self.library.connect() as db:
            db.execute("UPDATE assets SET state='deleting' WHERE id=?", (deleting['id'],))
        replacement = self.library.create_upload(OWNER, 'deleting.mp4', 5, 'f' * 64, True)
        self.assertNotEqual(replacement['id'], deleting['id'])
        self.assertIsNone(self.library.get(OWNER, deleting['id'])['fingerprint'])

    def test_concurrent_legacy_claims_do_not_overwrite_the_first_bound_identity(self):
        legacy = self.library.create_upload(OWNER, 'clip.mp4', 5)
        clients = [CloudMaterials(self.root, client=self.cos, env=ENV) for _ in range(2)]
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda n: clients[n].create_upload(
                OWNER, 'clip.mp4', 5, ('d' if n == 0 else 'e') * 64, True), range(2)))
        self.assertEqual(len({result['id'] for result in results}), 2)
        self.assertIn(legacy['id'], {result['id'] for result in results})
        for n, result in enumerate(results):
            self.assertEqual(self.library.get(OWNER, result['id'])['fingerprint'], ('d' if n == 0 else 'e') * 64)

    def test_legacy_reuse_flag_is_strict_and_requires_a_fingerprint(self):
        for reuse in ['true', 1, None, []]:
            with self.assertRaises(ValueError):
                self.library.create_upload(OWNER, 'clip.mp4', 5, 'd' * 64, reuse)
        with self.assertRaises(ValueError):
            self.library.create_upload(OWNER, 'clip.mp4', 5, None, True)
        self.assertEqual(self.library.list(OWNER), [])

    def test_fingerprint_rejects_invalid_identity_and_conflicting_metadata(self):
        for fingerprint in ['', 'z' * 64, 'a' * 63, 123, True]:
            with self.assertRaises(ValueError):
                self.library.create_upload(OWNER, 'clip.mp4', 5, fingerprint)
        fingerprint = 'd' * 64
        self.library.create_upload(OWNER, 'clip.mp4', 5, fingerprint)
        for name, size in [('changed.mp4', 5), ('clip.mp4', 6)]:
            with self.assertRaises(ValueError):
                self.library.create_upload(OWNER, name, size, fingerprint)
        self.assertEqual(len(self.library.list(OWNER)), 1)

    def test_resume_recovers_a_finished_put_without_the_complete_request(self):
        fingerprint = 'e' * 64
        ticket = self.library.create_upload(OWNER, 'clip.mp4', 5, fingerprint)
        item = self.library.get(OWNER, ticket['id'])
        self.cos.objects[item['upload_key']] = b'short'
        resumed = self.library.create_upload(OWNER, 'clip.mp4', 5, fingerprint)
        self.assertEqual(resumed['id'], ticket['id'])
        self.assertEqual(resumed['item']['state'], 'queued')
        self.assertNotIn('upload_url', resumed)
        self.assertEqual(self.cos.objects[item['key']], b'short')
        self.cos.objects[item['upload_key']] = b'other'
        self.library.complete(OWNER, item['id'])
        again = self.library.create_upload(OWNER, 'clip.mp4', 5, fingerprint)
        self.assertEqual(again['item']['state'], 'queued')
        self.assertEqual(len(self.cos.copies), 1)
        self.assertEqual(self.cos.objects[item['key']], b'short')

    def test_resume_reuploads_incomplete_staging_but_does_not_hide_storage_failure(self):
        fingerprint = 'e' * 64
        ticket = self.library.create_upload(OWNER, 'clip.mp4', 5, fingerprint)
        item = self.library.get(OWNER, ticket['id'])
        self.cos.objects[item['upload_key']] = b'x'
        self.assertIn('upload_url', self.library.create_upload(OWNER, 'clip.mp4', 5, fingerprint))
        denied = CosServiceError('HEAD', '<Error><Code>AccessDenied</Code></Error>', 403)
        with patch.object(self.cos, 'head_object', side_effect=denied), self.assertRaises(CosServiceError):
            self.library.create_upload(OWNER, 'clip.mp4', 5, fingerprint)
        self.assertEqual(len(self.library.list(OWNER)), 1)
        self.assertEqual(self.cos.copies, [])

    def test_reselection_reuses_indexed_or_failed_assets_without_analysis_again(self):
        content = self.video.read_bytes()
        fingerprint = 'f' * 64
        ticket = self.library.create_upload(OWNER, 'clip.mp4', len(content), fingerprint)
        item = self.library.get(OWNER, ticket['id'])
        self.cos.objects[item['upload_key']] = content
        self.library.complete(OWNER, item['id'])
        self.library.index_next(self.models)
        for state in ['ready', 'failed']:
            with self.library.connect() as db:
                db.execute('UPDATE assets SET state=? WHERE id=?', (state, item['id']))
            resumed = self.library.create_upload(OWNER, 'clip.mp4', len(content), fingerprint)
            self.assertEqual(resumed['item']['id'], item['id'])
            self.assertEqual(resumed['item']['state'], state)
            self.assertNotIn('upload_url', resumed)
            self.assertFalse(self.library.index_next(self.models))
        self.assertEqual(self.models.embeds, 2)

    def test_resigned_upload_lifetime_and_staging_cleanup_use_the_latest_ticket(self):
        fingerprint = 'd' * 64
        with patch('cloud_materials.time.time', return_value=1000):
            ticket = self.library.create_upload(OWNER, 'clip.mp4', 5, fingerprint)
        item = self.library.get(OWNER, ticket['id'])
        with patch('cloud_materials.time.time', return_value=4500):
            self.library.create_upload(OWNER, 'clip.mp4', 5, fingerprint)
        with patch('cloud_materials.time.time', return_value=5000):
            self.library.cleanup()
            self.assertEqual(self.library.get(OWNER, ticket['id'])['state'], 'uploading')
            self.cos.objects[item['upload_key']] = b'short'
            self.assertEqual(self.library.complete(OWNER, ticket['id'])['state'], 'queued')
            self.cos.objects[item['upload_key']] = b'replayed staging'
            self.library.cleanup()
            self.assertIn(item['upload_key'], self.cos.objects)
        with patch('cloud_materials.time.time', return_value=8500):
            self.library.cleanup()
        self.assertNotIn(item['upload_key'], self.cos.objects)
        self.assertEqual(self.cos.objects[item['key']], b'short')

    def test_cleanup_waits_for_resigning_before_selecting_expired_uploads(self):
        fingerprint = 'd' * 64
        with patch('cloud_materials.time.time', return_value=1000):
            ticket = self.library.create_upload(OWNER, 'clip.mp4', 5, fingerprint)
        entered, release = threading.Event(), threading.Event()
        signing = self.cos.get_presigned_url

        def paused(**kwargs):
            entered.set()
            self.assertTrue(release.wait(5))
            return signing(**kwargs)

        with ThreadPoolExecutor(max_workers=2) as pool, \
                patch('cloud_materials.time.time', return_value=6000), \
                patch.object(self.cos, 'get_presigned_url', side_effect=paused):
            renewing = pool.submit(self.library.create_upload, OWNER, 'clip.mp4', 5, fingerprint)
            self.assertTrue(entered.wait(5))
            cleaning = pool.submit(self.library.cleanup)
            try:
                self.assertFalse(cleaning.done(), 'cleanup must not select the old expiry during signing')
            finally:
                release.set()
            self.assertEqual(renewing.result()['id'], ticket['id'])
            cleaning.result()
        self.assertEqual(self.library.get(OWNER, ticket['id'])['state'], 'uploading')

    def test_parallel_resume_and_complete_reuse_one_asset_and_copy_once(self):
        fingerprint = 'd' * 64
        clients = [CloudMaterials(self.root, client=self.cos, env=ENV) for _ in range(4)]
        with ThreadPoolExecutor(max_workers=4) as pool:
            tickets = list(pool.map(lambda library: library.create_upload(OWNER, 'clip.mp4', 5, fingerprint), clients))
        self.assertEqual(len({ticket['id'] for ticket in tickets}), 1)
        item = self.library.get(OWNER, tickets[0]['id'])
        self.cos.objects[item['upload_key']] = b'short'
        with ThreadPoolExecutor(max_workers=4) as pool:
            outcomes = list(pool.map(lambda n: clients[n].create_upload(OWNER, 'clip.mp4', 5, fingerprint)
                if n % 2 else clients[n].complete(OWNER, item['id']), range(4)))
        self.assertTrue(all(outcome.get('item', outcome)['state'] == 'queued' for outcome in outcomes))
        self.assertEqual(len(self.cos.copies), 1)
        self.assertEqual(len(self.library.list(OWNER)), 1)

    def test_upload_routes_accept_optional_fingerprint_and_return_existing_item(self):
        from app import create_app
        app = create_app(root=self.root, token='t' * 64, start_worker=False, cloud_library=self.library)
        headers = {'Authorization': 'Bearer ' + 't' * 64, 'x-material-owner': OWNER}
        payload = {'name': 'clip.mp4', 'bytes': 5, 'fingerprint': 'd' * 64}
        with TestClient(app) as client:
            initial = client.post('/v1/mix/materials/uploads', headers=headers, json=payload)
            self.assertEqual(initial.status_code, 201, initial.text)
            item = self.library.get(OWNER, initial.json()['id'])
            self.cos.objects[item['upload_key']] = b'short'
            recovered = client.post('/v1/mix/materials/uploads', headers=headers, json=payload)
            self.assertEqual(recovered.status_code, 201, recovered.text)
            self.assertEqual(recovered.json()['item']['state'], 'queued')
            self.assertNotIn('upload_url', recovered.json())
            for invalid in [{**payload, 'fingerprint': None}, {**payload, 'name': 'different.mp4'},
                            {**payload, 'unexpected': True}, {**payload, 'reuse_legacy': 'true'},
                            {'name': 'clip.mp4', 'bytes': 5, 'reuse_legacy': True}]:
                self.assertEqual(client.post('/v1/mix/materials/uploads', headers=headers, json=invalid).status_code, 400)
            legacy = client.post('/v1/mix/materials/uploads', headers=headers, json={'name': 'clip.mp4', 'bytes': 5})
            self.assertEqual(legacy.status_code, 201, legacy.text)
            self.assertIn('upload_url', legacy.json())
            items = client.get('/v1/mix/materials', headers=headers).json()['items']
            self.assertIsNone(next(item for item in items if item['id'] == legacy.json()['id'])['fingerprint'])
            claimed = client.post('/v1/mix/materials/uploads', headers=headers,
                                  json={**payload, 'fingerprint': 'e' * 64, 'reuse_legacy': True})
            self.assertEqual(claimed.status_code, 201, claimed.text)
            self.assertEqual(claimed.json()['id'], legacy.json()['id'])

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
