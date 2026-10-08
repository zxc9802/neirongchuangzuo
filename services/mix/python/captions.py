"""Explicit CJK line breaks shared by initial export and subtitle repairs."""
import math
from pathlib import Path

import media


def ass_time(seconds):
    ticks = round(seconds * 100)
    return f'{ticks // 360000}:{ticks // 6000 % 60:02}:{ticks // 100 % 60:02}.{ticks % 100:02}'


def write_display(scenes, target, width, height, compact=False, large=False):
    margin = round(width * (.09 if compact else .06))
    base_size = max(1, round(min(width, height) * ((.09 if compact else .10) if large else (.064 if compact else .075))))
    usable = width - 2 * margin - 8
    header = (f'[Script Info]\nScriptType: v4.00+\nPlayResX: {width}\nPlayResY: {height}\n'
              'WrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\n'
              'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, '
              'Bold, Italic, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, '
              'Alignment, MarginL, MarginR, MarginV, Encoding\n'
              f'Style: Default,Microsoft YaHei,{base_size},&H00FFFFFF,&H00000000,&H00000000,'
              f'{-1 if large else 0},0,100,100,0,0,1,{max(1, round(width * .006)) if large else 3},0,2,'
              f'{margin},{margin},{round(height * (.24 if large else .16))},1\n\n'
              '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n')
    events = []
    for scene in scenes:
        text = media.caption_text(scene['text'])
        # CJK glyphs occupy roughly a full em. Explicit breaks also work on NAS
        # builds of libass without Unicode line-breaking support.
        glyph_ratio = .82 if large else 1
        columns = max(1, math.floor(usable / (base_size * glyph_ratio)), math.ceil(len(text) / 3))
        size = max(1, min(base_size, math.floor(usable / (columns * glyph_ratio))))
        lines = '\\N'.join(text[i:i + columns] for i in range(0, len(text), columns))
        events.append(f'Dialogue: 0,{ass_time(scene["start"])},{ass_time(scene["end"])},'
                      f'Default,,0,0,0,,{{\\fs{size}}}{lines}\n')
    Path(target).write_text(header + ''.join(events), encoding='utf-8')


def rebuild(plan, output, width, height):
    """Burn revised subtitles onto saved clean clips; keep the original voice."""
    output = Path(output)
    write_display(plan['scenes'], output / 'display.ass', width, height, compact=True, large=bool(plan.get('presentation')))
    crf = '0' if plan.get('presentation', {}).get('confirmed') else media.FINAL_CRF
    media.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-threads', '4', '-f', 'concat',
               '-safe', '1', '-i', 'concat.txt', '-vf', 'ass=display.ass' if plan.get('subtitles', True) else 'null', '-an',
               '-c:v', 'libx264', '-threads', '4', '-filter_threads', '1', '-preset', 'fast',
               '-crf', crf, '-pix_fmt', 'yuv420p', '-map_metadata', '-1', *media.SDR_FLAGS,
               '-movflags', '+faststart', 'preview.mp4'], cwd=output)
    expected = plan['scenes'][-1]['end']
    if abs(media.duration(output / 'preview.mp4') - expected) > 1 / plan['fps'] + .001:
        raise ValueError('修正字幕后的画面时长与原时间轴不一致')
    audio = plan.get('original_audio') if plan.get('voice_mode') == 'original' else plan.get('narration')
    if not audio:
        return output / 'preview.mp4'
    media.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', 'preview.mp4',
               '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy',
               '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', 'video.mp4'], cwd=output)
    return output / 'video.mp4'
