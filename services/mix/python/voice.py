"""IndexTTS2 jobs with local resume records and server-side emotion validation."""
import hashlib
import json
import math
import os
import time
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import urlparse

import requests

from api import clean_error
from matcher import write_json
import media

TTS_BASE_URL = os.environ.get('INDEXTTS_BASE_URL') or os.environ.get('TTS_BASE_URL') or 'https://api.302.ai'
TTS_BASE_URL = TTS_BASE_URL.rstrip('/')
TASK_URL = TTS_BASE_URL + '/302/index_tts2/task'
UPLOAD_URL = TTS_BASE_URL + '/upload-file'
UPLOAD_FALLBACK_URL = os.environ.get('TTS_UPLOAD_FALLBACK_URL',
                                      'https://dash-api.302.ai/gpt/api/upload/gpt/image')
DEFAULT_REFERENCE = object()


def validate_emotion(value=.8):
    try:
        if isinstance(value, bool):
            raise ValueError()
        number = Decimal(str(value))
        if not number.is_finite() or not Decimal('.1') <= number <= Decimal('.85'):
            raise ValueError()
        if (number - Decimal('.1')) % Decimal('.05') != 0:
            raise ValueError()
    except (ValueError, InvalidOperation):
        raise ValueError('情绪强度必须为 0.1–0.85，步长 0.05，默认 0.8') from None
    return float(number)


def headers():
    key = os.environ.get('INDEXTTS_302_API_KEY') or os.environ.get('TTS_API_KEY')
    if not key:
        raise ValueError('请设置 INDEXTTS_302_API_KEY 进程环境变量')
    return {'Authorization': f'Bearer {key}'}


def response_json(response):
    if not 200 <= response.status_code < 300:
        raise RuntimeError(f'HTTP {response.status_code}: {clean_error(response.text)}')
    return response.json()


def checked_url(value):
    if not isinstance(value, str) or urlparse(value).scheme != 'https' or not urlparse(value).hostname:
        raise ValueError('服务端需要返回有效 HTTPS 音频地址')
    return value


def upload_reference(path, folder, kind):
    path, folder = Path(path), Path(folder)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    cache = folder / f'{kind}-{digest[:16]}.json'
    previous = json.loads(cache.read_text(encoding='utf-8')) if cache.exists() else {}
    if previous and time.time() - previous['uploaded_at'] < 24 * 3600:
        return checked_url(previous['url']), digest
    folder.mkdir(parents=True, exist_ok=True)
    prepared = folder / f'{kind}-{digest[:16]}-15s.wav'
    media.run(['ffmpeg','-hide_banner','-loglevel','error','-nostdin','-y','-i',str(path),
               '-t','15','-ac','1','-ar','22050','-c:a','pcm_s16le',str(prepared)])
    with prepared.open('rb') as file:
        r = requests.post(UPLOAD_URL, headers=headers(), files={'file': (f'{kind}.wav',file,'audio/wav')},
                          timeout=(15,120), allow_redirects=False)
    if r.status_code >= 500:
        # Official 302_tts app uses this upload route (.env.example and
        # hooks/use-file-upload.ts). It requires no API credential.
        with prepared.open('rb') as file:
            r = requests.post(UPLOAD_FALLBACK_URL,
                              files={'file': (f'{kind}.wav',file,'audio/wav')},
                              data={'need_compress': 'false'},timeout=(15,120),allow_redirects=False)
    data = response_json(r)
    value = data.get('data')
    url = checked_url(value.get('url') if isinstance(value,dict) else value)
    reference = {'url': url, 'uploaded_at': time.time(), 'source_sha256': digest}
    if kind == 'speaker':
        # Preserve legacy TTS cache keys when the same source gets a fresh upload URL.
        reference['cache_url'] = previous.get('cache_url') or previous.get('url') or url
    write_json(cache, reference)
    return url, digest


def upload_emotion(path, folder):
    return upload_reference(path, folder, 'emotion')


def synthesize(text, speaker, emotion_url, emotion_hash, alpha, folder, log=print, *, speaker_cache_key=None):
    if not text.strip() or len(text) > 2048:
        raise ValueError('单段配音文本须为 1–2048 字符')
    spec = {'text': text, 'speaker': speaker_cache_key or speaker, 'emotion_hash': emotion_hash, 'alpha': alpha}
    digest = hashlib.sha256(json.dumps(spec,sort_keys=True).encode()).hexdigest()[:24]
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    record, audio = folder / f'{digest}.json', folder / f'{digest}.wav'
    job = json.loads(record.read_text(encoding='utf-8')) if record.exists() else {}
    if audio.exists() and job.get('state') == 'SUCCESS':
        media.duration(audio)
        log('复用已完成配音，不重复生成')
        return audio
    if job.get('state') in ('FAILURE','FAILED','ERROR','REVOKED'):
        log('本段上次配音失败，重新提交一次')
        attempts = job.get('attempts', []) + [{key: job.get(key) for key in ('task_id', 'state', 'result')}]
        job = {'spec': spec, 'attempts': attempts}
    if not job.get('task_id'):
        if job.get('submission') == 'uncertain':
            raise RuntimeError(f'配音提交结果不确定，未获得任务 ID；请核对服务商记录后恢复：{record}')
        payload = {'text': text, 'speaker_audio_url': checked_url(speaker),
                   'emotion_alpha': validate_emotion(alpha)}
        if emotion_url:
            payload['emotion_audio_url'] = checked_url(emotion_url)
        else:
            payload['emotion_vector'] = [0, 0, 0, 0, 0, 0, 0, 1.0]
        authorization = headers()
        # Persist before POST: a lost reply is different from a confirmed failed task.
        job.update({'spec': spec, 'request': payload, 'submission': 'uncertain'})
        write_json(record, job)
        try:
            response = requests.post(TASK_URL, headers=authorization, json=payload,
                                     timeout=(15,90), allow_redirects=False)
        except requests.RequestException as exc:
            raise RuntimeError('配音提交结果不确定，请核对服务商任务后恢复：'+clean_error(exc)) from None
        if 400 <= response.status_code < 500:
            job['submission'] = 'rejected'
            write_json(record, job)
        data = response_json(response)
        if not data.get('task_id'):
            raise ValueError('TTS 提交未返回 task_id，请核对服务商任务，避免重复提交')
        job.update({'task_id': data['task_id'], 'state': 'PENDING', 'submission': 'submitted'})
        write_json(record, job)
    deadline, previous, poll_errors = time.monotonic() + 900, None, 0
    while time.monotonic() < deadline:
        try:
            response = requests.get(TASK_URL, headers=headers(), params={'task_id': job['task_id']},
                                    timeout=(15,60), allow_redirects=False)
            if response.status_code == 429 or response.status_code >= 500:
                raise requests.RequestException(f'配音状态查询 HTTP {response.status_code}')
        except requests.RequestException as exc:
            poll_errors += 1
            if poll_errors >= 6:
                raise RuntimeError(f'配音查询暂不可用，任务已保存，可继续查询：{clean_error(exc)}') from None
            log('配音状态查询暂不可用，稍后继续查询同一任务')
            time.sleep(min(5 * poll_errors, 30))
            continue
        poll_errors = 0
        result = response_json(response)
        state = str(result.get('state', '')).upper()
        if state != previous:
            log(f'配音任务 {job["task_id"]}: {state or "等待状态"}')
            previous = state
        job.update({'state': state, 'result': result})
        write_json(record, job)
        if state == 'SUCCESS':
            url = checked_url(result.get('audio_url'))
            # The domestic task API can still return the overseas CDN hostname.
            # Both official CDN domains serve the same path; keep TLS verification.
            parsed = urlparse(url)
            if TTS_BASE_URL == 'https://api.302ai.cn' and parsed.hostname == 'file.302.ai':
                url = parsed._replace(netloc='file.302ai.cn').geturl()
            hosts = [h.strip().lower() for h in (os.environ.get('INDEXTTS_DOWNLOAD_HOSTS') or '302.ai').split(',') if h.strip()]
            hostname = urlparse(url).hostname.lower()
            if not any(hostname == host or hostname.endswith('.' + host) for host in hosts):
                raise ValueError('配音下载地址不属于 INDEXTTS_DOWNLOAD_HOSTS 允许的服务商域名')
            for attempt in range(4):
                try:
                    download = requests.get(url, timeout=(15,120), allow_redirects=False)
                    if download.status_code == 429 or download.status_code >= 500:
                        raise requests.RequestException(f'音频下载 HTTP {download.status_code}')
                    break
                except requests.RequestException as exc:
                    if attempt == 3:
                        raise RuntimeError(f'音频已合成但下载暂不可用，可重新下载：{clean_error(exc)}') from None
                    log('音频已合成，正在重试下载')
                    time.sleep(2 ** (attempt + 1))
            if download.status_code != 200:
                raise RuntimeError(f'音频下载失败 HTTP {download.status_code}')
            temp = audio.with_suffix('.download.wav')
            temp.write_bytes(download.content)
            media.duration(temp)
            temp.replace(audio)
            return audio
        if state in ('FAILURE','FAILED','ERROR','REVOKED'):
            raise RuntimeError(f'TTS 任务失败：{clean_error(result)}；可点击“从配音与剪辑继续”重试本段')
        time.sleep(5)
    raise TimeoutError(f'TTS 等待超过 15 分钟；任务已保存在 {record}，重跑会继续查询')


def synthesize_plan(plan, output, emotion_alpha=.8, emotion_file=DEFAULT_REFERENCE,
                    speaker_url=None, log=print, speaker_file=None, emotion_url=DEFAULT_REFERENCE,
                    speaker_cache_key=None):
    alpha = validate_emotion(emotion_alpha)
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    speaker_hash = None
    speaker_url = speaker_url or os.environ.get('INDEXTTS_SPEAKER_AUDIO_URL')
    if speaker_url:
        speaker_url = checked_url(speaker_url)
    elif speaker_file:
        speaker_url, speaker_hash = upload_reference(speaker_file, output / 'voice-cache', 'speaker')
        reference = output / 'voice-cache' / f'speaker-{speaker_hash[:16]}.json'
        if reference.exists():
            speaker_cache_key = speaker_cache_key or json.loads(reference.read_text(encoding='utf-8')).get('cache_url')
    else:
        raise ValueError('请设置服务器 INDEXTTS_SPEAKER_AUDIO_URL 通用音色')
    if emotion_url is DEFAULT_REFERENCE:
        emotion_url = os.environ.get('INDEXTTS_EMOTION_AUDIO_URL') or None
    if emotion_file is DEFAULT_REFERENCE:
        emotion_file = os.environ.get('INDEXTTS_EMOTION_AUDIO_PATH') or None
    if emotion_url:
        emotion_url = checked_url(emotion_url)
        emotion_hash = hashlib.sha256(emotion_url.encode()).hexdigest()
    elif emotion_file:
        emotion_url, emotion_hash = upload_emotion(emotion_file, output / 'voice-cache')
    else:
        emotion_hash = 'general-emotion-vector-v1'
    fps, cursor, names = plan['fps'], 0, []
    for i, scene in enumerate(plan['scenes']):
        log(f'生成配音 {i+1}/{len(plan["scenes"])}：{scene["text"]}')
        audio = synthesize(scene['text'], speaker_url, emotion_url, emotion_hash, alpha, output/'voice-cache',log,
                           speaker_cache_key=speaker_cache_key)
        seconds = media.duration(audio)
        frames = math.ceil(seconds * fps)
        aligned = output / f'voice-{i+1:03}.wav'
        media.run(['ffmpeg','-hide_banner','-loglevel','error','-nostdin','-y','-i',str(audio),
                   '-af',f'apad,atrim=duration={frames/fps}','-ar','48000','-ac','1','-c:a','pcm_s16le',str(aligned)])
        scene.update({'start': cursor/fps, 'end': (cursor+frames)/fps,
                      'timing': 'tts-segment', 'voice': str(aligned), 'voice_duration': seconds})
        cursor += frames
        names.append(aligned.name)
        write_json(output/'plan.json',plan)
    (output/'voice-concat.txt').write_text(''.join(f"file '{name}'\n" for name in names), encoding='utf-8')
    media.run(['ffmpeg','-hide_banner','-loglevel','error','-nostdin','-y','-f','concat','-safe','1',
               '-i','voice-concat.txt','-c:a','pcm_s16le','narration.wav'],cwd=output)
    plan.update({'timing': 'tts-segment', 'narration': str(output/'narration.wav'),
                 'voice_settings': {'model':'index_tts2','emotion_alpha':alpha,
                                    'emotion_source':emotion_url or (str(emotion_file) if emotion_file else None),'emotion_sha256':emotion_hash,
                                    'speaker_source':str(speaker_file) if speaker_hash else None,
                                    'speaker_sha256':speaker_hash,
                                    'speaker_url':speaker_url,'alignment':'scene boundaries, not word timestamps'}})
    write_json(output/'plan.json',plan)
    media.write_srt(plan['scenes'],output/'captions.srt')
    return plan
