import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'services/mix/python'))
import matcher


class MatcherTests(unittest.TestCase):
    def test_split_keeps_every_character_and_does_not_invent_copy(self):
        source = '这里有游泳池，也能下棋。'
        scenes = [{'text': '这里有游泳池，', 'query': '游泳池'}, {'text': '也能下棋。', 'query': '下棋'}]
        result = matcher.validate_scenes(source, scenes)
        self.assertEqual(''.join(s['text'] for s in result), source)
        with self.assertRaises(ValueError):
            matcher.validate_scenes(source, [{'text': '这里有海滩', 'query': '海滩'}])

    def test_estimated_timeline_is_contiguous_and_marked(self):
        scenes = [{'text': '这里有游泳池。', 'query': '游泳池'}, {'text': '也能下棋。', 'query': '下棋'}]
        result = matcher.estimate_timeline(scenes, cps=4, fps=25)
        self.assertEqual(result[0]['start'], 0)
        self.assertEqual(result[1]['start'], result[0]['end'])
        self.assertTrue(all(s['timing'] == 'estimated' and s['end'] > s['start'] for s in result))

    def test_rejected_top_three_expand_and_rerank_new_candidates(self):
        calls = []
        def retrieve(query, k):
            calls.append(('retrieve', query, k))
            return [{'id': n} for n in range(1, 7)]
        def rerank(query, candidates):
            calls.append(('rerank', [c['id'] for c in candidates]))
            return candidates
        def judge(query, candidates):
            if candidates[0]['id'] == 1:
                return {'accepted': [], 'query': '有马桶和洗手台的卫生间', 'reason': '都是卧室'}
            return {'accepted': [{'id': 4, 'score': 0.95, 'start': 0, 'end': 3}], 'reason': '看到马桶'}
        result = matcher.choose_match('卫生间', retrieve, rerank, judge, seed=1)
        self.assertEqual(result['selected']['id'], 4)
        self.assertEqual(calls[2][2], 60)
        self.assertEqual(calls[3][1], [4, 5, 6])

    def test_no_match_stops_and_never_chooses_unapproved_candidate(self):
        result = matcher.choose_match('厕所', lambda q, k: [{'id': n} for n in range(k)],
            lambda q, c: c, lambda q, c: {'accepted': [], 'reason': '卧室'}, seed=2)
        self.assertIsNone(result['selected'])
        self.assertEqual(len(result['attempts']), 3)

    def test_judge_cannot_select_id_outside_top_three(self):
        with self.assertRaises(ValueError):
            matcher.choose_match('泳池', lambda q, k: [{'id': 1}], lambda q, c: c,
                lambda q, c: {'accepted': [{'id': 999, 'score': 1, 'start': 0, 'end': 2}]})

    def test_random_selection_only_from_equally_good_verified_candidates(self):
        def judge(q, c):
            return {'accepted': [{'id': i, 'score': s, 'start': 0, 'end': 3}
                                  for i, s in [(1, .95), (2, .92), (3, .7)]]}
        chosen = {matcher.choose_match('泳池', lambda q, k: [{'id': i} for i in [1,2,3]],
                  lambda q, c: c, judge, seed=i)['selected']['id'] for i in range(30)}
        self.assertEqual(chosen, {1, 2})

    def test_explicit_visual_acceptance_is_not_overridden_by_uncalibrated_score(self):
        result = matcher.choose_match('泳池', lambda q,k:[{'id':1}], lambda q,c:c,
            lambda q,c:{'accepted':[{'id':1,'score':.72,'start':0,'end':3}], 'reason':'清晰展示泳池'})
        self.assertEqual(result['selected']['id'],1)

    def test_unicode_path_faiss_roundtrip_and_stale_source_exclusion(self):
        import numpy as np
        with tempfile.TemporaryDirectory(prefix='素材测试') as tmp:
            root = Path(tmp)
            source = root / '游泳池.mov'
            source.write_bytes(b'original')
            db = matcher.Catalog(root / 'index', {'model': 'test'})
            db.add({'path': str(source), 'stamp': matcher.file_stamp(source), 'start': 0,
                    'end': 3, 'proxy': str(source), 'description': '游泳池'}, np.array([1.,0.]))
            search = db.searcher()
            self.assertEqual(search(np.array([1.,0.]), 3)[0]['description'], '游泳池')
            self.assertTrue((root / 'index' / 'vectors.faiss').exists())
            source.write_bytes(b'changed file content')
            with self.assertRaisesRegex(ValueError, '可用'):
                db.searcher()
            db.close()


if __name__ == '__main__':
    unittest.main()
