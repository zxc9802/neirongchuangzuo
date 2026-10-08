import hashlib
import json
import math
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'services/mix/python'))
from app import create_app, Jobs
from credits import CreditError
from local_materials import MaterialsPending


class Wallet:
    def __init__(self, available=1000):
        self.available, self.held = available, 0
        self.records, self.reserves, self.charges = {}, 0, 0
        self.fail_settle = False
        self.lost_settle_reply = False

    def snapshot(self, owner):
        return {'available': self.available, 'held': self.held,
                'pricing': {'videoPoints': 333, 'videoSeconds': 30}}

    def read(self, owner, task):
        return self.records.get(task)

    def reserve(self, owner, task, units):
        if task in self.records:
            return self.records[task]
        points = math.ceil(units * 333 / 30)
        if points > self.available:
            raise CreditError('积分不足', 402)
        self.available -= points
        self.held += points
        self.reserves += 1
        self.records[task] = {'status': 'reserved', 'reservedPoints': points, 'chargedPoints': 0}
        return self.records[task]

    def extend(self, owner, task, units):
        record = self.records[task]
        extra = max(0, math.ceil(units * 333 / 30) - record['reservedPoints'])
        if extra > self.available:
            raise CreditError('积分不足', 402)
        self.available -= extra
        self.held += extra
        record['reservedPoints'] += extra
        return record

    def settle(self, owner, task, units):
        if self.fail_settle:
            self.fail_settle = False
            raise CreditError('结算暂未确认', uncertain=True)
        record = self.records[task]
        if record['status'] == 'settled':
            return record
        points = math.ceil(units * 333 / 30)
        if points > self.available + record['reservedPoints']:
            raise CreditError('积分不足', 402)
        self.available += record['reservedPoints'] - points
        self.held -= record['reservedPoints']
        record.update(status='settled', chargedPoints=points)
        self.charges += 1
        if self.lost_settle_reply:
            self.lost_settle_reply = False
            raise CreditError('结算回复丢失', uncertain=True)
        return record

    def release(self, owner, task):
        record = self.records[task]
        if record['status'] == 'reserved':
            self.available += record['reservedPoints']
            self.held -= record['reservedPoints']
            record['status'] = 'released'
        return record


def checked_runner(spec, folder, log):
    result = folder / 'video.mp4'
    result.write_bytes(b'checked-video')
    (folder / 'quality-report.json').write_text(json.dumps({
        'passed': True, 'sha256': hashlib.sha256(result.read_bytes()).hexdigest()}), encoding='utf-8')
    return result


class CreditsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.wallet = Wallet()
        self.app = create_app(self.root, 'x' * 40, start_worker=False, credits=self.wallet)
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)
        self.jobs = self.app.state.jobs
        self.owner = 'a' * 64
        self.headers = {'Authorization': 'Bearer ' + 'x' * 40, 'X-Material-Owner': self.owner}
        device = self.client.post('/v1/browser-materials/connect', headers=self.headers,
                                 json={'folder_key': 'd' * 64, 'name': '我的素材'}).json()['device_id']
        self.spec = {'text': '真' * 120, 'device_id': device, 'voice_mode': 'original',
                     'ratio': '9:16', 'quality': '720p', 'music': False}

    def submit(self, key='one', body=None):
        return self.client.post('/v1/mix/jobs', json=body or self.spec,
                                headers={**self.headers, 'Idempotency-Key': key})

    def run_job(self, seconds=30, runner=checked_runner):
        with patch('app.media_duration', return_value=seconds):
            return self.jobs.run_one(runner)

    def test_submit_reserves_once_and_real_duration_settles_once_without_polling(self):
        first = self.submit()
        self.assertEqual(first.status_code, 202, first.text)
        ident = first.json()['id']
        self.assertEqual(self.submit().json()['id'], ident)
        self.assertEqual(self.wallet.reserves, 1)
        self.assertGreater(self.wallet.held, 333)
        self.run_job(30)
        self.assertEqual(self.wallet.available, 667)
        self.assertEqual(self.wallet.held, 0)
        self.assertEqual(self.wallet.charges, 1)
        self.assertEqual(self.jobs.get(ident)['billing']['chargedPoints'], 333)
        self.assertEqual(self.jobs.get(ident)['state'], 'done')
        self.assertEqual(self.submit().json()['id'], ident)
        self.assertEqual(self.wallet.charges, 1)

    def test_insufficient_long_script_cannot_queue_any_paid_runner(self):
        self.wallet.available = 100
        response = self.submit()
        self.assertEqual(response.status_code, 402, response.text)
        called = []
        self.assertFalse(self.jobs.run_one(lambda *args: called.append(args)))
        self.assertEqual(called, [])
        self.assertEqual(self.wallet.reserves, 0)

    def test_original_audio_settles_actual_sixty_seconds_instead_of_script_preview(self):
        ident = self.submit().json()['id']
        self.run_job(60)
        self.assertEqual(self.jobs.get(ident)['billing']['chargedPoints'], 666)
        self.assertEqual(self.wallet.available, 334)

    def test_confirmed_failure_refunds_and_resume_uses_a_new_attempt(self):
        ident = self.submit().json()['id']
        old_id = self.jobs.get(ident)['billing']['creditId']
        self.run_job(runner=lambda *args: (_ for _ in ()).throw(ValueError('照片无法剪辑')))
        self.assertEqual(self.wallet.available, 1000)
        self.assertEqual(self.wallet.held, 0)
        self.assertEqual(self.jobs.get(ident)['state'], 'failed')
        resumed = self.jobs.resume(ident, self.owner)
        self.assertNotEqual(resumed['billing']['creditId'], old_id)
        self.run_job(30)
        self.assertEqual(self.wallet.charges, 1)
        self.assertEqual(self.wallet.available, 667)

    def test_settlement_outage_keeps_artifact_and_hold_then_only_retries_settlement(self):
        ident = self.submit().json()['id']
        self.wallet.fail_settle = True
        self.run_job(30)
        self.assertEqual(self.jobs.get(ident)['state'], 'interrupted')
        self.assertEqual(self.jobs.get(ident)['billing']['status'], 'settle_pending')
        self.assertGreater(self.wallet.held, 0)
        self.assertEqual(self.client.get(f'/v1/mix/jobs/{ident}/video', headers=self.headers).status_code, 409)
        self.jobs = Jobs(self.root, credits=self.wallet)
        self.jobs.resume(ident, self.owner)
        self.run_job(30, lambda *args: self.fail('已成片结算恢复不得重新调用生成'))
        self.assertEqual(self.jobs.get(ident)['state'], 'done')
        self.assertEqual(self.wallet.charges, 1)

    def test_lost_settlement_reply_does_not_charge_twice_after_restart(self):
        ident = self.submit().json()['id']
        self.wallet.lost_settle_reply = True
        self.run_job(30)
        self.assertEqual(self.jobs.get(ident)['state'], 'interrupted')
        self.assertEqual(self.wallet.charges, 1)
        self.jobs = Jobs(self.root, credits=self.wallet)
        self.jobs.resume(ident, self.owner)
        self.run_job(30, lambda *args: self.fail('不得再次生成'))
        self.assertEqual(self.wallet.charges, 1)
        self.assertEqual(self.wallet.available, 667)

    def test_waiting_materials_keeps_hold_and_expiry_releases_it(self):
        ident = self.submit().json()['id']
        with patch.object(self.jobs.materials, 'request_ready', return_value=False):
            self.run_job(runner=lambda *args: (_ for _ in ()).throw(MaterialsPending('b' * 32)))
        self.assertEqual(self.jobs.get(ident)['state'], 'waiting_materials')
        self.assertGreater(self.wallet.held, 0)
        with self.jobs.connect() as db:
            db.execute('UPDATE jobs SET updated=? WHERE id=?', (time.time() - 73 * 3600, ident))
        self.jobs.cleanup()
        self.assertEqual(self.jobs.get(ident)['state'], 'expired')
        self.assertEqual(self.wallet.available, 1000)
        self.assertEqual(self.wallet.held, 0)

    def test_paid_provider_uncertainty_preserves_hold_and_same_attempt(self):
        ident = self.submit().json()['id']
        credit_id = self.jobs.get(ident)['billing']['creditId']
        def uncertain(spec, folder, log):
            cache = folder / 'voice-cache'
            cache.mkdir()
            (cache / 'task.json').write_text(json.dumps({'submission': 'uncertain'}))
            raise RuntimeError('配音回复中断')
        self.run_job(runner=uncertain)
        self.assertEqual(self.jobs.get(ident)['state'], 'interrupted')
        self.assertGreater(self.wallet.held, 0)
        self.jobs.resume(ident, self.owner)
        self.assertEqual(self.jobs.get(ident)['billing']['creditId'], credit_id)
        self.assertEqual(self.wallet.reserves, 1)

    def test_credit_pending_confirmation_reuses_original_units_and_never_runs_paid_work_before_confirmation(self):
        original = self.wallet.reserve
        def lost_reply(owner, task, units):
            record = original(owner, task, units)
            raise CreditError('预留回复丢失', uncertain=True)
        self.wallet.reserve = lost_reply
        response = self.submit()
        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(response.json()['state'], 'credit_pending')
        job = self.jobs.list(self.owner)[0]
        self.assertEqual(job['state'], 'credit_pending')
        old_id = job['billing']['creditId']
        self.assertFalse(self.jobs.run_one(lambda *args: self.fail('积分未确认不得付费生成')))
        self.wallet.reserve = original
        self.jobs.resume(job['id'], self.owner)
        self.assertEqual(self.jobs.get(job['id'])['billing']['creditId'], old_id)
        self.assertEqual(self.wallet.reserves, 1)
        self.run_job(30)
        self.assertEqual(self.wallet.charges, 1)

    def test_credit_pending_retry_with_insufficient_balance_fails_without_changing_attempt_or_calling_runner(self):
        original = self.wallet.reserve
        self.wallet.reserve = lambda *args: (_ for _ in ()).throw(CreditError('积分暂未确认', uncertain=True))
        self.assertEqual(self.submit().status_code, 202)
        job = self.jobs.list(self.owner)[0]
        old_id = job['billing']['creditId']
        self.wallet.reserve = original
        self.wallet.available = 10
        response = self.client.post(f"/v1/mix/jobs/{job['id']}/resume", headers=self.headers, json={})
        self.assertEqual(response.status_code, 402)
        failed = self.jobs.get(job['id'])
        self.assertEqual(failed['state'], 'failed')
        self.assertEqual(failed['billing']['creditId'], old_id)
        self.assertEqual(failed['billing']['status'], 'released')
        self.assertFalse(self.jobs.run_one(lambda *args: self.fail('不足不得调用模型')))

    def test_buffer_does_not_prevent_three_thirty_second_videos_from_a_thousand_points(self):
        for index in range(3):
            response = self.submit(str(index))
            self.assertEqual(response.status_code, 202, response.text)
            self.run_job(30)
        self.assertEqual(self.wallet.available, 1)
        self.assertEqual(self.wallet.held, 0)
        self.assertEqual(self.wallet.charges, 3)
        self.assertEqual(self.submit('fourth').status_code, 402)


if __name__ == '__main__':
    unittest.main()
