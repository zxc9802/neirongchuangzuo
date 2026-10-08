import json
import inspect
import sys
import tempfile
import threading
import unittest
import subprocess
import numpy as np
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'services/mix/python'))
import media
from matcher import file_stamp


class MediaConcurrencyTests(unittest.TestCase):
    def make_plan(self, root):
        source = root/'source.mp4'
        media.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=25',
                   '-t', '0.4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(source)])
        selected = {'path': str(source), 'stamp': file_stamp(source), 'source_start': 0,
                    'verified_start': 0, 'verified_end': .4}
        return {'fps': 25, 'seed': 17, 'scenes': [
            {'text': '', 'start': i*.8, 'end': (i+1)*.8, 'match': {'selected': selected},
             'shots': [{'selected': selected, 'duration': .4} for _ in range(2)]}
            for i in range(2)]}

    def test_two_clips_run_concurrently_and_out_of_order_outputs_keep_plan_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            plan = self.make_plan(root)
            real_run = media.run
            first_started, third_finished = threading.Event(), threading.Event()
            lock = threading.Lock()
            active, peak, completed = 0, 0, []

            def controlled_run(args, cwd=None):
                nonlocal active, peak
                name = Path(args[-1]).name
                if not name.startswith('clip-'):
                    return real_run(args, cwd)
                with lock:
                    active += 1
                    peak = max(peak, active)
                try:
                    if name == 'clip-001-01.mp4':
                        first_started.set()
                        self.assertTrue(third_finished.wait(5), 'later clips never ran concurrently')
                    else:
                        self.assertTrue(first_started.wait(5))
                    result = real_run(args, cwd)
                    with lock:
                        completed.append(name)
                    if name == 'clip-002-01.mp4':
                        third_finished.set()
                    return result
                finally:
                    with lock:
                        active -= 1

            with patch('media.run', side_effect=controlled_run):
                media.render(plan, root/'out', 64, 64)
            self.assertEqual(peak, 2)
            self.assertLess(completed.index('clip-001-02.mp4'), completed.index('clip-001-01.mp4'))
            names = ['clip-001-01.mp4', 'clip-001-02.mp4', 'clip-002-01.mp4', 'clip-002-02.mp4']
            self.assertEqual((root/'out/concat.txt').read_text(encoding='utf-8'),
                             ''.join(f"file '{name}'\n" for name in names))
            cuts = json.loads((root/'out/cuts.json').read_text(encoding='utf-8'))
            self.assertEqual([(c['scene'], c['shot']) for c in cuts], [(1, 1), (1, 2), (2, 1), (2, 2)])

    def test_failed_clip_stops_refill_and_waits_for_inflight_without_concat(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            plan = self.make_plan(root)
            real_run = media.run
            first_started, release_first = threading.Event(), threading.Event()
            failure_observed, first_finished = threading.Event(), threading.Event()
            render_finished = threading.Event()
            started, errors, waited, other_ffmpeg = [], [], [], []

            class ClipFailure(RuntimeError):
                def __str__(self):
                    failure_observed.set()
                    return 'injected clip failure'

            def controlled_run(args, cwd=None):
                name = Path(args[-1]).name
                if not name.startswith('clip-'):
                    if args[0] == 'ffmpeg':
                        other_ffmpeg.append(args)
                    return real_run(args, cwd)
                started.append(name)
                if name == 'clip-001-01.mp4':
                    first_started.set()
                    self.assertTrue(release_first.wait(5), 'failure was not handled while a clip was active')
                    try:
                        return real_run(args, cwd)
                    finally:
                        first_finished.set()
                if name == 'clip-001-02.mp4':
                    self.assertTrue(first_started.wait(5))
                    raise ClipFailure()
                return real_run(args, cwd)

            def render():
                try:
                    media.render(plan, root/'out', 64, 64)
                except Exception as exc:
                    errors.append(exc)
                    waited.append(first_finished.is_set())
                finally:
                    render_finished.set()

            with patch('media.run', side_effect=controlled_run):
                coordinator = threading.Thread(target=render)
                coordinator.start()
                try:
                    self.assertTrue(failure_observed.wait(3), 'clip failure was not identified')
                    self.assertFalse(render_finished.is_set(), 'render returned before the active clip finished')
                finally:
                    release_first.set()
                    coordinator.join(5)
                self.assertFalse(coordinator.is_alive())
            self.assertEqual(started, ['clip-001-01.mp4', 'clip-001-02.mp4'])
            self.assertEqual(waited, [True])
            self.assertEqual(len(errors), 1)
            self.assertRegex(str(errors[0]), r'场景 1.*镜头 2.*injected clip failure')
            self.assertIsInstance(errors[0].__cause__, ClipFailure)
            self.assertEqual(other_ffmpeg, [])
            self.assertFalse((root/'out/concat.txt').exists())

    def test_clip_and_subtitle_commands_limit_threads_and_keep_clips_clean(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            plan = self.make_plan(root)
            plan['scenes'][1]['shots'][1]['selected'] = None
            real_run = media.run
            commands = []

            def record_run(args, cwd=None):
                if args[0] == 'ffmpeg':
                    commands.append(args)
                return real_run(args, cwd)

            with patch('media.run', side_effect=record_run):
                media.render(plan, root/'out', 64, 64)
            self.assertEqual(len(commands), 5)
            for args in commands:
                clip = Path(args[-1]).name.startswith('clip-')
                threads = '2' if clip else '4'
                input_index, encoder_index = args.index('-i'), args.index('-c:v')
                self.assertIn('-threads', args[:input_index])
                self.assertEqual(args[args.index('-threads')+1], threads)
                self.assertEqual(args[args.index('-threads', encoder_index)+1], threads)
                self.assertEqual(args[args.index('-filter_threads')+1], '1')
                if clip:
                    self.assertNotIn('subtitles=', ' '.join(args))

    def test_failure_during_completion_log_is_observed_before_refill(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            plan = self.make_plan(root)
            real_run, real_wait = media.run, media.wait
            release_first, completion_log = threading.Event(), threading.Event()
            failure_finished = threading.Event()
            started, other_ffmpeg = [], []

            def controlled_run(args, cwd=None):
                name = Path(args[-1]).name
                if not name.startswith('clip-'):
                    if args[0] == 'ffmpeg':
                        other_ffmpeg.append(args)
                    return real_run(args, cwd)
                started.append(name)
                if name == 'clip-001-01.mp4':
                    self.assertTrue(release_first.wait(5))
                if name == 'clip-001-02.mp4':
                    self.assertTrue(completion_log.wait(5))
                    raise RuntimeError('failure during logging')
                return real_run(args, cwd)

            def observe_failure(future):
                if future.exception() is not None:
                    failure_finished.set()

            def observed_wait(futures, **kwargs):
                # Observe real futures without replacing the executor or its scheduling.
                for future in futures:
                    future.add_done_callback(observe_failure)
                release_first.set()
                return real_wait(futures, **kwargs)

            def log(message):
                if '镜头完成' in message:
                    completion_log.set()
                    self.assertTrue(failure_finished.wait(5))

            with patch('media.run', side_effect=controlled_run), \
                 patch('media.wait', side_effect=observed_wait):
                with self.assertRaisesRegex(RuntimeError, r'场景 1.*镜头 2.*failure during logging'):
                    media.render(plan, root/'out', 64, 64, log=log)
            self.assertEqual(started, ['clip-001-01.mp4', 'clip-001-02.mp4'])
            self.assertEqual(other_ffmpeg, [])
            self.assertFalse((root/'out/concat.txt').exists())

    def test_progress_logs_run_on_coordinator_with_measured_clip_and_phase_times(self):
        self.assertIn('log', inspect.signature(media.render).parameters)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            plan = self.make_plan(root)
            messages, identities = [], []
            audio = root/'speech.wav'
            media.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
                       '-t', '1.6', '-c:a', 'pcm_s16le', str(audio)])
            plan['narration'] = str(audio)

            def log(message):
                messages.append(message)
                identities.append(threading.get_ident())

            media.render(plan, root/'out', 64, 64, log=log)
            self.assertEqual(set(identities), {threading.get_ident()})
            self.assertIn('开始合成字幕…', messages)
            completions = [m for m in messages if '镜头完成' in m]
            self.assertEqual(len(completions), 4)
            for index, message in enumerate(completions, 1):
                self.assertIn(f'{index}/4', message)
                self.assertRegex(message, r'场景 [12].*镜头 [12].*耗时 \d+\.\d+ 秒')
            for phase in ('镜头转码完成', '字幕合成完成', '配音合成完成'):
                self.assertTrue(any(phase in m and '耗时' in m for m in messages))


class MediaTimingTests(unittest.TestCase):
    def test_distinct_color_shots_and_narration_keep_order_and_full_duration(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            selected = []
            for color in ('red', 'lime', 'blue', 'yellow'):
                source = root/f'{color}.mp4'
                media.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', f'color=c={color}:s=64x64:r=25',
                           '-t', '0.4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(source)])
                selected.append({'path': str(source), 'stamp': file_stamp(source), 'source_start': 0,
                                 'verified_start': 0, 'verified_end': .4})
            audio = root/'speech.wav'
            media.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
                       '-t', '1.6', '-c:a', 'pcm_s16le', str(audio)])
            plan = {'fps': 25, 'seed': 3, 'narration': str(audio), 'scenes': [
                {'text': '', 'start': i*.8, 'end': (i+1)*.8, 'match': {'selected': selected[i*2]},
                 'shots': [{'selected': c, 'duration': .4} for c in selected[i*2:i*2+2]]}
                for i in range(2)]}
            target = media.render(plan, root/'out', 64, 64)
            self.assertAlmostEqual(media.duration(target), 1.6, places=3)
            info = json.loads(media.run(['ffprobe', '-v', 'error', '-show_entries',
                'stream=codec_type,duration,nb_frames', '-of', 'json', str(target)]))
            self.assertEqual({s['codec_type'] for s in info['streams']}, {'video', 'audio'})
            for stream in info['streams']:
                self.assertAlmostEqual(float(stream['duration']), 1.6, delta=1/25)
            for i, expected in enumerate(((255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0))):
                raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-ss', str(i*.4+.2), '-i', str(target),
                    '-vf', 'crop=32:32:16:0,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'])
                pixels = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).mean(axis=0)
                self.assertEqual(tuple(pixels > 128), tuple(channel > 128 for channel in expected))

    def test_display_subtitles_are_larger_and_have_no_punctuation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'source.mp4'
            media.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=144x256:r=25',
                       '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(source)])
            plan = {'fps': 25, 'seed': 1, 'scenes': [{'text': '带爸妈来海南过冬，住得很舒服！',
                'start': 0, 'end': 1, 'match': {'selected': {'path': str(source),
                'stamp': file_stamp(source), 'source_start': 0,
                'verified_start': 0, 'verified_end': 1}}}]}
            media.render(plan, root / 'out', 144, 256)
            subtitles = (root / 'out/display.srt').read_text(encoding='utf-8')
            self.assertIn('带爸妈来海南过冬住得很舒服', subtitles)
            self.assertNotIn('，', subtitles)
            self.assertNotIn('！', subtitles)
            self.assertEqual(media.caption_text('25.5-28度，入住率80％！'), '25点5到28度入住率百分之80')

    def test_mixed_hdr_sdr_export_is_709_and_sdr_pixels_are_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            hdr=root/'hdr.mkv'; sdr=root/'sdr.mp4'
            for target,primaries,transfer,matrix,codec in (
                (hdr,'bt2020','arib-std-b67','bt2020nc','ffv1'),
                (sdr,'bt709','bt709','bt709','libx264')):
                media.run(['ffmpeg','-v','error','-f','lavfi','-i','color=c=0xd29a72:s=64x64:r=25',
                    '-t','1','-c:v',codec,'-pix_fmt','yuv420p10le' if target==hdr else 'yuv420p',
                    '-color_primaries',primaries,'-color_trc',transfer,'-colorspace',matrix,
                    '-color_range','tv',str(target)])
            plan={'fps':25,'seed':1,'scenes':[]}
            for i,source in enumerate((hdr,sdr)):
                plan['scenes'].append({'text':'','start':i,'end':i+1,'match':{'selected':{
                    'path':str(source),'stamp':file_stamp(source),'source_start':0,
                    'verified_start':0,'verified_end':1}}})
            target=media.render(plan,root/'out',64,64)
            info=json.loads(media.run(['ffprobe','-v','error','-select_streams','v:0',
                '-show_entries','stream=color_primaries,color_transfer,color_space,color_range',
                '-of','json',str(target)]))['streams'][0]
            self.assertEqual(info,{'color_range':'tv','color_space':'bt709','color_transfer':'bt709','color_primaries':'bt709'})
            def pixels(path,seek):
                b=subprocess.check_output(['ffmpeg','-v','error','-ss',str(seek),'-i',str(path),
                    '-vf','crop=32:32:16:0,format=rgb24','-frames:v','1','-f','rawvideo','-'])
                return np.frombuffer(b,dtype=np.uint8).astype(float)
            self.assertLess(np.abs(pixels(sdr,.4)-pixels(target,1.4)).mean(),3)

    def test_clip_fills_exact_scene_duration_when_decoder_ends_early(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            source=root/'short.mp4'
            media.run(['ffmpeg','-v','error','-f','lavfi','-i','color=s=64x64:r=25',
                       '-t','0.4','-c:v','libx264','-pix_fmt','yuv420p',str(source)])
            plan={'fps':25,'seed':1,'scenes':[{'text':'测试','start':0,'end':1.2,
                  'match':{'selected':{'path':str(source),'stamp':file_stamp(source),
                  'source_start':0,'verified_start':0,'verified_end':.44}}}]}
            target=media.render(plan,root/'out',width=64,height=64)
            info=json.loads(media.run(['ffprobe','-v','error','-show_entries','stream=nb_frames',
                                      '-of','json',str(target)]))
            self.assertEqual(int(info['streams'][0]['nb_frames']),30)
            self.assertAlmostEqual(media.duration(target),1.2,places=3)


if __name__=='__main__':unittest.main()
