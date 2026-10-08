import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parent / 'services/mix/python'))


class FakeBroker:
    pending = False

    def __init__(self, root):
        self.root = Path(root)
        self.calls = []

    def indexed_clips(self, device_id):
        return [{'id': 'a' * 64, 'numeric_id': 7, 'asset_id': 'c' * 64, 'start': 32., 'end': 40.,
                 'description': '园区散步', 'vector': [1., 0.]},
                {'id': 'b' * 64, 'numeric_id': 9, 'asset_id': 'd' * 64, 'start': 8., 'end': 16.,
                 'description': '泳池', 'vector': [0., 1.]}]

    def request_clip(self, device, clip, kind, job):
        self.calls.append((clip, kind))
        return {'id': clip + '-' + kind}

    def wait_clip(self, request_id, timeout=1):
        return self.root / (request_id + '.mp4')


class RemoteCatalogTests(unittest.TestCase):
    def test_waiting_for_next_candidate_group_reuses_paid_retrieval_and_visual_checks(self):
        from matcher import choose_match
        progress, calls = {}, []
        def retrieve(query, count):
            calls.append('retrieve')
            return [{'id': number, 'source_start': 0., 'source_end': 8.} for number in range(1, 7)]
        def rerank(query, candidates):
            calls.append('rerank')
            return candidates
        def judge(query, candidates):
            calls.append(candidates[0]['id'])
            if candidates[0]['id'] == 1:
                return {'accepted': [], 'query': query}
            if calls.count(4) == 1:
                raise TimeoutError('Waiting for the next three proxy uploads')
            return {'accepted': [{'id': 4, 'score': .95, 'start': 0., 'end': 2.}]}
        try:
            with self.assertRaises(TimeoutError):
                choose_match('散步', retrieve, rerank, judge, progress=progress)
        except TypeError:
            self.fail('Remote scene group checkpoints have not been implemented')
        result = choose_match('散步', retrieve, rerank, judge, progress=progress)
        self.assertEqual(result['selected']['id'], 4)
        self.assertEqual(calls.count('retrieve'), 2)
        self.assertEqual(calls.count('rerank'), 2)
        self.assertEqual(calls.count(1), 1, 'A completed rejected visual review must not be billed again')

    def test_search_never_requires_user_originals_and_keeps_original_interval(self):
        try:
            from remote_catalog import RemoteCatalog
        except ImportError:
            self.fail('RemoteCatalog has not been implemented')
        with tempfile.TemporaryDirectory() as temp, patch('remote_catalog.broker_for', FakeBroker):
            catalog = RemoteCatalog({'root': temp, 'device_id': 'e' * 32, 'job_id': 'f' * 32})
            clips = catalog.searcher()(np.array([1., 0.]), 1)
            self.assertEqual(clips[0]['description'], '园区散步')
            self.assertEqual((clips[0]['source_start'], clips[0]['source_end']), (0, 8))
            self.assertEqual((clips[0]['origin_start'], clips[0]['origin_end']), (32, 40))
            self.assertEqual(clips[0]['remote']['clip_id'], 'a' * 64)
            self.assertEqual(clips[0]['id'], 7, 'Indexing more files must not renumber saved scene candidates')
            self.assertFalse(Path(clips[0]['path']).exists())

    def test_all_proxy_requests_are_enqueued_before_waiting_and_only_candidates_are_fetched(self):
        try:
            from remote_catalog import RemoteCatalog, hydrate
        except ImportError:
            self.fail('RemoteCatalog hydrate has not been implemented')
        with tempfile.TemporaryDirectory() as temp:
            broker = FakeBroker(temp)
            def fail_wait(*args, **kwargs):
                raise TimeoutError('not yet uploaded')
            broker.wait_clip = fail_wait
            with patch('remote_catalog.broker_for', return_value=broker):
                catalog = RemoteCatalog({'root': temp, 'device_id': 'e' * 32, 'job_id': 'f' * 32})
                candidates = catalog.searcher()(np.array([1., 0.]), 2)
                with self.assertRaises(TimeoutError):
                    hydrate(candidates, 'proxy')
            self.assertEqual(broker.calls, [('a' * 64, 'proxy'), ('b' * 64, 'proxy')])

    def test_source_hydration_remaps_file_stamp_but_keeps_exact_zero_based_time(self):
        try:
            from remote_catalog import RemoteCatalog, hydrate
        except ImportError:
            self.fail('RemoteCatalog hydrate has not been implemented')
        with tempfile.TemporaryDirectory() as temp:
            broker = FakeBroker(temp)
            source = Path(temp) / ('a' * 64 + '-source.mp4')
            source.write_bytes(b'uploaded-source')
            with patch('remote_catalog.broker_for', return_value=broker):
                catalog = RemoteCatalog({'root': temp, 'device_id': 'e' * 32, 'job_id': 'f' * 32})
                selected = catalog.searcher()(np.array([1., 0.]), 1)[0]
                selected.update(verified_start=2., verified_end=5.)
                hydrate([selected], 'source')
                self.assertEqual(Path(selected['path']).read_bytes(), b'uploaded-source')
                self.assertEqual(selected['source_start'] + selected['verified_start'], 2.)
                self.assertTrue(selected['stamp'].startswith('15:'))


if __name__ == '__main__':
    unittest.main()
