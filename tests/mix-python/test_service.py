import hashlib
import json
import sqlite3
import sys
import tempfile
import time
import unittest
from contextlib import closing
from unittest.mock import patch
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'services/mix/python'))
try:
    from app import Jobs, create_app
except ModuleNotFoundError:
    create_app = None


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(create_app, 'internal browser remix service is missing')
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.app = create_app(self.root, 'x' * 40, start_worker=False)
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)
        self.headers = {'Authorization': 'Bearer ' + 'x' * 40, 'X-Material-Owner': 'a' * 64}
        response = self.client.post('/v1/browser-materials/connect', headers=self.headers,
            json={'folder_key': 'd' * 64, 'name': '我的素材'})
        self.assertEqual(response.status_code, 200, response.text)
        self.device = response.json()['device_id']
        self.spec = {'text': '散步。', 'device_id': self.device, 'ratio': '9:16',
                     'quality': '720p', 'subtitles': True, 'music': False, 'count': 1, 'duration': None}

    def submit(self, key='test-001', body=None, headers=None):
        return self.client.post('/v1/mix/jobs', json=body or self.spec,
            headers={**(headers or self.headers), 'Idempotency-Key': key})

    def test_health_requires_service_secret_and_reports_configuration(self):
        self.assertEqual(self.client.get('/health').status_code, 401)
        response = self.client.get('/health', headers=self.headers)
        self.assertEqual(response.status_code, 200)
        health = response.json()
        self.assertEqual(health['app'], 'browser-material-mixer')
        self.assertTrue(health['browser_materials'])
        self.assertIsInstance(health['missing'], list)
        self.assertIsInstance(health['configured'], bool)

    def test_idempotency_conflicts_and_owner_cannot_be_spoofed(self):
        first = self.submit()
        self.assertEqual(first.status_code, 202, first.text)
        self.assertEqual(self.submit().json()['id'], first.json()['id'])
        self.assertEqual(self.submit(body={**self.spec, 'text': '另一个文案'}).status_code, 409)
        other = {**self.headers, 'X-Material-Owner': 'b' * 64}
        self.assertEqual(self.submit(headers=other).status_code, 404)
        self.assertEqual(self.submit(body={**self.spec, 'owner': 'b' * 64}).status_code, 400)
        self.assertEqual(self.submit(headers={'Authorization': self.headers['Authorization']}).status_code, 401)

    def test_jobs_and_every_artifact_are_owner_scoped(self):
        job_id = self.submit().json()['id']
        other = {**self.headers, 'X-Material-Owner': 'b' * 64}
        self.assertEqual(self.client.get('/v1/mix/jobs', headers=other).json()['jobs'], [])
        for suffix in ('', '/video', '/plan', '/captions'):
            self.assertEqual(self.client.get('/v1/mix/jobs/' + job_id + suffix, headers=other).status_code, 404)
        for suffix in ('/video', '/plan', '/captions'):
            self.assertEqual(self.client.head('/v1/mix/jobs/' + job_id + suffix, headers=other).status_code, 404)
        self.assertEqual(self.client.post('/v1/mix/jobs/' + job_id + '/resume', headers=other).status_code, 404)
        result = self.client.get('/v1/mix/jobs/' + job_id, headers=self.headers).json()
        self.assertEqual((result['id'], result['state'], result['logs'], result['error']),
                         (job_id, 'queued', [], None))
        self.assertNotIn('owner', result)
        self.assertNotIn('spec', result)

    def test_rejects_unsupported_options_and_non_browser_devices(self):
        for name, value in [('count', 3), ('duration', 30), ('music', True), ('subtitles', 'true'),
                            ('ratio', 'bad'), ('quality', '4k'), ('count', True)]:
            with self.subTest(name=name, value=value):
                self.assertEqual(self.submit(body={**self.spec, name: value}).status_code, 400)
        pair = self.app.state.materials.pair('a' * 64)
        helper = self.app.state.materials.redeem(pair['code'], 'helper')
        self.assertEqual(self.submit(body={**self.spec, 'device_id': helper['device_id']}).status_code, 404)

    def test_restart_marks_running_interrupted_and_preserves_checkpoints(self):
        job_id = self.submit().json()['id']
        folder = self.root / 'outputs' / job_id
        folder.mkdir(parents=True)
        (folder / 'plan.json').write_text('{"script":"散步。"}', encoding='utf-8')
        with self.app.state.jobs.connect() as db:
            db.execute("UPDATE jobs SET state='running' WHERE id=?", (job_id,))
        restarted = create_app(self.root, 'x' * 40, start_worker=False)
        self.assertEqual(restarted.state.jobs.get(job_id)['state'], 'interrupted')
        self.assertEqual((folder / 'plan.json').read_text(encoding='utf-8'), '{"script":"散步。"}')
        self.assertFalse(restarted.state.jobs.run_one(lambda *args: self.fail('must not auto replay')))

    def test_legacy_jobs_gain_nullable_run_start_without_automatic_resume(self):
        legacy = self.root / 'legacy'
        legacy.mkdir()
        job_id = '1' * 32
        with closing(sqlite3.connect(legacy / 'jobs.sqlite3')) as db, db:
            db.execute('''CREATE TABLE jobs (
                id TEXT PRIMARY KEY, request_key TEXT UNIQUE, owner TEXT NOT NULL, spec TEXT,
                state TEXT, created REAL, updated REAL, logs TEXT, result TEXT, error TEXT)''')
            db.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?)',
                       (job_id, 'legacy', 'a' * 64, '{}', 'failed', 100, 200, '[]', None, '旧任务失败'))
        jobs = Jobs(legacy)
        job = jobs.get(job_id)
        self.assertIsNone(job['started'])
        self.assertEqual((job['state'], job['created'], job['updated']), ('failed', 100, 200))
        self.assertFalse(jobs.run_one(lambda *args: self.fail('must not auto replay')))
        self.assertIsNone(Jobs(legacy).get(job_id)['started'])

    def test_each_run_has_its_own_start_time_and_reads_do_not_resume(self):
        submitted = self.submit().json()
        job_id = submitted['id']
        self.assertIsNone(submitted['started'])
        jobs = self.app.state.jobs
        first_start = time.time() + 10

        def fail_attempt(spec, folder, log):
            self.assertEqual(jobs.get(job_id)['started'], expected_start)
            raise ValueError('测试失败')

        for expected_start in (first_start, first_start + 86400):
            with patch('app.time.time', return_value=expected_start):
                self.assertTrue(jobs.run_one(fail_attempt))
            current = self.client.get('/v1/mix/jobs/' + job_id, headers=self.headers).json()
            self.assertEqual(current['state'], 'failed')
            self.assertEqual(current['error'], '测试失败')
            self.assertEqual(current['started'], expected_start)
            self.assertEqual(current['created'], submitted['created'])
            listed = self.client.get('/v1/mix/jobs', headers=self.headers).json()['jobs'][0]
            self.assertEqual(listed['started'], expected_start)
            self.assertEqual(jobs.get(job_id)['state'], 'failed')
            self.assertFalse(jobs.run_one(lambda *args: self.fail('GET must not resume')))
            if expected_start == first_start:
                resumed = self.client.post('/v1/mix/jobs/' + job_id + '/resume', headers=self.headers)
                self.assertEqual(resumed.status_code, 202, resumed.text)
                self.assertEqual(resumed.json()['state'], 'queued')
                self.assertIsNone(resumed.json()['started'])

    def test_worker_publishes_progress_before_the_first_model_request(self):
        job_id = self.submit(body={**self.spec, 'voice_mode': 'original'}).json()['id']
        observed = []

        def blocked_model(*args, **kwargs):
            observed.extend(self.app.state.jobs.get(job_id)['logs'])
            raise ValueError('测试模型不可用')

        with patch('app.readiness', return_value={'configured': True}), \
             patch('matcher.create_plan', side_effect=blocked_model):
            self.app.state.jobs.run_one()
        self.assertTrue(any('任务已开始' in line for line in observed), observed)
        self.assertTrue(any('拆解文案' in line for line in observed), observed)
        result = self.client.get('/v1/mix/jobs/' + job_id, headers=self.headers).json()
        self.assertEqual(result['state'], 'failed')
        self.assertIn('测试模型不可用', result['error'])

    def test_quality_gate_and_local_authenticated_stream(self):
        job_id = self.submit().json()['id']
        def runner(spec, folder, log):
            video = folder / 'video.mp4'
            video.write_bytes(b'checked-video')
            (folder / 'quality-report.json').write_text(json.dumps({
                'passed': True, 'sha256': hashlib.sha256(video.read_bytes()).hexdigest()}), encoding='utf-8')
            (folder / 'plan.json').write_text(json.dumps({'script': spec['text'], 'scenes': []}), encoding='utf-8')
            (folder / 'captions.srt').write_text('字幕', encoding='utf-8')
            return video
        self.app.state.jobs.run_one(runner)
        result = self.client.get('/v1/mix/jobs/' + job_id, headers=self.headers).json()
        self.assertEqual(result['state'], 'done', result['error'])
        self.assertEqual(result['video_url'], '/api/mix/jobs/' + job_id + '/video')
        self.assertEqual(self.client.get('/v1/mix/jobs/' + job_id + '/video', headers=self.headers).content,
                         b'checked-video')
        self.assertEqual(self.client.get('/v1/mix/jobs/' + job_id + '/captions', headers=self.headers).text, '字幕')
        for suffix in ('/video', '/plan', '/captions'):
            url = '/v1/mix/jobs/' + job_id + suffix
            get = self.client.get(url, headers=self.headers)
            head = self.client.head(url, headers=self.headers)
            self.assertEqual(head.status_code, 200)
            self.assertEqual(head.content, b'')
            self.assertEqual(head.headers['content-length'], get.headers['content-length'])
            self.assertEqual(head.headers['content-type'], get.headers['content-type'])
        # Report mismatch is rejected at completion.
        failed_id = self.submit('test-002').json()['id']
        def invalid(spec, folder, log):
            video = runner(spec, folder, log)
            video.write_bytes(b'changed')
            return video
        self.app.state.jobs.run_one(invalid)
        self.assertEqual(self.app.state.jobs.get(failed_id)['state'], 'failed')
        self.assertEqual(self.client.get('/v1/mix/jobs/' + failed_id + '/video', headers=self.headers).status_code, 409)

    def test_retention_removes_outputs_after_72h_and_records_after_30d(self):
        job_id = self.submit().json()['id']
        folder = self.root / 'outputs' / job_id
        folder.mkdir(parents=True)
        (folder / 'video.mp4').write_bytes(b'old')
        with self.app.state.jobs.connect() as db:
            db.execute("UPDATE jobs SET state='done',updated=? WHERE id=?", (time.time() - 73 * 3600, job_id))
        self.app.state.jobs.cleanup()
        self.assertFalse(folder.exists())
        self.assertEqual(self.app.state.jobs.get(job_id)['state'], 'expired')
        with self.app.state.jobs.connect() as db:
            db.execute('UPDATE jobs SET updated=? WHERE id=?', (time.time() - 31 * 86400, job_id))
        self.app.state.jobs.cleanup()
        self.assertEqual(self.client.get('/v1/mix/jobs/' + job_id, headers=self.headers).status_code, 404)


if __name__ == '__main__':
    unittest.main()
