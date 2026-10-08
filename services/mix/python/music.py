"""Mix user-provided background music beneath narration."""
import json
import math
from pathlib import Path

import media

VOICE_LUFS = -19
MUSIC_LUFS = -25


def normalize(source, target, seconds, lufs):
    # Measure via stderr; reset timestamps and trim by sample count to avoid loudnorm's PTS offset.
    import subprocess
    with media.FFMPEG_SLOTS:
        measured = subprocess.run(['ffmpeg', '-hide_banner', '-i', str(source), '-t', str(seconds),
            '-af', f'loudnorm=I={lufs}:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'],
            capture_output=True, text=True, encoding='utf-8', errors='replace', check=True)
    stats = json.loads(measured.stderr[measured.stderr.rfind('{'):measured.stderr.rfind('}')+1])
    count = round(seconds*48000)
    loudnorm = (f'loudnorm=I={lufs}:TP=-1.5:LRA=11:measured_I={stats["input_i"]}'
          f':measured_TP={stats["input_tp"]}:measured_LRA={stats["input_lra"]}'
          f':measured_thresh={stats["input_thresh"]}:offset={stats["target_offset"]},')
    # Silent original footage reports -inf; passing it to loudnorm fails the export.
    if not all(math.isfinite(float(stats[key])) for key in ('input_i', 'input_tp', 'input_thresh', 'target_offset')):
        loudnorm = ''
    af = (loudnorm + f'aresample=48000,asetpts=N/SR/TB,apad=whole_len={count},'
          f'atrim=end_sample={count},asetpts=N/SR/TB')
    media.run(['ffmpeg', '-v', 'error', '-y', '-i', str(source), '-af', af,
               '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', str(target)])


def mix(video, narration, music, output, seconds):
    output = Path(output)
    if narration is None:
        narration = output / 'silent-audio.wav'
        media.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i',
                   'anullsrc=r=48000:cl=stereo', '-t', str(seconds), '-c:a', 'pcm_s16le', str(narration)])
    if media.duration(music) < seconds:
        repeated = output / 'music-loop.wav'
        media.run(['ffmpeg', '-v', 'error', '-y', '-stream_loop', '-1', '-i', str(music),
                   '-t', str(seconds), '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', str(repeated)])
        music = repeated
    normalize(narration, output/'narration-normalized.wav', seconds, VOICE_LUFS)
    normalize(music, output/'music-bed.wav', seconds, MUSIC_LUFS)
    filters = (f'[0:a]asplit=2[voice][side];[1:a]afade=t=in:d=1.2,'
               f'afade=t=out:st={max(0,seconds-2)}:d=2[bed];'
               '[bed][side]sidechaincompress=threshold=0.06:ratio=2:attack=20:release=300[duck];'
               '[voice][duck]amix=inputs=2:duration=first:normalize=0,'
               'alimiter=limit=0.95:level=false:latency=true[mix]')
    media.run(['ffmpeg', '-v', 'error', '-y', '-i', str(output/'narration-normalized.wav'),
               '-i', str(output/'music-bed.wav'), '-filter_complex', filters, '-map', '[mix]',
               '-c:a', 'pcm_s16le', str(output/'mixed.wav')])
    target = output/'video-music.mp4'
    media.run(['ffmpeg', '-v', 'error', '-y', '-i', str(video), '-i', str(output/'mixed.wav'),
               '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
               '-movflags', '+faststart', str(target)])
    return target
