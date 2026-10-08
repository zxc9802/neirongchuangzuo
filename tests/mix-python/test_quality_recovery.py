import json
import sys
import tempfile
import unittest
import subprocess
import numpy as np
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT.parent / 'services/mix/python')]

import finish
import media
import captions
import quality
from matcher import file_stamp


class QualityRecoveryTests(unittest.TestCase):
    def test_subtitle_rebuild_reuses_saved_clips_and_preserves_voice_timeline(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, voice = root / 'source.mp4', root / 'voice.wav'
            media.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=25',
                       '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(source)])
            media.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=600:sample_rate=48000',
                       '-t', '1', '-c:a', 'pcm_s16le', str(voice)])
            plan = {'fps': 25, 'seed': 1, 'narration': str(voice), 'output_color': 'bt709',
                    'scenes': [{'text': '保留原来的配音与镜头只调整字幕换行', 'start': 0, 'end': 1,
                    'match': {'selected': {'path': str(source), 'stamp': file_stamp(source),
                    'source_start': 0, 'verified_start': 0, 'verified_end': 1}}}]}
            output = root / 'out'
            media.render(plan, output, 360, 640, log=lambda _: None)
            clip = output / 'clip-001-01.mp4'
            clip_bytes, voice_bytes = clip.read_bytes(), voice.read_bytes()
            source.unlink()
            result = captions.rebuild(plan, output, 360, 640)
            self.assertEqual(clip.read_bytes(), clip_bytes)
            self.assertEqual(voice.read_bytes(), voice_bytes)
            self.assertEqual(quality.inspect_media(result, plan)['issues'], [])

    def test_long_chinese_caption_stays_inside_frame_without_losing_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'source.mp4'
            media.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=360x640:r=25',
                       '-t', '0.4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(source)])
            text = '评论区扣个1我把我们现在住的房间和住宿价格发给你看看'
            plan = {'fps': 25, 'seed': 1, 'scenes': [{'text': text, 'start': 0, 'end': .4,
                'match': {'selected': {'path': str(source), 'stamp': file_stamp(source),
                'source_start': 0, 'verified_start': 0, 'verified_end': .4}}}]}
            video = media.render(plan, root / 'out', 360, 640)
            frame = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(video),
                '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'])
            pixels = np.frombuffer(frame, dtype=np.uint8).reshape(640, 360, 3)
            ys, xs = np.where(pixels.min(axis=2) > 160)
            self.assertGreater(len(xs), 100)
            self.assertGreater(xs.min(), 12, '左侧字幕贴边或被裁切')
            self.assertLess(xs.max(), 348, '右侧字幕贴边或被裁切')
            self.assertTrue((root / 'out' / 'display.ass').is_file(), '必须写入明确换行的字幕，不能依赖服务器中文自动换行能力')
            ass = (root / 'out' / 'display.ass').read_text(encoding='utf-8')
            self.assertIn(text, ass.replace('\\N', ''))

    def test_subtitle_failure_rebuilds_captions_then_reviews_again(self):
        report = {'passed': False, 'segments': [{'passed': False, 'issues': [
            {'type': 'subtitle', 'severity': 'error', 'scene': 1, 'start': 0, 'end': 2,
             'problem': '字幕两端裁切', 'suggestion': '自动换行'}]}]}
        with tempfile.TemporaryDirectory() as tmp, patch('finish.Models'), \
             patch('finish.prepare_shots'), \
             patch('finish.media.render', return_value=Path(tmp) / 'video.mp4') as render, \
             patch('finish.quality.review', side_effect=[report, {'passed': True}]) as review:
            plan = {'fps': 25, 'scenes': [{'start': 0, 'end': 2, 'text': '字幕测试'}]}
            with patch('finish.rebuild_captions', create=True, return_value=Path(tmp) / 'video.mp4') as rebuild:
                try:
                    result = finish.deliver(plan, tmp, log=lambda _: None)
                except ValueError as exc:
                    self.fail(f'字幕错误应先修正后复查，而非直接退出：{exc}')
            self.assertEqual(result, Path(tmp) / 'video.mp4')
            self.assertEqual(review.call_count, 2)
            rebuild.assert_called_once()
            render.assert_called_once()

    def test_failure_explains_scene_time_evidence_and_suggestion(self):
        report = {'passed': False, 'technical': {'issues': []}, 'segments': [
            {'start': 0, 'duration': 8, 'passed': False, 'issues': [
                {'type': 'audio_cutoff', 'severity': 'error', 'scene': 1,
                 'start': 6.5, 'end': 8, 'problem': '最后两个字缺失',
                 'suggestion': '重新生成第一段配音'}]}]}
        logs = []
        with tempfile.TemporaryDirectory() as tmp, patch('finish.Models'), \
             patch('finish.prepare_shots'), \
             patch('finish.media.render', return_value=Path(tmp) / 'video.mp4'), \
             patch('finish.quality.review', return_value=report):
            with self.assertRaises(ValueError) as error:
                finish.deliver({'scenes': [{'start': 0, 'end': 8}]}, tmp, log=logs.append)
        self.assertIn('最后两个字缺失', str(error.exception))
        self.assertTrue(any('场景 1' in line and '6.50' in line and '最后两个字缺失' in line for line in logs))
        self.assertTrue(any('重新生成第一段配音' in line for line in logs))

if __name__ == '__main__':
    unittest.main()
