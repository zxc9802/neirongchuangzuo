"""Read-only access to source media; derived clips are written to local output."""
import json
import math
import re
import subprocess
import threading
import unicodedata
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
    """Silent, captioned storyboard. Missing scenes remain explicit black slates."""
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
    write_srt(plan['scenes'], output / ('captions.srt' if plan.get('narration') else 'estimated.srt'))
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
    if plan.get('narration'):
        started = perf_counter()
        # Never use -shortest to hide a truncated picture or narration track.
        expected = plan['scenes'][-1]['end']
        tolerance = 1 / fps + .001
        if abs(duration(output/'preview.mp4') - expected) > tolerance:
            raise ValueError('画面时长与时间轴不一致，禁止截短口播来导出')
        if abs(duration(plan['narration']) - expected) > tolerance:
            raise ValueError('配音时长与时间轴不一致，请重新对齐场景后导出')
        run(['ffmpeg','-hide_banner','-loglevel','error','-nostdin','-y','-i','preview.mp4',
             '-i',plan['narration'],'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac',
             '-b:a','192k','-movflags','+faststart','video.mp4'],cwd=output)
        log(f'配音合成完成：耗时 {perf_counter()-started:.2f} 秒')
    (output / 'cuts.json').write_text(json.dumps(cut_log, ensure_ascii=False, indent=2), encoding='utf-8')
    return output / ('video.mp4' if plan.get('narration') else 'preview.mp4')
