"""Provider adapters. Credentials come only from the process environment."""
import base64
import json
import os
import re
import time
from pathlib import Path

import numpy as np
import requests

EMBED_URL = 'https://api.openlux.ai/v1beta/models/gemini-embedding-2-preview:generateContent'
LLM_URL = 'https://api.openlux.ai/v1beta/models/gemini-3.7-flash:generateContent'
RERANK_URL = 'https://api.302.ai/v1/reranks'


def clean_error(value):
    text = str(value)
    for name in ('OPENLUX_API_KEY', 'RERANK_API_KEY', 'TTS_API_KEY', 'SUNO_API_KEY', 'MINIMAX_API_KEY',
                 'COS_SECRET_ID', 'COS_SECRET_KEY', 'MIX_AUDIO_COS_SECRET_ID', 'MIX_AUDIO_COS_SECRET_KEY',
                 'INDEXTTS_302_API_KEY', 'MIXER_API_TOKEN'):
        if os.environ.get(name):
            text = text.replace(os.environ[name], '[REDACTED]')
    return re.sub(r'sk-[A-Za-z0-9_-]+', '[REDACTED]', text)[:1000]


def video_part(path):
    data = Path(path).read_bytes()
    if len(data) > 12 * 1024 * 1024:
        raise ValueError('代理视频超过 12 MB；缩短分段后重试')
    return {'inlineData': {'mimeType': 'video/mp4', 'data': base64.b64encode(data).decode('ascii')}}


def unit_vector(values):
    v = np.asarray(values, dtype=np.float32)
    if v.ndim != 1 or not len(v) or not np.isfinite(v).all() or np.linalg.norm(v) == 0:
        raise ValueError('embedding 必须返回非空、有限、非零的一维数值向量')
    return v / np.linalg.norm(v)


class Models:
    def __init__(self):
        self.embed_url = os.environ.get('EMBEDDING_URL') or EMBED_URL
        self.llm_url = os.environ.get('LLM_URL') or LLM_URL
        self.rerank_url = os.environ.get('RERANK_URL') or RERANK_URL
        self.session = requests.Session()

    def post(self, url, key_name, payload):
        key = os.environ.get(key_name)
        if not key:
            raise ValueError(f'请先设置进程环境变量 {key_name}，不要写入技能文件')
        for attempt in range(3):
            try:
                r = self.session.post(url, headers={'Authorization': f'Bearer {key}'},
                                      json=payload, timeout=(15, 180), allow_redirects=False)
            except requests.RequestException as exc:
                if attempt < 2:
                    time.sleep(2 ** (attempt + 1))
                    continue
                raise RuntimeError(clean_error(exc)) from None
            if (r.status_code == 429 or r.status_code >= 500) and attempt < 2:
                time.sleep(2 ** (attempt + 1))
                continue
            if not 200 <= r.status_code < 300:
                raise RuntimeError(f'HTTP {r.status_code}: {clean_error(r.text)}')
            try:
                return r.json()
            except ValueError:
                raise ValueError('接口没有返回 JSON') from None

    def embed(self, *, text=None, video=None):
        if (text is None) == (video is None):
            raise ValueError('embedding 需要且只能提供 text 或 video')
        parts = [{'text': text}] if text is not None else [video_part(video)]
        # Live-tested OpenLux route requires singular content for video inputs,
        # even though its URL ends in generateContent. contents loses the video.
        if video is not None:
            inline = parts[0]['inlineData']
            parts = [{'inline_data': {'mime_type': inline['mimeType'], 'data': inline['data']}}]
        payload = {'content': {'parts': parts}}
        data = self.post(self.embed_url, 'OPENLUX_API_KEY', payload)
        return unit_vector(data.get('embedding', {}).get('values', []))

    def json(self, prompt, videos=()):
        parts = [{'text': prompt}]
        for label, path in videos:
            parts.extend([{'text': f'候选片段 ID={label}'}, video_part(path)])
        data = self.post(self.llm_url, 'OPENLUX_API_KEY', {
            'contents': [{'role': 'user', 'parts': parts}],
            'generationConfig': {'responseMimeType': 'application/json', 'maxOutputTokens': 8192}})
        candidates = data.get('candidates', [])
        if not candidates or candidates[0].get('finishReason') not in ('STOP', None):
            raise ValueError('模型输出被截断或拦截，不能作为有效结果')
        text = ''.join(p.get('text', '') for p in candidates[0].get('content', {}).get('parts', [])
                       if not p.get('thought'))
        text = re.sub(r'^```(?:json)?\s*|\s*```$', '', text.strip())
        try:
            return json.loads(text)
        except ValueError:
            raise ValueError('模型没有返回可解析的 JSON') from None

    def rerank(self, query, candidates):
        if not candidates:
            return []
        data = self.post(self.rerank_url, 'RERANK_API_KEY', {
            'model': 'qwen3-rerank', 'query': query,
            'documents': [c['description'] for c in candidates],
            'top_n': min(10, len(candidates)),
            'instruct': 'Find video descriptions whose visible subjects, setting and actions match the query.'})
        results = data.get('results', [])
        if not results:
            raise ValueError('rerank 未返回排序结果')
        seen, ranked = set(), []
        for r in sorted(results, key=lambda r: float(r['relevance_score']), reverse=True):
            i, score = r['index'], float(r['relevance_score'])
            if not isinstance(i, int) or i < 0 or i >= len(candidates) or i in seen or not np.isfinite(score):
                raise ValueError('rerank 返回非法候选索引或分数')
            seen.add(i)
            ranked.append({**candidates[i], 'rerank_score': score})
        return ranked
