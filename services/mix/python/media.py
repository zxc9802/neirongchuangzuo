"""Read-only access to source media; derived clips are written to local output."""
import json
import math
import re
import struct
import subprocess
import threading
import unicodedata
import wave
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path
from time import perf_counter

SDR_FLAGS = ['-color_primaries', 'bt709', '-color_trc', 'bt709',
             '-colorspace', 'bt709', '-color_range', 'tv']
FFMPEG_SLOTS = threading.BoundedSemaphore(2)
FINAL_CRF = '16'


def video_color(path):
    data = json.loads(run(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=color_primaries,color_transfer,color_space,color_range',
        '-of', 'json', str(path)]))
    return data['streams'][0]


def sdr_filter(info):
    """Convert only when needed; ordinary BT.709 footage keeps its original colors."""
    hdr = info.get('color_transfer') in ('arib-std-b67', 'smpte2084')
    defaults = {'color_primaries': 'bt2020' if hdr else 'bt709',
                'color_transfer': 'bt709', 'color_space': 'bt2020nc' if hdr else 'bt709',
                'color_range': 'tv'}
    color = {k: info.get(k) if info.get(k) not in (None, 'unknown', 'unspecified') else v
             for k, v in defaults.items()}
    input_flags = (f'pin={color["color_primaries"]}:tin={color["color_transfer"]}:'
                   f'min={color["color_space"]}:rin={color["color_range"]}')
    if hdr:
        convert = (f'zscale={input_flags}:t=linear:npl=100,format=gbrpf32le,'
                   'zscale=p=bt709,tonemap=tonemap=mobius:param=0.3:desat=0,'
                   'zscale=t=bt709:m=bt709:r=tv,')
        mode = 'HDR-to-SDR'
    elif any(color[k] != defaults[k] for k in color):
        convert = f'zscale={input_flags}:p=bt709:t=bt709:m=bt709:r=tv,'
        mode = 'SDR-colorspace-conversion'
    else:
        convert, mode = '', 'SDR-preserved'
    # Strip inherited HDR/Dolby/ambient metadata after conversion, never alter the source file.
    return (convert+'format=yuv420p,sidedata=mode=delete,'
            'setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709'), mode


def run(args, cwd=None):
    with FFMPEG_SLOTS:
        result = subprocess.run(args, cwd=cwd, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                encoding='utf-8', errors='replace')
    if result.returncode:
        raise RuntimeError(result.stderr[-1800:])
    return result.stdout


def duration(path):
    info = json.loads(run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                           '-of', 'json', str(path)]))
    value = float(info['format']['duration'])
    if not math.isfinite(value) or value <= 0:
        raise ValueError(f'无法获取有效视频时长：{path}')
    return value


def has_audio(path):
    info = json.loads(run(['ffprobe', '-v', 'error', '-select_streams', 'a:0',
                           '-show_entries', 'stream=index', '-of', 'json', str(path)]))
    return bool(info['streams'])


def pcm_audible(path, start=0, length=None):
    """Inspect just this interval of a generated 16-bit PCM stem."""
    with wave.open(str(path), 'rb') as audio:
        rate = audio.getframerate()
        first = min(round(start * rate), audio.getnframes())
        audio.setpos(first)
        remaining = audio.getnframes() - first if length is None else round(length * rate)
        while remaining > 0:
            count = min(rate, remaining)
            chunk = audio.readframes(count)
            if not chunk:
                break
            if any(abs(sample[0]) > 3 for sample in struct.iter_unpack('<h', chunk)):
                return True
            remaining -= count
    return False


def original_audio(cuts, pieces, output):
    """Use precisely the picture cuts; pad silent/short audio to each shot's sample count."""
    names, audible, audio_cache, cursor = [], False, {}, 0
    for (i, j, shot), cut in zip(pieces, cuts):
        name = f'original-{i+1:03}-{j+1:02}.wav'
        source = cut.get('source')
        if source not in audio_cache:
            audio_cache[source] = has_audio(source) if source else False
        count = round(shot['duration'] * 48000)
        args = ['ffmpeg', '-v', 'error', '-nostdin', '-y']
        if audio_cache[source]:
            args += ['-ss', str(cut['source_start']), '-i', source, '-map', '0:a:0', '-af',
                     f'atrim=start=0:end={cut["used_seconds"]},aresample=48000:async=1:first_pts=0,'
                     f'apad=whole_len={count},atrim=end_sample={count},asetpts=N/SR/TB']
        else:
            args += ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', str(shot['duration'])]
        args += ['-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', str(output / name)]
        run(args)
        cut['audio_present'] = audio_cache[source] and pcm_audible(output / name)
        audible = audible or cut['audio_present']
        cut.update(start=cursor, end=cursor + shot['duration'])
        cursor += shot['duration']
        names.append(name)
    (output / 'original-concat.txt').write_text(''.join(f"file '{name}'\n" for name in names), encoding='utf-8')
    stem = output / 'original-audio.wav'
    run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'concat', '-safe', '1',
         '-i', 'original-concat.txt', '-c:a', 'pcm_s16le', stem.name], cwd=output)
    return stem, audible


def proxy(source, start, length, output, fps=4):
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
         '-threads', '2', '-ss', str(start), '-i', str(source), '-t', str(length), '-an',
         '-vf', f'scale=512:-2,fps={fps}:start_time=0:round=up', '-filter_threads', '1',
         '-c:v', 'libx264', '-threads', '2', '-preset', 'ultrafast',
         '-crf', '28', '-pix_fmt', 'yuv420p', str(output)])


def srt_time(seconds):
    ms = round(seconds * 1000)
    return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02},{ms%1000:03}'


def caption_text(value):
    value = re.sub(r'(\d+(?:\.\d+)?)\s*[%％]', r'百分之\1', value)
    value = re.sub(r'(?<=\d)\.(?=\d)', '点', value)
    value = re.sub(r'(?<=\d)\s*[-–—~～]\s*(?=\d)', '到', value)
    return re.sub(r'\s+', ' ', ''.join(char for char in value
        if unicodedata.category(char)[0] not in ('P', 'S'))).strip()


def write_srt(scenes, target):
    Path(target).write_text('\n\n'.join(
        f"{i+1}\n{srt_time(s['start'])} --> {srt_time(s['end'])}\n{caption_text(s['text'])}"
        for i, s in enumerate(scenes)) + '\n', encoding='utf-8')


def render(plan, output, width=1920, height=1080, log=print):
    """Captioned storyboard; original mode retains only sound from the selected cuts."""
    import random
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    fps = plan['fps']
    segments, cut_log, color_cache = [], [], {}
    pieces, commands = [], []
    for i, scene in enumerate(plan['scenes']):
        length = round(scene['end'] - scene['start'], 6)
        shots = scene.get('shots') or [{'selected': scene.get('match', {}).get('selected'), 'duration': length}]
        if abs(sum(s['duration'] for s in shots) - length) > .001:
            raise ValueError(f'场景 {i+1} 的镜头总时长与配音时间轴不一致')
        pieces.extend((i, j, shot) for j, shot in enumerate(shots))
    log(f'开始镜头转码：共 {len(pieces)} 个镜头，最多 2 路并行')
    remote_sources = [shot['selected'] for _, _, shot in pieces
                      if shot.get('selected') and shot['selected'].get('remote')]
    if remote_sources:
        from remote_catalog import hydrate
        log('准备本机高清片段；素材传输完成后，服务器继续导出')
        hydrate(remote_sources, 'source')
    started = perf_counter()
    for i, j, shot in pieces:
        target = output / f'clip-{i+1:03}-{j+1:02}.mp4'
        selected, length = shot['selected'], shot['duration']
        args = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '2']
        if selected:
            source = Path(selected['path'])
            from matcher import file_stamp
            if file_stamp(source) != selected['stamp']:
                raise ValueError(f'源文件已变化，需要重建索引：{source}')
            available = selected['verified_end'] - selected['verified_start']
            offset = random.Random(f"{plan['seed']}:{i}:{j}").uniform(0, max(0, available - length))
            seek = selected['source_start'] + selected['verified_start'] + offset
            take = min(length, available)
            if str(source) not in color_cache:
                info = video_color(source)
                color_cache[str(source)] = (info, *sdr_filter(info))
            info, color_filter, color_mode = color_cache[str(source)]
            args += ['-ss', str(seek), '-i', str(source), '-an', '-vf',
                     f'trim=duration={take},setpts=PTS-STARTPTS,fps={fps},'
                     f'scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2,'
                     f'{color_filter},pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,'
                     f'tpad=stop_mode=clone:stop_duration={length}']
            cut_log.append({'scene': i+1, 'shot': j+1, 'source': str(source), 'source_start': seek,
                            'used_seconds': take, 'freeze_seconds': max(0, length-take),
                            'source_color': info, 'color_mode': color_mode, 'output_color': 'bt709'})
        else:
            args += ['-f', 'lavfi', '-i', f'color=c=black:s={width}x{height}:r={fps}', '-an']
            cut_log.append({'scene': i+1, 'missing': True})
        args += ['-t', str(length), '-c:v', 'libx264', '-threads', '2', '-filter_threads', '1',
                 '-preset', 'fast', '-crf', '0',
                 '-pix_fmt', 'yuv420p', '-map_metadata', '-1', *SDR_FLAGS,
                 '-video_track_timescale', '25000', str(target)]
        commands.append((i, j, args))
        segments.append(target.name)

    def transcode(args):
        started = perf_counter()
        run(args)
        return perf_counter() - started

    jobs, completed = iter(commands), 0
    with ThreadPoolExecutor(max_workers=2) as executor:
        pending = {}
        for _ in range(min(2, len(commands))):
            i, j, args = next(jobs)
            pending[executor.submit(transcode, args)] = (i, j)
        while pending:
            done, _ = wait(pending, return_when=FIRST_COMPLETED)
            # Inspect the entire completed batch before scheduling any more work.
            for future in done:
                i, j = pending.pop(future)
                try:
                    elapsed = future.result()
                except Exception as exc:
                    raise RuntimeError(f'场景 {i+1} 镜头 {j+1} 转码失败：{exc}') from exc
                completed += 1
                log(f'镜头完成 {completed}/{len(commands)}：场景 {i+1} 镜头 {j+1}，耗时 {elapsed:.2f} 秒')
            # Logging can block while another clip finishes; inspect it before refilling.
            if any(future.done() for future in pending):
                continue
            for _ in range(2-len(pending)):
                job = next(jobs, None)
                if job is None:
                    break
                i, j, args = job
                pending[executor.submit(transcode, args)] = (i, j)
    log(f'镜头转码完成：{completed}/{len(commands)}，耗时 {perf_counter()-started:.2f} 秒')
    # Relative safe generated filenames avoid FFmpeg quoting problems with Chinese paths.
    (output / 'concat.txt').write_text(''.join(f"file '{s}'\n" for s in segments), encoding='utf-8')
    write_srt(plan['scenes'], output / 'captions.srt')
    if not plan.get('narration'):
        write_srt(plan['scenes'], output / 'estimated.srt')
    display = [{**s, 'text': s['text'] + ('\n【缺少匹配素材】' if not s['match']['selected'] else '')}
               for s in plan['scenes']]
    write_srt(display, output / 'display.srt')
    from captions import write_display
    write_display(display, output / 'display.ass', width, height, plan.get('caption_layout') == 'safe',
                  large=bool(plan.get('presentation')))
    log('开始合成字幕…')
    started = perf_counter()
    # Styling performs the final encode; preserve pixels until that stage.
    crf = '0' if plan.get('presentation', {}).get('confirmed') else FINAL_CRF
    run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '4', '-f', 'concat',
         '-safe', '1', '-i', 'concat.txt', '-vf',
         'ass=display.ass' if plan.get('subtitles', True) else 'null',
         '-an', '-c:v', 'libx264', '-threads', '4', '-filter_threads', '1',
         '-preset', 'fast', '-crf', crf, '-pix_fmt', 'yuv420p',
         '-map_metadata', '-1', *SDR_FLAGS, '-movflags', '+faststart', 'preview.mp4'], cwd=output)
    log(f'字幕合成完成：耗时 {perf_counter()-started:.2f} 秒')
    if plan.get('voice_mode') == 'original':
        stem, audible = original_audio(cut_log, pieces, output)
        plan.update(original_audio=str(stem), original_audio_present=audible)
    audio = plan.get('original_audio') if plan.get('voice_mode') == 'original' else plan.get('narration')
    if audio:
        started = perf_counter()
        # Never use -shortest to hide a truncated picture or narration track.
        expected = plan['scenes'][-1]['end']
        tolerance = 1 / fps + .001
        if abs(duration(output/'preview.mp4') - expected) > tolerance:
            raise ValueError('画面时长与时间轴不一致，禁止截短口播来导出')
        if abs(duration(audio) - expected) > tolerance:
            raise ValueError('配音时长与时间轴不一致，请重新对齐场景后导出')
        run(['ffmpeg','-hide_banner','-loglevel','error','-nostdin','-y','-i','preview.mp4',
             '-i',audio,'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac',
             '-b:a','192k','-movflags','+faststart','video.mp4'],cwd=output)
        log(f'配音合成完成：耗时 {perf_counter()-started:.2f} 秒')
    (output / 'cuts.json').write_text(json.dumps(cut_log, ensure_ascii=False, indent=2), encoding='utf-8')
    return output / ('video.mp4' if audio else 'preview.mp4')
