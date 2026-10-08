"""Browser transfers and full mixer use real FFmpeg; paid model boundaries stubbed."""
import base64
import hashlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'services/mix/python'))
import media
import quality
from app import create_app, generate
from matcher import write_json


class Models:
    embed_url = 'test-embedding'
    llm_url = 'test-vision'

    def embed(self, **kwargs):
        return [1., 0.]

    def rerank(self, query, candidates):
        return sorted(candidates, key=lambda item: -item['origin_start'])

    def json(self, prompt, videos=None):
        if '"scenes"' in prompt:
            script = json.loads(prompt.split('\n')[-1])['script']
            return {'scenes': [{'text': script, 'query': '园区散步'}]}
        if '"accepted"' in prompt:
            return {'accepted': [{'id': videos[0][0], 'score': .95, 'start': .12, 'end': 7.8}],
                    'reason': '测试镜头'}
        return {'description': '真实园区散步画面'}


def frames():
    output = io.BytesIO()
    Image.new('RGB', (64, 96), (90, 150, 40)).save(output, format='JPEG')
    return ['data:image/jpeg;base64,' + base64.b64encode(output.getvalue()).decode()] * 8


class IntegrationTests(unittest.TestCase):
    def test_real_transfer_match_checkpoints_voice_once_render_and_download(self):
        with tempfile.TemporaryDirectory(prefix='网页素材 integration ') as directory:
            root = Path(directory)
            source = root / '原素材.mp4'
            media.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=64x96:r=25',
                       '-t', '16', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', str(source)])
            original = source.read_bytes()
            app = create_app(root / 'server', 's' * 40, start_worker=False)
            client = TestClient(app)
            self.addCleanup(client.close)
            headers = {'Authorization': 'Bearer ' + 's' * 40, 'X-Material-Owner': 'a' * 64}
            connected = client.post('/v1/browser-materials/connect',
                headers=headers, json={'folder_key': 'f' * 64, 'name': '我的素材'}).json()
            device = connected['device_id']
            prefix = '/v1/browser-materials/devices/' + device
            asset = hashlib.sha256(b'original-version').hexdigest()
            clips = [{'id': hashlib.sha256(str(start).encode()).hexdigest(), 'asset_id': asset,
                      'name': '我的素材/原素材.mp4', 'start': start, 'end': start + 8} for start in (0, 8)]
            self.assertEqual(client.post(prefix + '/clips', json={'clips': clips}, headers=headers).status_code, 200)
            embedding_calls, tts_calls = [], []

            class CountModels(Models):
                def embed(self, **kwargs):
                    if kwargs.get('video'):
                        embedding_calls.append(str(kwargs['video']))
                    return super().embed(**kwargs)

            def voice(plan, folder, **kwargs):
                tts_calls.append(True)
                narration = folder / 'narration.wav'
                media.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                           'sine=frequency=440:sample_rate=48000', '-t', '1.6', str(narration)])
                plan.update(narration=str(narration), timing='tts-segment', voice_settings={})
                plan['scenes'][0].update(start=0., end=1.6, voice=str(narration))
                media.write_srt(plan['scenes'], folder / 'captions.srt')
                write_json(folder / 'plan.json', plan)

            def review(video, plan, folder, *args, **kwargs):
                technical = quality.inspect_media(video, plan)
                self.assertEqual(technical['issues'], [])
                report = {'passed': True, 'sha256': hashlib.sha256(Path(video).read_bytes()).hexdigest(),
                          'video': str(video), 'technical': technical, 'issues': []}
                write_json(folder / 'quality-report.json', report)
                return report

            with patch('app.readiness', return_value={'configured': True}), \
                    patch('api.Models', CountModels), patch('matcher.Models', CountModels), \
                    patch('finish.Models', CountModels), patch('voice.synthesize_plan', side_effect=voice), \
                    patch('quality.review', side_effect=review):
                for clip in clips:
                    response = client.post(prefix + '/analyze', json={'clip_id': clip['id'], 'frames': frames()}, headers=headers)
                    self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(len(embedding_calls), 2)
                states = client.post(prefix + '/clips', json={'clips': clips}, headers=headers).json()
                self.assertEqual([item['state'] for item in states['clips']], ['indexed', 'indexed'])
                self.assertEqual(list(app.state.materials.folder.rglob('*.mp4')), [])
                submitted = client.post('/v1/mix/jobs', json={'text': '散步。', 'device_id': device,
                    'ratio': '1:1', 'quality': '720p', 'subtitles': False},
                    headers={**headers, 'Idempotency-Key': 'real-integration'})
                self.assertEqual(submitted.status_code, 202, submitted.text)
                job_id = submitted.json()['id']
                app.state.jobs.run_one(generate)
                self.assertEqual(app.state.jobs.get(job_id)['state'], 'waiting_materials')
                requests = client.get(prefix + '/requests', headers=headers).json()['requests']
                self.assertTrue(requests)
                for request in requests:
                    self.assertEqual(request['kind'], 'proxy')
                    response = client.post(prefix + '/requests/' + request['id'] + '/frames',
                        json={'frames': frames()}, headers=headers)
                    self.assertEqual(response.status_code, 200, response.text)
                app.state.jobs.run_one(generate)
                self.assertEqual(app.state.jobs.get(job_id)['state'], 'waiting_materials')
                request = client.get(prefix + '/requests', headers=headers).json()['requests'][0]
                self.assertEqual((request['kind'], request['start'], request['end']), ('source', 8., 16.))
                response = client.post(prefix + '/requests/' + request['id'] + '/file',
                    json={'size': len(original)}, headers=headers)
                self.assertEqual(response.status_code, 200, response.text)
                transfer = prefix + '/files/' + response.json()['id']
                response = client.patch(transfer, content=original, headers={**headers,
                    'Upload-Offset': '0', 'Upload-Checksum': hashlib.sha256(original).hexdigest()})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(client.post(transfer + '/complete', headers=headers).status_code, 200)
                app.state.jobs.run_one(generate)
                result = client.get('/v1/mix/jobs/' + job_id, headers=headers).json()
                self.assertEqual(result['state'], 'done', result['error'])
                self.assertEqual(len(tts_calls), 1)
                video = root / 'server/outputs' / job_id / 'video.mp4'
                self.assertAlmostEqual(media.duration(video), 1.6, delta=.08)
                streams = json.loads(media.run(['ffprobe', '-v', 'error', '-show_streams', '-of', 'json', str(video)]))['streams']
                self.assertEqual((streams[0]['width'], streams[0]['height']), (720, 720))
                self.assertIn('audio', [stream['codec_type'] for stream in streams])
                self.assertEqual(source.read_bytes(), original)
                self.assertEqual(client.get(prefix + '/requests', headers=headers).json()['requests'], [])
                public_plan = client.get('/v1/mix/jobs/' + job_id + '/plan', headers=headers).json()
                self.assertEqual(public_plan['script'], '散步。')
                self.assertNotIn('remote', json.dumps(public_plan))
                self.assertNotIn(str(root), json.dumps(public_plan))
                self.assertEqual(client.get('/v1/mix/jobs/' + job_id + '/video', headers=headers).content, video.read_bytes())


if __name__ == '__main__':
    unittest.main()
