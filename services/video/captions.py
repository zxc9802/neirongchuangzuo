"""Read embedded or burned captions; keep their text/timing outside the video model."""
import collections
import difflib
import json
import math
import os
import re
import subprocess
import sys

import cv2
import numpy as np

cv2.setNumThreads(1)
STEP = 0.1


def command(args):
    return subprocess.check_output(args, stderr=subprocess.PIPE).decode()


def embedded(path, width, height, duration):
    data = json.loads(command(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe',
                              '-select_streams', 's', '-show_entries', 'stream=index', '-of', 'json', path]))
    if not data.get('streams'):
        return None
    text = command(['ffmpeg', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', path,
                    '-map', '0:s:0', '-f', 'srt', '-'])
    cues = []
    def seconds(value):
        h, m, s, ms = map(int, re.split('[:,.]', value))
        return h * 3600 + m * 60 + s + ms / 1000
    for block in re.split(r'\n\s*\n', text.strip()):
        lines = block.splitlines()
        timing = next((i for i, line in enumerate(lines) if ' --> ' in line), None)
        if timing is None:
            continue
        start, end = [seconds(value.split()[0]) for value in lines[timing].split(' --> ')]
        caption = re.sub(r'<[^>]*>|\{[^}]*\}', '', '\n'.join(lines[timing + 1:])).strip()
        if caption and 0 <= start < min(end, duration):
            cues.append({'start': start, 'end': min(end, duration), 'text': caption,
                         'box': [width * .08, height * .78, width * .92, height * .83]})
    return {'engine': 'embedded-subtitles', 'kind': 'embedded', 'width': width, 'height': height, 'cues': cues} if cues else None


def normalized(text):
    return re.sub(r'[^\w]', '', text)


def extract(path):
    cap = cv2.VideoCapture(path)
    width, height = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    if not width or not height or not fps:
        raise ValueError('Unreadable video')
    duration = cap.get(cv2.CAP_PROP_FRAME_COUNT) / fps
    subtitles = embedded(path, width, height, duration)
    if subtitles:
        cap.release()
        return subtitles
    from rapidocr_onnxruntime import RapidOCR
    ocr = RapidOCR(intra_op_num_threads=1, inter_op_num_threads=1)
    tracks = []
    frame_index = 0
    for index in range(math.ceil(duration / STEP)):
        at = index * STEP
        target = round(at * fps)
        if target < frame_index:
            continue
        while frame_index < target:
            if not cap.grab():
                break
            frame_index += 1
        ok, frame = cap.read()
        if not ok:
            break
        frame_index += 1
        results, _ = ocr(frame, use_cls=False)
        lines = []
        for points, text, confidence in results or []:
            box = np.array(points)
            x1, y1 = box.min(axis=0)
            x2, y2 = box.max(axis=0)
            # Dialogue is horizontal, centered and larger than incidental labels.
            if confidence < .85 or len(normalized(text)) < 2 or not .25 < (x1 + x2) / (2 * width) < .75:
                continue
            if y2 - y1 < height * .015 or y2 - y1 > height * .12 or abs(points[1][1] - points[0][1]) > (y2 - y1) * .5:
                continue
            lines.append({'text': text, 'box': [float(x1), float(y1), float(x2), float(y2)]})
        lines.sort(key=lambda line: line['box'][1])
        grouped = []
        for line in lines:
            if grouped and 0 <= line['box'][1] - grouped[-1]['box'][3] < height * .025:
                previous = grouped[-1]
                previous['text'] += '\n' + line['text']
                previous['box'] = [min(previous['box'][0], line['box'][0]), previous['box'][1],
                                   max(previous['box'][2], line['box'][2]), line['box'][3]]
            else:
                grouped.append(line)
        for line in grouped:
            center = (line['box'][1] + line['box'][3]) / 2
            track = next((track for track in tracks if abs(track['y'] - center) < height * .04), None)
            if track is None:
                track = {'y': center, 'samples': []}
                tracks.append(track)
            track['samples'].append({'at': round(at, 3), **line})
    cap.release()
    # Repeated packaging/logo text is not a dialogue track. A single caption
    # can still qualify if it occupies a normal subtitle band near the bottom.
    candidates = []
    for track in tracks:
        texts = collections.Counter(normalized(item['text']) for item in track['samples'])
        stable = [text for text, count in texts.items() if count >= 2]
        if len(stable) >= 2 or len(stable) == 1 and len(stable[0]) >= 4 and track['y'] > height * .65:
            candidates.append(track)
    if not candidates:
        return None
    track = max(candidates, key=lambda track: len(track['samples']))
    cues = []
    for sample in track['samples']:
        same = cues and (normalized(sample['text']) == normalized(cues[-1]['text'])
                         or difflib.SequenceMatcher(None, normalized(sample['text']), normalized(cues[-1]['text'])).ratio() >= .9)
        if same and sample['at'] <= cues[-1]['end'] + STEP * 1.5:
            cue = cues[-1]
            cue['end'] = round(min(duration, sample['at'] + STEP), 3)
            cue['_votes'][sample['text']] += 1
            cue['text'] = cue['_votes'].most_common(1)[0][0]
            cue['box'] = [min(cue['box'][0], sample['box'][0]), min(cue['box'][1], sample['box'][1]),
                          max(cue['box'][2], sample['box'][2]), max(cue['box'][3], sample['box'][3])]
        else:
            cues.append({'start': sample['at'], 'end': round(min(duration, sample['at'] + STEP), 3),
                         'text': sample['text'], 'box': sample['box'], '_votes': collections.Counter([sample['text']])})
    cues = [cue for cue in cues if cue['end'] - cue['start'] >= STEP * 1.5]
    for cue in cues:
        del cue['_votes']
    return {'engine': 'rapidocr', 'kind': 'burned', 'width': width, 'height': height, 'cues': cues} if cues else None


def scaled_box(cue, captions, width, height):
    x1, y1, x2, y2 = cue['box']
    return [round(x1 * width / captions['width']), round(y1 * height / captions['height']),
            round(x2 * width / captions['width']), round(y2 * height / captions['height'])]


def render(path, output, captions):
    from PIL import Image, ImageDraw, ImageFont
    cap = cv2.VideoCapture(path)
    width, height = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    fonts = ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', '/System/Library/Fonts/PingFang.ttc',
             '/System/Library/Fonts/Supplemental/Arial Unicode.ttf']
    font_path = next((font for font in fonts if os.path.isfile(font)), None)
    if not font_path:
        raise ValueError('Chinese caption font unavailable')
    layouts = []
    for cue in captions['cues']:
        x1, y1, x2, y2 = scaled_box(cue, captions, width, height)
        lines = cue['text'].splitlines()
        size = max(12, round((y2 - y1) / len(lines)))
        font = ImageFont.truetype(font_path, size)
        while size > 12 and max(font.getlength(line) for line in lines) > width * .9:
            size -= 1
            font = ImageFont.truetype(font_path, size)
        layouts.append((cue, (x1 + x2) / 2, y1, font, max(1, round(size / 15))))
    ffmpeg = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24',
                               '-s', f'{width}x{height}', '-r', str(fps), '-i', 'pipe:0',
                               '-protocol_whitelist', 'file,pipe', '-i', path, '-map', '0:v:0', '-map', '1:a:0?',
                               '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-threads', '2', '-pix_fmt', 'yuv420p',
                               '-c:a', 'copy', '-movflags', '+faststart', '-f', 'mp4', output], stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    index = 0
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            at = index / fps
            active = [layout for layout in layouts if layout[0]['start'] <= at < layout[0]['end']]
            if active:
                image = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
                draw = ImageDraw.Draw(image)
                for cue, center, top, font, stroke in active:
                    for line in cue['text'].splitlines():
                        draw.text((center - font.getlength(line) / 2, top), line, font=font, anchor='lt',
                                  fill='white', stroke_width=stroke, stroke_fill='black')
                        top += font.size * 1.2
                frame = cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR)
            ffmpeg.stdin.write(frame.tobytes())
            index += 1
        ffmpeg.stdin.close()
        stderr = ffmpeg.stderr.read()
        if ffmpeg.wait() or not index:
            raise RuntimeError(stderr.decode()[-2000:])
    finally:
        cap.release()
        if ffmpeg.poll() is None:
            ffmpeg.kill()
            ffmpeg.wait()


if __name__ == '__main__':
    mode, path = sys.argv[1:3]
    if mode == 'extract':
        print(json.dumps(extract(path), ensure_ascii=False))
    elif mode == 'render':
        with open(sys.argv[4], encoding='utf-8') as source:
            render(path, sys.argv[3], json.load(source))
    else:
        raise ValueError('Unsupported caption operation')
