import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT.parent / 'services/mix/python')]

import finish
from local_materials import MaterialsPending
from matcher import write_json


class CoverageBroker:
    def __init__(self, root):
        self.root = root
        self.pending = True

    def indexed_clips(self, device_id):
        return [{'id': f'{number:064x}', 'numeric_id': number, 'start': 0., 'end': 8.,
                 'description': '园区散步', 'vector': [1., 0.]}
                for number in range(1, 76)]

    def request_clip(self, device, clip, kind, job):
        return {'id': clip + '-' + kind}

    def wait_clip(self, request_id):
        if self.pending and int(request_id.split('-')[0], 16) >= 4:
            raise MaterialsPending(request_id)
        source = self.root / (request_id + '.mp4')
        source.write_bytes(b'proxy')
        return source


class CoverageModels:
    def __init__(self):
        self.embeds = 0
        self.reranks = 0
        self.reviews = []
        self.invalid_interval = False

    def embed(self, *, text):
        self.embeds += 1
        return np.array([1., 0.], dtype=np.float32)

    def rerank(self, query, candidates):
        self.reranks += 1
        return candidates

    def json(self, prompt, videos):
        first = videos[0][0]
        self.reviews.append(first)
        if self.invalid_interval:
            return {'accepted': [{'id': first, 'score': .95, 'start': 0., 'end': 2.},
                                 {'id': videos[1][0], 'score': .9, 'start': 0., 'end': 9.}]}
        if first == 1:
            return {'accepted': [], 'reason': '画面不符'}
        return {'accepted': [{'id': first, 'score': .95, 'start': 0., 'end': 6.}]}


class RemoteCoverageCheckpointTests(unittest.TestCase):
    def catalog(self, root):
        folder = root / 'remote-catalog'
        write_json(folder / 'remote.json', {'root': str(root), 'device_id': 'a' * 32,
                                           'job_id': 'b' * 32})
        return folder

    def plan(self):
        return {'fps': 25, 'scenes': [{'text': '园区步道', 'query': '园区步道', 'start': 0.,
                'end': 6., 'match': {'selected': None, 'attempts': []}}]}

    def test_pending_next_group_resumes_saved_paid_checks_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            catalog, checkpoint = self.catalog(root), root / 'plan.json'
            plan, models, broker = self.plan(), CoverageModels(), CoverageBroker(root)
            write_json(checkpoint, plan)
            with patch('remote_catalog.broker_for', return_value=broker):
                with self.assertRaises(MaterialsPending):
                    finish.prepare_shots(plan, catalog, models, log=lambda _: None, checkpoint=checkpoint)
                saved = json.loads(checkpoint.read_text(encoding='utf-8'))
                broker.pending = False
                resumed = json.loads(checkpoint.read_text(encoding='utf-8'))
                finish.prepare_shots(resumed, catalog, models, log=lambda _: None, checkpoint=checkpoint)
            self.assertEqual(models.embeds, 1, 'Waiting for another proxy must not repeat paid embedding')
            self.assertEqual(models.reranks, 1)
            self.assertEqual(models.reviews, [1, 4], 'Completed rejection must not be billed again')
            progress = saved['scenes'][0]['coverage_progress']
            self.assertEqual(len(progress['ranked']), 60)
            self.assertEqual(len(progress['groups']), 1)
            self.assertEqual(len(saved['scenes'][0]['coverage_attempts']), 1)
            scene = resumed['scenes'][0]
            self.assertEqual(scene['shots'][0]['selected']['id'], 4)
            self.assertEqual(len(scene['coverage_attempts']), 2)
            self.assertNotIn('coverage_progress', scene)
            self.assertNotIn('coverage_progress', json.loads(checkpoint.read_text(encoding='utf-8'))['scenes'][0])

    def test_pending_quality_replacement_resumes_despite_existing_shots(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            catalog, checkpoint = self.catalog(root), root / 'plan.json'
            plan, models, broker = self.plan(), CoverageModels(), CoverageBroker(root)
            old = {'id': 75, 'source_start': 0., 'source_end': 8., 'verified_start': 0., 'verified_end': 6.}
            plan['scenes'][0]['shots'] = [{'selected': old, 'duration': 6.}]
            plan['scenes'][0]['match']['selected'] = old
            write_json(checkpoint, plan)
            with patch('remote_catalog.broker_for', return_value=broker):
                with self.assertRaises(MaterialsPending):
                    finish.prepare_shots(plan, catalog, models, log=lambda _: None,
                                         replace=(1,), checkpoint=checkpoint)
                resumed = json.loads(checkpoint.read_text(encoding='utf-8'))
                broker.pending = False
                finish.prepare_shots(resumed, catalog, models, log=lambda _: None, checkpoint=checkpoint)
            self.assertEqual(resumed['scenes'][0]['shots'][0]['selected']['id'], 4,
                             'Old quality-failed shots must not skip the unfinished replacement')
            self.assertEqual(models.embeds, 1)
            self.assertEqual(models.reranks, 1)
            self.assertEqual(models.reviews, [1, 4])
            self.assertNotIn('coverage_progress', resumed['scenes'][0])

    def test_invalid_interval_is_not_saved_as_completed_review(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            catalog, checkpoint = self.catalog(root), root / 'plan.json'
            plan, models, broker = self.plan(), CoverageModels(), CoverageBroker(root)
            models.invalid_interval = True
            broker.pending = False
            with patch('remote_catalog.broker_for', return_value=broker):
                with self.assertRaisesRegex(ValueError, '非法区间'):
                    finish.prepare_shots(plan, catalog, models, log=lambda _: None, checkpoint=checkpoint)
                self.assertTrue(checkpoint.is_file(), 'Retrieval must be saved before review')
                resumed = json.loads(checkpoint.read_text(encoding='utf-8'))
                self.assertEqual(resumed['scenes'][0]['coverage_progress']['groups'], {})
                self.assertNotIn('coverage_attempts', plan['scenes'][0])
                models.invalid_interval = False
                finish.prepare_shots(resumed, catalog, models, log=lambda _: None, checkpoint=checkpoint)
            self.assertEqual(models.embeds, 1)
            self.assertEqual(models.reranks, 1)
            self.assertEqual(models.reviews, [1, 1, 4], 'The invalid result must be reviewed again')
            self.assertEqual(len(resumed['scenes'][0]['coverage_attempts']), 2)


if __name__ == '__main__':
    unittest.main()
