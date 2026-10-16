"""fal Qwen3 narration with durable queue receipts and reusable voice embeddings."""
import base64
import hashlib
import json
import math
import os
import re
import time
from pathlib import Path
from urllib.parse import urlparse

import requests

from api import clean_error
from costs import paid_post, metering_enabled
from credits import CreditError
from matcher import write_json
import media

TTS_MODEL = 'fal-ai/qwen-3-tts/text-to-speech/1.7b'
CLONE_MODEL = 'fal-ai/qwen-3-tts/clone-voice/1.7b'
VOICES = ('Vivian', 'Serena', 'Uncle_Fu', 'Dylan', 'Eric', 'Ryan', 'Aiden', 'Ono_Anna', 'Sohee')


def headers():
    key = os.environ.get('MIX_FAL_KEY')
    if not key:
        raise ValueError('请设置服务器 MIX_FAL_KEY 配音密钥')
    return {'Authorization': 'Key ' + key}


def download(url, target):
    parsed = urlparse(url or '')
    host = (parsed.hostname or '').lower()
    if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port not in (None, 443) or not (
            host.endswith('.fal.media') or host == 'storage.googleapis.com'):
        raise ValueError('fal 配音返回了不受信任的文件地址')
    response = requests.get(url, timeout=(15, 120), allow_redirects=False)
    if response.status_code != 200 or len(response.content) > 32 * 1024 * 1024:
        raise RuntimeError('fal 配音文件下载暂不可用，可继续原任务重试')
    temporary = target.with_suffix(target.suffix + '.part')
    temporary.write_bytes(response.content)
    temporary.replace(target)


def queued(model, payload, folder, identity, suffix, log):
    digest = hashlib.sha256((model + '\n' + identity).encode()).hexdigest()[:24]
    record, artifact = folder / (digest + '.json'), folder / (digest + suffix)
    job = json.loads(record.read_text(encoding='utf-8')) if record.exists() else {}
    if job.get('state') == 'SUCCESS' and artifact.is_file():
        if suffix == '.wav':
            media.duration(artifact)
        log('复用已完成配音，不重复生成' if suffix == '.wav' else '复用已保存音色')
        return artifact
    if job.get('state') == 'FAILED':
        job = {'attempts': job.get('attempts', 0) + 1}
    # Preserve the original signed reference URL when recovering a lost reply.
    payload = job.get('request', payload)
    call_key = f'fal:{digest}:{job.get("attempts", 0)}'
    endpoint = 'https://queue.fal.run/' + model
    deadline = time.monotonic() + 900
    while time.monotonic() < deadline:
        if job.get('result') is None:
            metered = metering_enabled()
            if not job.get('task_id') and job.get('submission') == 'uncertain' and not metered:
                raise RuntimeError('fal 配音提交结果不确定，未重复提交；请核对服务商记录')
            job.update(provider='fal', request=payload, submission='uncertain' if not job.get('task_id') else 'submitted')
            write_json(record, job)
            try:
                data = paid_post(endpoint, payload, call_key=call_key)
                if data is None:
                    if not job.get('task_id'):
                        response = requests.post(endpoint, headers=headers(), json=payload, timeout=(15, 90), allow_redirects=False)
                        if 400 <= response.status_code < 500:
                            job['submission'] = 'rejected'
                            write_json(record, job)
                        response.raise_for_status()
                        submitted = response.json()
                        ident = submitted.get('request_id', '')
                        if not re.fullmatch(r'[a-f0-9-]{36}', ident):
                            raise ValueError('fal 未返回有效任务 ID，未重复提交')
                        job.update(task_id=ident, submission='submitted', state='PENDING')
                        write_json(record, job)
                    base = 'https://queue.fal.run/fal-ai/qwen-3-tts/requests/' + job['task_id']
                    response = requests.get(base + '/status', headers=headers(), timeout=(15, 60), allow_redirects=False)
                    response.raise_for_status()
                    data = response.json()
                    if data.get('status') == 'COMPLETED':
                        response = requests.get(base, headers=headers(), timeout=(15, 60), allow_redirects=False)
                        data.update(result=response.json(), result_status=response.status_code)
                if data.get('request_id'):
                    job.update(task_id=data['request_id'], submission='submitted', state='PENDING')
                if data.get('status') == 'COMPLETED' and 'result' in data:
                    if data.get('result_status', 200) >= 400:
                        job.update(state='FAILED', result=data['result'])
                        write_json(record, job)
                        raise RuntimeError('fal 配音任务失败，可继续原任务重试本段')
                    job['result'] = data['result']
                write_json(record, job)
            except CreditError as exc:
                if exc.code == 'MIX_PROVIDER_REJECTED':
                    job['submission'] = 'rejected'
                    write_json(record, job)
                raise
            except requests.RequestException as exc:
                raise RuntimeError('fal 配音连接中断，已保存原任务：' + clean_error(exc)) from None
        if job.get('result') is not None:
            key = 'speaker_embedding' if suffix == '.safetensors' else 'audio'
            download(job['result'].get(key, {}).get('url'), artifact)
            if suffix == '.wav':
                media.duration(artifact)
            job.update(state='SUCCESS', artifact=artifact.name)
            write_json(record, job)
            return artifact
        log('fal 配音任务处理中，正在查询同一任务')
        time.sleep(5)
    raise TimeoutError('fal 配音等待超过 15 分钟，继续任务会查询原请求')


def synthesize_plan(plan, output, voice='Vivian', speaker_file=None, log=print):
    if voice not in VOICES:
        raise ValueError('服务器 MIX_FAL_VOICE 音色无效')
    output = Path(output).resolve()
    cache = output / 'voice-cache'
    cache.mkdir(parents=True, exist_ok=True)
    embedding = None
    if speaker_file:
        source = Path(speaker_file)
        source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
        reference = cache / ('reference-' + source_hash[:16] + '.wav')
        if not reference.is_file():
            media.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', str(source),
                       '-t', '15', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', str(reference)])
        # Small 15s references and embeddings can be sent inline. No second
        # provider upload, public permanent URL, or expiring signature is needed.
        audio_url = 'data:audio/wav;base64,' + base64.b64encode(reference.read_bytes()).decode()
        embedding = queued(CLONE_MODEL, {'audio_url': audio_url}, cache, source_hash, '.safetensors', log)
    speaker = ('data:application/octet-stream;base64,' + base64.b64encode(embedding.read_bytes()).decode()) if embedding else None
    fps, cursor, names = plan['fps'], 0, []
    for i, scene in enumerate(plan['scenes']):
        text = scene['text']
        if not text.strip() or len(text) > 2048:
            raise ValueError('单段配音文本须为 1–2048 字符')
        payload = {'text': text, 'voice': voice, 'language': 'Chinese', 'max_new_tokens': 4096}
        if speaker:
            payload['speaker_voice_embedding_file_url'] = speaker
        identity = json.dumps(payload, sort_keys=True)
        log(f'生成 fal 配音 {i+1}/{len(plan["scenes"])}')
        audio = queued(TTS_MODEL, payload, cache, identity, '.wav', log)
        seconds = media.duration(audio)
        frames = math.ceil(seconds * fps)
        aligned = output / f'voice-{i+1:03}.wav'
        media.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', str(audio),
                   '-af', f'apad,atrim=duration={frames/fps}', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', str(aligned)])
        scene.update(start=cursor/fps, end=(cursor+frames)/fps, timing='tts-segment', voice=str(aligned), voice_duration=seconds)
        cursor += frames
        names.append(aligned.name)
        write_json(output / 'plan.json', plan)
    (output / 'voice-concat.txt').write_text(''.join(f"file '{name}'\n" for name in names), encoding='utf-8')
    media.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'concat', '-safe', '1',
               '-i', 'voice-concat.txt', '-c:a', 'pcm_s16le', 'narration.wav'], cwd=output)
    plan.update(timing='tts-segment', narration=str(output / 'narration.wav'), voice_settings={
        'provider': 'fal', 'model': TTS_MODEL, 'voice': voice, 'cloned': bool(embedding),
        'alignment': 'scene boundaries, not word timestamps'})
    write_json(output / 'plan.json', plan)
    media.write_srt(plan['scenes'], output / 'captions.srt')
    return plan
